import { describe, expect, it } from "vitest";
import { localResaleCents, offerAdvice, onlineSalePrice, saleOutlook, tagMargin } from "./pricing";

const base = {
  estimatedLowCents: 2_000,
  estimatedHighCents: 3_000,
  onlineSaleCents: null,
  shippingCents: null,
  soldPriceCents: null,
  activePriceCents: null,
  currency: "USD",
  goodsType: "electronics" as const,
  vintage: false,
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

describe("onlineSalePrice", () => {
  it("falls back to sold comps, then discounted active listings", () => {
    expect(onlineSalePrice({ ...base, soldPriceCents: 5_000 })).toBe(5_000);
    expect(onlineSalePrice({ ...base, activePriceCents: 10_000 })).toBe(8_500);
    expect(onlineSalePrice(base)).toBeNull();
  });
});

describe("saleOutlook", () => {
  const ids = (outlook: ReturnType<typeof saleOutlook>) => outlook.options.map((option) => option.platform.id);

  it("recommends the best online platform when it clearly beats a local sale", () => {
    const outlook = saleOutlook({ ...base, onlineSaleCents: 6_000, shippingCents: 900 });
    // Mercari: 6000 - 600 - 900 = 4500. eBay: 6000 - 816 - 40 - 900 = 4244. Local: 2500.
    expect(outlook.best).toMatchObject({ netCents: 4_500, platform: { id: "mercari" } });
    expect(outlook).toMatchObject({ verdict: "online", premiumCents: 2_000 });
  });

  it("recommends a local sale when fees and shipping eat the online price", () => {
    expect(saleOutlook({ ...base, onlineSaleCents: 3_500, shippingCents: 1_200 }).verdict).toBe("local");
  });

  it("calls a small premium about the same", () => {
    // Mercari: 3500 - 350 - 300 = 2850, a $3.50 premium over the $25 local sale.
    expect(saleOutlook({ ...base, onlineSaleCents: 3_500, shippingCents: 300 }).verdict).toBe("similar");
  });

  it("does not compare seller-shipped platforms when shipping is unknown", () => {
    const outlook = saleOutlook({ ...base, onlineSaleCents: 20_000 });
    expect(outlook.bestOnline).toBeNull();
    expect(outlook.verdict).toBeNull();
    expect(outlook.best?.platform.id).toBe("local");
  });

  it("offers Poshmark for fashion (buyer pays shipping) and Etsy only for vintage", () => {
    expect(ids(saleOutlook({ ...base, onlineSaleCents: 5_000 }))).not.toContain("poshmark");
    const fashion = saleOutlook({ ...base, goodsType: "fashion", onlineSaleCents: 5_000 });
    expect(fashion.bestOnline).toMatchObject({ platform: { id: "poshmark" }, feesCents: 1_000, shippingCents: 0, netCents: 4_000 });
    expect(ids(saleOutlook({ ...base, vintage: true, onlineSaleCents: 5_000, shippingCents: 500 }))).toContain("etsy");
  });

  it("uses Canadian platforms and fees for CAD items", () => {
    const outlook = saleOutlook({ ...base, currency: "CAD", goodsType: "fashion", onlineSaleCents: 1_500 });
    expect(ids(outlook)).toEqual(["local", "poshmark", "ebay"]);
    expect(outlook.options.find((option) => option.platform.id === "poshmark")?.feesCents).toBe(395);
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

describe("offerAdvice", () => {
  it("uses the stricter of the profit and ROI targets", () => {
    // $60 net: profit target allows $50, 100% ROI allows $30.
    expect(offerAdvice(2_500, 6_000).maxOfferCents).toBe(3_000);
    // $15 net: profit target allows $5, ROI allows $7.50.
    expect(offerAdvice(null, 1_500).maxOfferCents).toBe(500);
  });

  it("says buy, negotiate, or pass from the tag price", () => {
    expect(offerAdvice(2_500, 6_000)).toMatchObject({ verdict: "buy", profitAtTagCents: 3_500 });
    expect(offerAdvice(4_000, 6_000).verdict).toBe("negotiate");
    expect(offerAdvice(5_000, 6_000).verdict).toBe("pass");
    expect(offerAdvice(0, 800).verdict).toBe("pass");
  });

  it("only reports a maximum offer when there is no tag", () => {
    expect(offerAdvice(null, 6_000, { minProfitCents: 500, minRoi: 0.5 })).toMatchObject({ verdict: "offer", maxOfferCents: 4_000 });
  });
});
