import { describe, expect, it } from "vitest";
import { isResearchStale, keepsExistingPricing } from "./research";

const now = "2026-09-23T12:00:00.000Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();
const daysAgo = (days: number) => minutesAgo(days * 24 * 60);

describe("isResearchStale", () => {
  it("treats research as cut off after 10 minutes or with no start time", () => {
    expect(isResearchStale(minutesAgo(5), now)).toBe(false);
    expect(isResearchStale(minutesAgo(11), now)).toBe(true);
    expect(isResearchStale(null, now)).toBe(true);
  });
});

describe("keepsExistingPricing", () => {
  const research = { path: "research" as const };
  const instant = { path: "instant" as const };

  it("does not start a second research run while one is in progress", () => {
    expect(keepsExistingPricing({ pricingStatus: "researching", researchedAt: null, researchStartedAt: minutesAgo(2) }, research, now)).toBe(true);
    expect(keepsExistingPricing({ pricingStatus: "researching", researchedAt: null, researchStartedAt: minutesAgo(20) }, research, now)).toBe(false);
  });

  it("reuses fresh research, and old research when the new triage is only a quick guess", () => {
    expect(keepsExistingPricing({ pricingStatus: "priced", researchedAt: daysAgo(3), researchStartedAt: null }, research, now)).toBe(true);
    expect(keepsExistingPricing({ pricingStatus: "priced", researchedAt: daysAgo(30), researchStartedAt: null }, research, now)).toBe(false);
    expect(keepsExistingPricing({ pricingStatus: "priced", researchedAt: daysAgo(30), researchStartedAt: null }, instant, now)).toBe(true);
  });

  it("reprices quick estimates and failed research", () => {
    expect(keepsExistingPricing({ pricingStatus: "priced", researchedAt: null, researchStartedAt: null }, instant, now)).toBe(false);
    expect(keepsExistingPricing({ pricingStatus: "research_failed", researchedAt: null, researchStartedAt: minutesAgo(30) }, research, now)).toBe(false);
  });
});
