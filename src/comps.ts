import type { Comparable } from "./types";

/** A comp is used in the statistics only if it is at least this likely to be the same item. */
export const MIN_MATCH_SCORE = 0.6;
/** Sold comps older than this are ignored when enough newer ones exist. */
export const SOLD_WINDOW_DAYS = 180;

export type PriceStats = {
  count: number;
  medianCents: number;
  lowCents: number;
  highCents: number;
  /** Comps removed as outliers (Tukey fences) or as poor matches. */
  excluded: number;
};

export type CompStats = {
  sold: PriceStats | null;
  active: PriceStats | null;
  retail: PriceStats | null;
  confidence: "high" | "medium" | "low" | "none";
};

export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) throw new Error("percentile of an empty list");
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return Math.round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower));
}

/** Median and range after removing outliers with Tukey fences (1.5 × IQR) when there are 4 or more prices. */
export function priceStats(prices: number[], alreadyExcluded = 0): PriceStats | null {
  const sorted = [...prices].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  let kept = sorted;
  if (sorted.length >= 4) {
    const q1 = percentile(sorted, 0.25);
    const q3 = percentile(sorted, 0.75);
    const fence = (q3 - q1) * 1.5;
    kept = sorted.filter((price) => price >= q1 - fence && price <= q3 + fence);
  }
  return {
    count: kept.length,
    medianCents: percentile(kept, 0.5),
    lowCents: kept[0]!,
    highCents: kept[kept.length - 1]!,
    excluded: alreadyExcluded + sorted.length - kept.length,
  };
}

function usable(comp: Comparable, currency: string): comp is Comparable & { priceCents: number } {
  return comp.priceCents !== null && comp.priceCents > 0 && comp.currency === currency;
}

/**
 * Computes comp statistics in code, so the numbers are reproducible and the model only finds evidence.
 * Comps must already be converted to `currency`; others are ignored.
 */
export function compStats(comps: Comparable[], currency: string, now = Date.now()): CompStats {
  const byType = (type: Comparable["type"]) => {
    const ofType = comps.filter((comp) => comp.type === type && usable(comp, currency));
    const matched = ofType.filter((comp) => (comp.matchScore ?? 1) >= MIN_MATCH_SCORE);
    return { matched, poorMatches: ofType.length - matched.length };
  };

  const sold = byType("sold");
  const recentCutoff = now - SOLD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentSold = sold.matched.filter((comp) => !comp.soldAt || Date.parse(comp.soldAt) >= recentCutoff);
  // Prefer recent sales, but keep older ones when they are all the evidence there is.
  const soldUsed = recentSold.length >= 3 ? recentSold : sold.matched;
  const soldStats = priceStats(
    soldUsed.map((comp) => comp.priceCents!),
    sold.poorMatches + sold.matched.length - soldUsed.length,
  );
  const active = byType("active");
  const activeStats = priceStats(active.matched.map((comp) => comp.priceCents!), active.poorMatches);
  const retail = byType("retail");
  const retailStats = priceStats(retail.matched.map((comp) => comp.priceCents!), retail.poorMatches);

  const soldCount = soldStats?.count ?? 0;
  const activeCount = activeStats?.count ?? 0;
  const confidence = soldCount >= 5 ? "high" : soldCount >= 2 || activeCount >= 5 ? "medium" : soldCount + activeCount > 0 ? "low" : "none";

  return { sold: soldStats, active: activeStats, retail: retailStats, confidence };
}
