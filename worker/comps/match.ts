import type { Comparable } from "../../src/types";
import { normalizeFingerprint } from "../normalize";
import type { ItemQuery } from "./types";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_TIMEOUT_MS = 4_000;
const JEV_BATCH_SIZE = 60;
/** Ceiling for a comp whose title misses the item's brand or model entirely. */
const MISSING_IDENTITY_CAP = 0.4;
/** These sources come from an exact product lookup rather than a keyword search. */
const EXACT_LOOKUP_SOURCES = new Set(["pricecharting", "discogs"]);
const EXACT_LOOKUP_SCORE = 0.9;

export type MatchItem = ItemQuery & { description: string };

function tokens(value: string | null): string[] {
  if (!value) return [];
  return normalizeFingerprint(value)
    .split(" ")
    .filter((token) => token.length >= 2);
}

/** Share of the item's brand, model, and name tokens that appear in the comp title. */
export function similarityScore(item: Pick<ItemQuery, "brand" | "model" | "name">, title: string): number {
  const itemTokens = new Set(tokens([item.brand, item.model, item.name].filter(Boolean).join(" ")));
  if (itemTokens.size === 0) return 0;
  const titleTokens = new Set(tokens(title));
  const modelTokens = tokens(item.model);
  // "DMG-01" is often written "DMG01", so the joined model counts as all of its tokens.
  const joinedModelFound = modelTokens.length > 1 && titleTokens.has(modelTokens.join(""));
  const found = (token: string) => titleTokens.has(token) || (joinedModelFound && modelTokens.includes(token));

  let score = [...itemTokens].filter(found).length / itemTokens.size;

  const brandTokens = tokens(item.brand);
  if (brandTokens.length > 0 && !brandTokens.some(found)) score = Math.min(score, MISSING_IDENTITY_CAP);
  if (modelTokens.length > 0 && !modelTokens.some(found)) score = Math.min(score, MISSING_IDENTITY_CAP);

  return score;
}

type JevNoulAnswer = { noul?: number };

async function askJev(item: MatchItem, comps: Comparable[], apiKey: string): Promise<number[]> {
  const questions = Object.fromEntries(
    comps.map((_, index) => [
      `match_${index}`,
      {
        type: "noul",
        instructions: `Is \`comps[${index}]\` the same product as \`item\` (same brand, model, and edition, not an accessory, part, lot, or different item), in a broadly comparable condition?`,
        criteria: {
          true: "Same product, comparable condition",
          false: "Different product, accessory, lot, or very different condition",
        },
      },
    ]),
  );

  const response = await fetch(JEV_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "jev-latest",
      state: {
        item: {
          name: item.name,
          brand: item.brand,
          model: item.model,
          category: item.category,
          goods_type: item.goodsType,
          condition: item.condition,
          description: item.description,
          barcode: item.barcode,
        },
        comps: comps.map((comp) => ({
          title: comp.title,
          condition: comp.condition ?? null,
          price_cents: comp.priceCents,
          currency: comp.currency,
          source: comp.source ?? null,
        })),
      },
      questions,
    }),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Jev match failed with status ${response.status}`);
  const body = (await response.json()) as { answers?: Record<string, JevNoulAnswer> };
  return comps.map((_, index) => {
    const probability = body.answers?.[`match_${index}`]?.noul;
    if (typeof probability !== "number" || !Number.isFinite(probability)) {
      throw new Error(`Jev match answer match_${index} missing`);
    }
    return Math.min(1, Math.max(0, probability));
  });
}

/** One 0–1 probability per comp, in order, that it is the same item in a comparable condition. */
export async function scoreComps(
  item: MatchItem,
  comps: Comparable[],
  jevApiKey: string | undefined,
): Promise<{ scores: number[]; source: "jev" | "similarity" }> {
  if (jevApiKey && comps.length > 0) {
    try {
      const batches: Comparable[][] = [];
      for (let start = 0; start < comps.length; start += JEV_BATCH_SIZE) {
        batches.push(comps.slice(start, start + JEV_BATCH_SIZE));
      }
      const results = await Promise.all(batches.map((batch) => askJev(item, batch, jevApiKey)));
      return { scores: results.flat(), source: "jev" };
    } catch {
      // Fall through: a similarity score is better than no score.
    }
  }
  return {
    scores: comps.map((comp) =>
      EXACT_LOOKUP_SOURCES.has(comp.source ?? "") ? EXACT_LOOKUP_SCORE : similarityScore(item, comp.title),
    ),
    source: "similarity",
  };
}
