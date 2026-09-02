import { Agent, OpenAIProvider, Runner, tool, webSearchTool } from "@openai/agents";
import { desc, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import { items } from "./db/schema";
import { createEbayTools, type EbayCredentials } from "./ebay";
import { normalizeFingerprint } from "./normalize";

const comparableSchema = z.object({
  title: z.string(),
  url: z.string().nullable(),
  priceCents: z.number().int().nonnegative().nullable(),
  currency: z.string(),
  type: z.enum(["retail", "active", "sold"]),
});

const boundingBoxSchema = z.object({
  xMin: z.number().int().min(0).max(1000),
  yMin: z.number().int().min(0).max(1000),
  xMax: z.number().int().min(0).max(1000),
  yMax: z.number().int().min(0).max(1000),
});

const detectedItemSchema = z.object({
  fingerprint: z.string().describe("Stable lowercase identity: brand + model + item name; no condition or price."),
  name: z.string(),
  category: z.string(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  description: z.string(),
  condition: z.string(),
  confidence: z.number().min(0).max(1),
  boundingBox: boundingBoxSchema.describe(
    "Tight item bounds in normalized 0-1000 coordinates, measured from the frame's top-left corner.",
  ),
  observedPriceCents: z.number().int().nonnegative().nullable(),
  currency: z.string(),
  estimatedLowCents: z.number().int().nonnegative().nullable(),
  estimatedHighCents: z.number().int().nonnegative().nullable(),
  retailPriceCents: z.number().int().nonnegative().nullable(),
  activePriceCents: z.number().int().nonnegative().nullable(),
  soldPriceCents: z.number().int().nonnegative().nullable(),
  valueSummary: z.string(),
  previousMatchId: z.string().nullable(),
  comparables: z.array(comparableSchema).max(8),
});

const frameAnalysisSchema = z.object({
  items: z.array(detectedItemSchema).max(20),
});

export type FrameAnalysis = z.infer<typeof frameAnalysisSchema>;

export type AgentRunAudit = {
  instructions: string;
  input: unknown;
  events: Array<{ sequence: number; type: string; title: string; data: unknown }>;
  rawResponses: unknown[];
  output: unknown;
  usage: unknown;
};

type AgentDb = DrizzleD1Database<Record<string, never>>;

export const AGENT_INPUT_TEXT = "Analyze this frame. Return and value only clearly identifiable items that are likely being offered for sale.";

export const AGENT_INSTRUCTIONS = `You inspect a single frame from a thrift-store or garage-sale scan.

Your goal is a high-precision shortlist of likely merchandise, not an exhaustive inventory of everything visible. When uncertain, omit the object rather than guess.

Only return an object when both are true:
- The scene provides evidence that it is merchandise being offered for sale, such as placement with other sale items, display on a sale table or rack, or a visible price tag.
- It is visible clearly enough to identify at a useful, searchable level with confidence of at least 0.70. A useful identity may be a specific product or a meaningful category such as “vintage ceramic table lamp,” but not “unknown object,” “clothing,” or another vague label.

Never return:
- People, body parts, or clothing, shoes, jewelry, accessories, bags, or other possessions currently worn or carried by a person.
- Objects merely held or actively used by a person, unless the person is unmistakably presenting that object as merchandise for sale.
- Tables, shelving, bins, racks, signs, vehicles, buildings, or other scene fixtures unless that exact object is clearly tagged or displayed for sale.
- Background decor, partial objects at the frame edge, heavily occluded items, or small and blurry objects whose identity would require guessing.
- Separate components or details of an item when they belong to one larger sellable object.

Apply these inclusion rules before calling tools or searching the web. Do not invent details hidden by the frame. Read price tags when possible. For each included item:
1. Return one tight bounding box around the entire item. Use normalized integer coordinates from 0 to 1000, with (0, 0) at the frame's top-left and (1000, 1000) at its bottom-right. Ensure xMin < xMax and yMin < yMax.
2. Produce a stable lowercase semantic fingerprint using brand, model, and generic item identity. Exclude price, condition, color, and session-specific details.
3. Call check_previous_scans for the fingerprint before finalizing.
4. Use search_ebay_active_listings for eBay active-listing comparables whenever the identity is specific enough to search. Use web search for current retail prices and any recent sold evidence. An active eBay asking price is never a completed sale.
5. Return integer prices in cents. Use null when evidence is insufficient. Include concise source titles and URLs in comparables. eBay comparables must be type "active".
6. Estimate a conservative resale range that reflects the visible condition and uncertainty.

Return an empty items array when no object passes every inclusion rule. Currency defaults to USD unless a visible tag or source clearly indicates otherwise.`;

export async function analyzeFrame(options: {
  apiKey: string;
  model: string;
  imageDataUrl: string;
  db: AgentDb;
  sessionId: string;
  ebayCredentials?: EbayCredentials;
}): Promise<{ analysis: FrameAnalysis; modelCalls: number; searchesPerformed: number; audit: AgentRunAudit }> {
  const checkPreviousScans = tool({
    name: "check_previous_scans",
    description:
      "Check semantic item fingerprints against the active session and all saved history. Call this for every identified item before finalizing output.",
    parameters: z.object({
      fingerprints: z.array(z.string()).min(1).max(20),
    }),
    execute: async ({ fingerprints }) => {
      const normalized = fingerprints.map(normalizeFingerprint);
      const matches = await options.db
        .select({
          id: items.id,
          fingerprint: items.fingerprint,
          name: items.name,
          scanSessionId: items.scanSessionId,
          lastSeenAt: items.lastSeenAt,
          seenCount: items.seenCount,
        })
        .from(items)
        .where(inArray(items.fingerprint, normalized))
        .orderBy(desc(items.lastSeenAt))
        .limit(40);

      return {
        activeSessionId: options.sessionId,
        matches,
      };
    },
  });

  const agent = new Agent({
    name: "Yard Sale Gold Scout",
    model: options.model,
    instructions: AGENT_INSTRUCTIONS,
    tools: [
      checkPreviousScans,
      webSearchTool({ searchContextSize: "low", externalWebAccess: true }),
      ...createEbayTools(options.ebayCredentials),
    ],
    outputType: frameAnalysisSchema,
  });

  const provider = new OpenAIProvider({ apiKey: options.apiKey });
  const runner = new Runner({ modelProvider: provider });
  const result = await runner.run(
    agent,
    [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: AGENT_INPUT_TEXT,
          },
          { type: "input_image", image: options.imageDataUrl, detail: "high" },
        ],
      },
    ],
  ).finally(() => provider.close());

  if (!result.finalOutput) {
    throw new Error("Luna completed without structured output.");
  }

  const searchesPerformed = result.newItems.filter(
    (item) =>
      item.type === "tool_call_item" &&
      ((item.rawItem.type === "function_call" && item.rawItem.name === "search_ebay_active_listings") ||
        (item.rawItem.type === "hosted_tool_call" && item.rawItem.name.startsWith("web_search"))),
  ).length;

  return {
    analysis: result.finalOutput,
    modelCalls: result.runContext.usage.requests,
    searchesPerformed,
    audit: {
      instructions: AGENT_INSTRUCTIONS,
      input: {
        role: "user",
        content: [
          { type: "input_text", text: AGENT_INPUT_TEXT },
          { type: "input_image", image: "[frame stored in R2]", detail: "high" },
        ],
      },
      events: result.newItems.map((item, sequence) => {
        const data = safeAuditValue(item.toJSON());
        return { sequence, type: item.type, title: runItemTitle(item.type, data), data };
      }),
      rawResponses: result.rawResponses.map(safeAuditValue),
      output: safeAuditValue(result.finalOutput),
      usage: safeAuditValue(result.runContext.usage),
    },
  };
}

function safeAuditValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (key, nestedValue: unknown) => {
    if (/api[_-]?key|authorization/i.test(key)) return "[redacted]";
    if (key === "encrypted_content" || key === "rawContent") return undefined;
    if (typeof nestedValue === "string" && nestedValue.startsWith("data:image/")) {
      return "[frame stored in R2]";
    }
    if (typeof nestedValue === "object" && nestedValue !== null) {
      if (seen.has(nestedValue)) return "[circular]";
      seen.add(nestedValue);
    }
    return nestedValue;
  });
  return serialized === undefined ? null : JSON.parse(serialized);
}

function runItemTitle(type: string, data: unknown): string {
  const rawItem = isRecord(data) && isRecord(data.rawItem) ? data.rawItem : null;
  const toolName = rawItem && typeof rawItem.name === "string" ? rawItem.name : null;
  if (toolName?.startsWith("web_search")) return "Web search";
  if (type === "tool_call_item") return toolName ? `Tool call · ${toolName}` : "Tool call";
  if (type === "tool_call_output_item") return "Tool result";
  if (type === "reasoning_item") return "Reasoning summary";
  if (type === "message_output_item") return "Assistant response";
  return type.replaceAll("_", " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
