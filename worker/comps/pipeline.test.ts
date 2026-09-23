import { describe, expect, it } from "vitest";
import type { Comparable } from "../../src/types";
import { finalizeComps, MAX_COMPS_PER_ITEM, pricesFromStats } from "./pipeline";
import type { MatchItem } from "./match";

const item: MatchItem = {
  name: "Walkman cassette player",
  brand: "Sony",
  model: "WM-FX195",
  category: "Electronics",
  goodsType: "electronics",
  condition: "Used",
  barcode: null,
  description: "Silver portable cassette player",
};

const comp = (title: string, priceCents: number, extra: Partial<Comparable> = {}): Comparable => ({
  title,
  url: null,
  priceCents,
  currency: "USD",
  type: "active",
  source: "ebay",
  ...extra,
});

const rate = async (from: string, to: string) => (from === "USD" && to === "CAD" ? 1.4 : 1);
const now = Date.parse("2026-09-23T00:00:00Z");

describe("finalizeComps", () => {
  it("converts to the market currency and scores every comp, including the model's", async () => {
    const result = await finalizeComps({
      item,
      market: "CA",
      providerComps: [comp("Sony Walkman WM-FX195 cassette player", 3_000), comp("Cassette tape lot", 1_000)],
      modelComps: [
        comp("Sony Walkman WM-FX195 cassette player, sold", 2_500, { type: "sold", source: null }),
        comp("Sony Discman D-50 CD player", 9_000, { type: "sold", source: null }),
      ],
      jevApiKey: undefined,
      getRateFn: rate,
      now,
    });
    expect(result.matchSource).toBe("similarity");
    const byTitle = new Map(result.comps.map((entry) => [entry.title, entry]));
    expect(byTitle.get("Sony Walkman WM-FX195 cassette player")).toMatchObject({ currency: "CAD", priceCents: 4_200, originalCurrency: "USD" });
    expect(byTitle.get("Sony Walkman WM-FX195 cassette player, sold")).toMatchObject({ source: "web", priceCents: 3_500 });
    // A different model the research model picked, and an unrelated lot, are scored out of the stats.
    expect(byTitle.get("Sony Discman D-50 CD player")!.matchScore).toBeLessThan(0.6);
    expect(byTitle.get("Cassette tape lot")!.matchScore).toBeLessThan(0.6);
    expect(result.stats.sold).toMatchObject({ count: 1, medianCents: 3_500, excluded: 1 });
    expect(result.stats.active).toMatchObject({ count: 1, medianCents: 4_200, excluded: 1 });
  });

  it("treats a listing the model copied without its URL as a duplicate", async () => {
    const result = await finalizeComps({
      item,
      market: "US",
      providerComps: [comp("Sony Walkman WM-FX195", 3_000, { url: "https://ebay.example/1", condition: "Used" })],
      modelComps: [comp("Sony Walkman WM-FX195", 3_000, { source: null })],
      jevApiKey: undefined,
      now,
    });
    expect(result.comps).toHaveLength(1);
    expect(result.comps[0]).toMatchObject({ source: "ebay", condition: "Used" });
  });

  it("removes duplicate comps and keeps at most the limit", async () => {
    const many = Array.from({ length: 60 }, (_, index) => comp(`Sony Walkman WM-FX195 #${index}`, 3_000 + index, { url: `https://e/${index}` }));
    const result = await finalizeComps({
      item,
      market: "US",
      providerComps: [...many, many[0]!],
      modelComps: [],
      jevApiKey: undefined,
      now,
    });
    expect(result.comps).toHaveLength(MAX_COMPS_PER_ITEM);
    expect(new Set(result.comps.map((entry) => entry.url)).size).toBe(MAX_COMPS_PER_ITEM);
  });
});

describe("pricesFromStats", () => {
  const model = { soldPriceCents: 1_000, activePriceCents: 2_000, onlineSaleCents: 1_500, retailPriceCents: 5_000 };
  const stats = (soldCount: number) => ({
    sold: soldCount ? { count: soldCount, medianCents: 2_400, lowCents: 2_000, highCents: 2_800, excluded: 0 } : null,
    active: { count: 8, medianCents: 3_100, lowCents: 2_500, highCents: 4_000, excluded: 1 },
    retail: null,
    confidence: "medium" as const,
  });

  it("uses comp medians and needs two sales before replacing the online price", () => {
    expect(pricesFromStats(stats(2), model)).toEqual({
      soldPriceCents: 2_400,
      activePriceCents: 3_100,
      onlineSaleCents: 2_400,
      retailPriceCents: 5_000,
    });
    expect(pricesFromStats(stats(1), model).onlineSaleCents).toBe(1_500);
  });

  it("keeps the model's numbers when there are no comps", () => {
    expect(pricesFromStats({ sold: null, active: null, retail: null, confidence: "none" }, model)).toEqual(model);
  });
});
