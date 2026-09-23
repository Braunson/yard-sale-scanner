import { describe, expect, it } from "vitest";
import { EMPTY_LEDGER } from "../src/ledger";
import type { DetectedItem } from "../src/types";
import { buildLedger, LedgerInputError } from "./ledger";

const item = {
  currency: "USD",
  estimatedLowCents: 2_000,
  estimatedHighCents: 3_000,
  onlineSaleCents: 6_000,
  soldPriceCents: null,
  activePriceCents: null,
  ledger: null,
} as unknown as DetectedItem;
const now = "2026-09-23T12:00:00.000Z";

describe("buildLedger", () => {
  it("records a purchase with today's date", () => {
    expect(buildLedger({ purchaseCents: 1_500 }, item, now)).toEqual({ ...EMPTY_LEDGER, purchaseCents: 1_500, purchasedAt: now });
  });

  it("prefills the platform fee and stores the app's estimate for that platform", () => {
    expect(buildLedger({ purchaseCents: 1_500, saleCents: 5_000, platformId: "mercari", shippingCents: 900 }, item, now)).toMatchObject({
      saleCents: 5_000,
      soldAt: now,
      platformId: "mercari",
      feesCents: 500,
      shippingCents: 900,
      estimateCents: 6_000,
    });
    expect(buildLedger({ saleCents: 2_000, platformId: "local", feesCents: 0 }, item, now)).toMatchObject({ feesCents: 0, estimateCents: 2_500 });
  });

  it("keeps the first estimate when only the fee changes", () => {
    const saved = { ...item, ledger: { ...EMPTY_LEDGER, saleCents: 5_000, platformId: "ebay", estimateCents: 4_000, soldAt: now } };
    expect(buildLedger({ saleCents: 5_000, platformId: "ebay", feesCents: 700 }, saved, now).estimateCents).toBe(4_000);
    expect(buildLedger({ saleCents: 5_500, platformId: "ebay" }, saved, now).estimateCents).toBe(6_000);
  });

  it("clears the ledger when both prices are empty", () => {
    expect(buildLedger({ purchaseCents: null, saleCents: "" }, item, now)).toEqual(EMPTY_LEDGER);
  });

  it("rejects bad amounts, dates, and platforms from another market", () => {
    expect(() => buildLedger({ purchaseCents: -1 }, item, now)).toThrow(LedgerInputError);
    expect(() => buildLedger({ purchaseCents: 12.5 }, item, now)).toThrow(LedgerInputError);
    expect(() => buildLedger({ purchaseCents: 100, purchasedAt: "soon" }, item, now)).toThrow(LedgerInputError);
    expect(() => buildLedger({ saleCents: 100 }, item, now)).toThrow("A sale needs a platform.");
    expect(() => buildLedger({ saleCents: 100, platformId: "mercari" }, { ...item, currency: "CAD" }, now)).toThrow(LedgerInputError);
  });
});
