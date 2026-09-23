import { describe, expect, it } from "vitest";
import { localResaleCents, onlineOutlook, tagMargin } from "./pricing";

const base = {
  estimatedLowCents: 2_000,
  estimatedHighCents: 3_000,
  onlineSaleCents: null,
  shippingCents: null,
  soldPriceCents: null,
  activePriceCents: null,
};

describe("localResaleCents", () => {
  it("uses the midpoint of the resale range", () => {
    expect(localResaleCents(base)).toBe(2_500);
  });

  it("uses the only bound that is known", () => {
    expect(localResaleCents({ estimatedLowCents: null, estimatedHighCents: 1_200 })).toBe(1_200);
    expect(localResaleCents({ estimatedLowCents: null, estimatedHighCents: null })).toBeNull();
  });
});

describe("onlineOutlook", () => {
  it("recommends selling online when the net after fees and shipping clearly beats local", () => {
    const outlook = onlineOutlook({ ...base, onlineSaleCents: 6_000, shippingCents: 900 });
    // 6000 - (795 + 40) - 900 = 4265 net; 4265 - 2500 = 1765 premium.
    expect(outlook).toMatchObject({ verdict: "online", feesCents: 835, onlineNetCents: 4_265, premiumCents: 1_765 });
  });

  it("recommends selling locally when shipping and fees eat the online price", () => {
    expect(onlineOutlook({ ...base, onlineSaleCents: 3_500, shippingCents: 1_200 })?.verdict).toBe("local");
  });

  it("calls a small premium about the same", () => {
    // 3800 - 543 - 400 = 2857 net; a $3.57 premium is below the $5 minimum.
    expect(onlineOutlook({ ...base, onlineSaleCents: 3_800, shippingCents: 400 })?.verdict).toBe("similar");
  });

  it("does not recommend online when shipping is unknown", () => {
    expect(onlineOutlook({ ...base, onlineSaleCents: 20_000 })?.verdict).toBe("similar");
  });

  it("falls back to sold comps, then discounted active listings", () => {
    expect(onlineOutlook({ ...base, soldPriceCents: 5_000 })?.onlineSaleCents).toBe(5_000);
    expect(onlineOutlook({ ...base, activePriceCents: 10_000 })?.onlineSaleCents).toBe(8_500);
  });

  it("returns null without online evidence or a local price", () => {
    expect(onlineOutlook(base)).toBeNull();
    expect(onlineOutlook({ ...base, estimatedLowCents: null, estimatedHighCents: null, onlineSaleCents: 5_000 })).toBeNull();
  });
});

describe("tagMargin", () => {
  it("computes profit and ROI against the tag price", () => {
    expect(tagMargin({ observedPriceCents: 500, estimatedLowCents: 2_000, estimatedHighCents: 3_000 })).toEqual({
      profitCents: 2_000,
      roi: 4,
    });
  });

  it("handles free items and missing tags", () => {
    expect(tagMargin({ observedPriceCents: 0, estimatedLowCents: 1_000, estimatedHighCents: 1_000 })?.roi).toBeNull();
    expect(tagMargin({ observedPriceCents: null, estimatedLowCents: 1_000, estimatedHighCents: 1_000 })).toBeNull();
  });
});
