import { describe, expect, it } from "vitest";
import { defaultFeesCents, EMPTY_LEDGER, expectedSaleCents, ledgerSummary, parseMoneyInput, realizedProfitCents } from "./ledger";
import type { DetectedItem, Ledger } from "./types";

const item = (ledger: Partial<Ledger> | null, extra: Partial<DetectedItem> = {}): DetectedItem =>
  ({
    currency: "USD",
    estimatedLowCents: 2_000,
    estimatedHighCents: 3_000,
    onlineSaleCents: 6_000,
    soldPriceCents: null,
    activePriceCents: null,
    pricingPath: "research",
    goodsType: "electronics",
    ledger: ledger && { ...EMPTY_LEDGER, ...ledger },
    ...extra,
  }) as DetectedItem;

describe("expectedSaleCents and defaultFeesCents", () => {
  it("use the local price for local sales and the online price otherwise", () => {
    expect(expectedSaleCents(item(null), "local")).toBe(2_500);
    expect(expectedSaleCents(item(null), "ebay")).toBe(6_000);
  });

  it("prefill the platform fee in the item's market", () => {
    expect(defaultFeesCents("USD", "mercari", 5_000)).toBe(500);
    expect(defaultFeesCents("CAD", "poshmark", 1_500)).toBe(395);
    expect(defaultFeesCents("CAD", "mercari", 5_000)).toBeNull();
  });
});

describe("realizedProfitCents", () => {
  it("subtracts fees, shipping, and the purchase price", () => {
    expect(realizedProfitCents({ ...EMPTY_LEDGER, purchaseCents: 1_000, saleCents: 6_000, feesCents: 600, shippingCents: 900 })).toBe(3_500);
    expect(realizedProfitCents({ ...EMPTY_LEDGER, purchaseCents: 1_000 })).toBeNull();
  });
});

describe("ledgerSummary", () => {
  it("totals spending, inventory, revenue, and profit for each currency", () => {
    const { totals } = ledgerSummary([
      item({ purchaseCents: 1_000, saleCents: 6_000, feesCents: 600, shippingCents: 900, estimateCents: 5_000, platformId: "mercari" }),
      item({ purchaseCents: 500 }),
      item(null),
      item({ purchaseCents: 2_000, saleCents: 2_500, estimateCents: 2_500, platformId: "local" }, { currency: "CAD" }),
    ]);
    expect(totals).toEqual([
      { currency: "USD", bought: 2, sold: 1, spentCents: 1_500, inventoryCents: 500, revenueCents: 6_000, feesCents: 600, shippingCents: 900, profitCents: 3_500, roi: 3.5 },
      { currency: "CAD", bought: 1, sold: 1, spentCents: 2_000, inventoryCents: 0, revenueCents: 2_500, feesCents: 0, shippingCents: 0, profitCents: 500, roi: 0.25 },
    ]);
  });

  it("measures estimate accuracy by pricing path, goods type, and channel", () => {
    const { accuracy } = ledgerSummary([
      item({ saleCents: 6_000, estimateCents: 5_000, platformId: "ebay" }),
      item({ saleCents: 4_000, estimateCents: 5_000, platformId: "ebay" }, { pricingPath: "instant" }),
    ]);
    const byGroup = Object.fromEntries(accuracy.map((entry) => [entry.group, entry]));
    expect(byGroup["All sales"]).toMatchObject({ count: 2, medianErrorPct: 0, medianAbsErrorPct: 0.2 });
    expect(byGroup["Pricing: instant"]).toMatchObject({ count: 1, medianErrorPct: -0.2 });
    expect(byGroup["Sold online"]?.count).toBe(2);
  });
});

describe("parseMoneyInput", () => {
  it("reads dollar amounts as cents", () => {
    expect(parseMoneyInput("12")).toBe(1_200);
    expect(parseMoneyInput(" $1,200.5 ")).toBe(120_050);
    expect(parseMoneyInput("CA$4.99")).toBe(499);
    expect(parseMoneyInput("")).toBeNull();
  });

  it("rejects text that is not an amount", () => {
    expect(parseMoneyInput("ten")).toBe("invalid");
    expect(parseMoneyInput("1.234")).toBe("invalid");
    expect(parseMoneyInput("-5")).toBe("invalid");
  });
});
