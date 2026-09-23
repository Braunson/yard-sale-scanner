import type { PricingPath, PricingStatus } from "../src/types";

/** A previously researched item is re-used for this long instead of paying for new web searches. */
export const RESEARCH_REUSE_MS = 14 * 24 * 60 * 60 * 1000;

/** Research that has not finished after this long was cut off, for example when the Worker stopped. */
export const RESEARCH_TIMEOUT_MS = 10 * 60 * 1000;

export function isResearchStale(researchStartedAt: string | null, now: string): boolean {
  return researchStartedAt === null || Date.parse(now) - Date.parse(researchStartedAt) > RESEARCH_TIMEOUT_MS;
}

/**
 * Keeps earlier research when it is fresh, when the new triage would only give a quick guess, or
 * when another frame is researching this item right now.
 */
export function keepsExistingPricing(
  row: { pricingStatus: PricingStatus; researchedAt: string | null; researchStartedAt: string | null },
  decision: { path: PricingPath },
  capturedAt: string,
): boolean {
  if (row.pricingStatus === "researching") return !isResearchStale(row.researchStartedAt, capturedAt);
  if (row.pricingStatus !== "priced" || row.researchedAt === null) return false;
  const researchAgeMs = Date.parse(capturedAt) - Date.parse(row.researchedAt);
  return researchAgeMs < RESEARCH_REUSE_MS || decision.path === "instant";
}
