import type { PricingPath, TriageSource } from "../src/types";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_TIMEOUT_MS = 4_000;
/** Jev must be at least this sure before an item skips web research. */
export const INSTANT_PROBABILITY_THRESHOLD = 0.7;
/** Anything that might be worth this much always gets researched, whatever the triage says. */
export const ALWAYS_RESEARCH_CENTS = 5_000;

export type TriageCandidate = {
  name: string;
  category: string;
  brand: string | null;
  model: string | null;
  description: string;
  condition: string;
  observedPriceCents: number | null;
  quickLowCents: number | null;
  quickHighCents: number | null;
  pricingHint: PricingPath;
  researchReason: string;
};

export type TriageDecision = {
  path: PricingPath;
  source: TriageSource;
  /** Probability that the chosen path is correct, when the source reports one. */
  confidence: number | null;
};

type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type TriageRun = {
  decisions: TriageDecision[];
  jevLatencyMs: number | null;
  jevError: string | null;
};

/**
 * Decides per item whether Luna's quick estimate is good enough or the item needs web research.
 * Jev (TypeSafe) is used when a key is configured because it returns calibrated probabilities in
 * well under a second; otherwise Luna's own hint from the identification pass is used.
 */
export async function triageItems(
  candidates: TriageCandidate[],
  options: { apiKey: string | undefined; mode: string | undefined },
): Promise<TriageRun> {
  if (candidates.length === 0) return { decisions: [], jevLatencyMs: null, jevError: null };
  // PRICING_TRIAGE=research_all restores the original behaviour: every item gets web research.
  if (options.mode === "research_all") {
    return {
      decisions: candidates.map(() => ({ path: "research", source: "config", confidence: null })),
      jevLatencyMs: null,
      jevError: null,
    };
  }
  const { apiKey } = options;
  if (!apiKey) {
    return { decisions: candidates.map((candidate) => decidePath(candidate, null)), jevLatencyMs: null, jevError: null };
  }

  const started = Date.now();
  try {
    const answers = await askJev(candidates, apiKey);
    return {
      decisions: candidates.map((candidate, index) => decidePath(candidate, answers[`path_${index}`] ?? null)),
      jevLatencyMs: Date.now() - started,
      jevError: null,
    };
  } catch (error) {
    return {
      decisions: candidates.map((candidate) => decidePath(candidate, null)),
      jevLatencyMs: Date.now() - started,
      jevError: error instanceof Error ? error.message : "Jev triage failed",
    };
  }
}

export function decidePath(candidate: TriageCandidate, jevAnswer: JevChoiceAnswer | null): TriageDecision {
  const mightBeValuable = (candidate.quickHighCents ?? 0) >= ALWAYS_RESEARCH_CENTS;

  if (jevAnswer?.type === "choice") {
    const instantProbability = jevAnswer.probabilities.instant ?? 0;
    // The value rule overrides Jev, so Jev's probability says nothing about that decision.
    if (mightBeValuable) return { path: "research", source: "jev", confidence: null };
    const path: PricingPath = instantProbability >= INSTANT_PROBABILITY_THRESHOLD ? "instant" : "research";
    return { path, source: "jev", confidence: path === "instant" ? instantProbability : 1 - instantProbability };
  }

  const path: PricingPath = !mightBeValuable && candidate.pricingHint === "instant" ? "instant" : "research";
  return { path, source: "luna", confidence: null };
}

async function askJev(candidates: TriageCandidate[], apiKey: string): Promise<Record<string, JevChoiceAnswer>> {
  const questions = Object.fromEntries(
    candidates.map((_, index) => [
      `path_${index}`,
      {
        type: "choice",
        instructions: `Can the second-hand item \`items[${index}]\` be priced confidently right now from general knowledge, or does it need web and marketplace research before a reseller decides?`,
        criteria: {
          instant:
            "Generic or common household goods with a well-known, low second-hand price. A wrong guess would cost the reseller little.",
          research:
            "A specific brand or model, collectible, vintage, designer, electronic, or otherwise variable item whose value depends on exact identity, or whose tag price may be far below its value.",
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
        items: candidates.map((candidate) => ({
          name: candidate.name,
          category: candidate.category,
          brand: candidate.brand,
          model: candidate.model,
          description: candidate.description,
          condition: candidate.condition,
          tag_price_cents: candidate.observedPriceCents,
          quick_estimate_cents: { low: candidate.quickLowCents, high: candidate.quickHighCents },
        })),
      },
      questions,
    }),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Jev triage failed with status ${response.status}`);
  const body = (await response.json()) as { answers?: Record<string, JevChoiceAnswer> };
  return body.answers ?? {};
}
