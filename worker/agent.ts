import { Agent, OpenAIProvider, Runner, tool, webSearchTool } from "@openai/agents";
import { desc, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import { items } from "./db/schema";
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

type AgentDb = DrizzleD1Database<Record<string, never>>;

export async function analyzeFrame(options: {
  apiKey: string;
  model: string;
  imageDataUrl: string;
  db: AgentDb;
  sessionId: string;
}): Promise<{ analysis: FrameAnalysis; modelCalls: number; searchesPerformed: number }> {
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
    instructions: `You inspect a single frame from a thrift-store or garage-sale scan.

Identify every distinct sellable object that is meaningfully visible. Do not invent details hidden by the frame. Read price tags when possible. For each item:
1. Return one tight bounding box around the entire item. Use normalized integer coordinates from 0 to 1000, with (0, 0) at the frame's top-left and (1000, 1000) at its bottom-right. Ensure xMin < xMax and yMin < yMax.
2. Produce a stable lowercase semantic fingerprint using brand, model, and generic item identity. Exclude price, condition, color, and session-specific details.
3. Call check_previous_scans for the fingerprint before finalizing.
4. Use web search when the identity is specific enough to find useful market evidence. Seek all three when possible: current retail, active listings, and recent sold comparables. Never imply an active asking price is a completed sale.
5. Return integer prices in cents. Use null when evidence is insufficient. Include concise source titles and URLs in comparables.
6. Estimate a conservative resale range that reflects the visible condition and uncertainty.

Return an empty items array if no sellable object can be identified. Currency defaults to USD unless a visible tag or source clearly indicates otherwise.`,
    tools: [
      checkPreviousScans,
      webSearchTool({ searchContextSize: "low", externalWebAccess: true }),
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
            text: "Analyze this frame. Find and value every distinct sellable item you can identify.",
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
      item.rawItem.type === "hosted_tool_call" &&
      item.rawItem.name.startsWith("web_search"),
  ).length;

  return {
    analysis: result.finalOutput,
    modelCalls: result.runContext.usage.requests,
    searchesPerformed,
  };
}
