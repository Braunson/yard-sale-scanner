import { describe, expect, it } from "vitest";
import { compStats, percentile, priceStats } from "./comps";
import type { Comparable } from "./types";

const comp = (priceCents: number, type: Comparable["type"] = "sold", extra: Partial<Comparable> = {}): Comparable => ({
  title: "Sony Walkman WM-FX195",
  url: null,
  priceCents,
  currency: "USD",
  type,
  matchScore: 0.9,
  ...extra,
});

describe("percentile", () => {
  it("interpolates between neighbours", () => {
    expect(percentile([100, 200, 300, 400], 0.5)).toBe(250);
    expect(percentile([100], 0.9)).toBe(100);
  });
});

describe("priceStats", () => {
  it("removes an outlier with Tukey fences", () => {
    const stats = priceStats([2_000, 2_200, 2_400, 2_500, 2_600, 25_000]);
    expect(stats).toMatchObject({ count: 5, medianCents: 2_400, lowCents: 2_000, highCents: 2_600, excluded: 1 });
  });

  it("keeps small samples as they are", () => {
    expect(priceStats([500, 90_000])).toMatchObject({ count: 2, medianCents: 45_250 });
    expect(priceStats([])).toBeNull();
  });
});

describe("compStats", () => {
  const now = Date.parse("2026-09-23T00:00:00Z");

  it("ignores poor matches, other currencies, and missing prices", () => {
    const stats = compStats([
      comp(3_000),
      comp(3_200),
      comp(9_900, "sold", { matchScore: 0.2 }),
      comp(3_100, "sold", { currency: "CAD" }),
      { ...comp(0), priceCents: null },
    ], "USD", now);
    expect(stats.sold).toMatchObject({ count: 2, medianCents: 3_100, excluded: 1 });
    expect(stats.confidence).toBe("medium");
  });

  it("does not use comps that were never scored", () => {
    expect(compStats([comp(3_000, "sold", { matchScore: null }), comp(3_100, "sold", { matchScore: undefined })], "USD", now).sold).toBeNull();
  });

  it("prefers recent sales when there are at least three", () => {
    const recent = (price: number) => comp(price, "sold", { soldAt: "2026-08-01T00:00:00Z" });
    const stats = compStats([recent(1_000), recent(1_100), recent(1_200), comp(9_000, "sold", { soldAt: "2024-01-01T00:00:00Z" })], "USD", now);
    expect(stats.sold).toMatchObject({ count: 3, medianCents: 1_100, excluded: 1 });
  });

  it("reports confidence from the amount of evidence", () => {
    expect(compStats([], "USD", now).confidence).toBe("none");
    expect(compStats([comp(1_000, "active")], "USD", now).confidence).toBe("low");
    expect(compStats([1, 2, 3, 4, 5].map((n) => comp(1_000 + n)), "USD", now).confidence).toBe("high");
  });
});
