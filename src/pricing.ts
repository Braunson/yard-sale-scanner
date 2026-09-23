import { marketForCurrency, type Platform, PLATFORMS } from "./markets";
import type { DetectedItem } from "./types";

export type OnlineVerdict = "online" | "local" | "similar";

export type SaleOption = {
  platform: Platform;
  saleCents: number;
  feesCents: number;
  /** Seller-paid shipping, 0 when the buyer pays, null when it is unknown. */
  shippingCents: number | null;
  /** Null when the seller pays shipping and its cost is unknown. */
  netCents: number | null;
};

export type SaleOutlook = {
  /** Suitable platforms, best net first; options with an unknown net come last. */
  options: SaleOption[];
  local: SaleOption | null;
  bestOnline: SaleOption | null;
  /** The option with the highest known net, local or online. */
  best: SaleOption | null;
  verdict: OnlineVerdict | null;
  /** Best online net minus the local sale. */
  premiumCents: number | null;
};

type PricedItem = Pick<
  DetectedItem,
  | "estimatedLowCents"
  | "estimatedHighCents"
  | "onlineSaleCents"
  | "shippingCents"
  | "soldPriceCents"
  | "activePriceCents"
  | "currency"
  | "goodsType"
  | "vintage"
>;

/** Typical online sale price: sold comps first, and an active asking price discounted because listings rarely sell at ask. */
export function onlineSalePrice(item: Pick<DetectedItem, "onlineSaleCents" | "soldPriceCents" | "activePriceCents">): number | null {
  return (
    item.onlineSaleCents ??
    item.soldPriceCents ??
    (item.activePriceCents === null ? null : Math.round(item.activePriceCents * 0.85))
  );
}

/** Net proceeds on every platform that suits the item in its market, and whether selling online pays. */
export function saleOutlook(item: PricedItem): SaleOutlook {
  const localCents = localResaleCents(item);
  const onlineCents = onlineSalePrice(item);
  const options: SaleOption[] = [];
  for (const platform of PLATFORMS[marketForCurrency(item.currency)]) {
    if (platform.suits && !platform.suits(item)) continue;
    const saleCents = platform.kind === "local" ? localCents : onlineCents;
    if (saleCents === null) continue;
    const feesCents = platform.feeCents(saleCents);
    const shippingCents = platform.sellerPaysShipping ? item.shippingCents : 0;
    options.push({
      platform,
      saleCents,
      feesCents,
      shippingCents,
      netCents: shippingCents === null ? null : saleCents - feesCents - shippingCents,
    });
  }
  options.sort((left, right) => (right.netCents ?? -Infinity) - (left.netCents ?? -Infinity));

  const known = options.filter((option) => option.netCents !== null);
  const local = options.find((option) => option.platform.kind === "local") ?? null;
  const bestOnline = known.find((option) => option.platform.kind === "online") ?? null;
  let verdict: OnlineVerdict | null = null;
  let premiumCents: number | null = null;
  if (local?.netCents != null && bestOnline?.netCents != null) {
    premiumCents = bestOnline.netCents - local.netCents;
    // Listing, packing, and waiting for a buyer are worth at least $5 or 15% of the local price.
    const worthwhileCents = Math.max(500, Math.round(local.netCents * 0.15));
    verdict = premiumCents >= worthwhileCents ? "online" : premiumCents <= 0 ? "local" : "similar";
  }
  return { options, local, bestOnline, best: known[0] ?? null, verdict, premiumCents };
}

/** Midpoint of the conservative resale range, which approximates a quick local sale. */
export function localResaleCents(item: Pick<DetectedItem, "estimatedLowCents" | "estimatedHighCents">): number | null {
  const { estimatedLowCents: low, estimatedHighCents: high } = item;
  if (low === null && high === null) return null;
  return Math.round(((low ?? high ?? 0) + (high ?? low ?? 0)) / 2);
}

/** Expected profit from buying at the tag price and reselling at the local midpoint. */
export function tagMargin(item: Pick<DetectedItem, "observedPriceCents" | "estimatedLowCents" | "estimatedHighCents">) {
  const localCents = localResaleCents(item);
  if (item.observedPriceCents === null || localCents === null) return null;
  const profitCents = localCents - item.observedPriceCents;
  return {
    profitCents,
    roi: item.observedPriceCents > 0 ? profitCents / item.observedPriceCents : null,
  };
}

export type OfferTargets = {
  /** Smallest profit worth the trouble of reselling. */
  minProfitCents: number;
  /** Smallest return on the purchase price, for example 1 for 100%. */
  minRoi: number;
};

export const DEFAULT_OFFER_TARGETS: OfferTargets = { minProfitCents: 1_000, minRoi: 1 };

export type OfferAdvice = {
  verdict: "buy" | "negotiate" | "pass" | "offer";
  /** Highest price that still meets both targets, rounded down to a whole dollar. */
  maxOfferCents: number;
  /** Expected net from the best way to sell, before the purchase price. */
  expectedNetCents: number;
  profitAtTagCents: number | null;
};

/**
 * Compares the tag price with the most a reseller should pay. Without a tag the verdict is "offer",
 * which only reports the maximum offer.
 */
export function offerAdvice(
  tagCents: number | null,
  expectedNetCents: number,
  targets: OfferTargets = DEFAULT_OFFER_TARGETS,
): OfferAdvice {
  const byProfit = expectedNetCents - targets.minProfitCents;
  const byRoi = expectedNetCents / (1 + targets.minRoi);
  const maxOfferCents = Math.max(0, Math.floor(Math.min(byProfit, byRoi) / 100) * 100);
  const profitAtTagCents = tagCents === null ? null : expectedNetCents - tagCents;

  let verdict: OfferAdvice["verdict"];
  if (tagCents === null) verdict = "offer";
  else if (maxOfferCents > 0 && tagCents <= maxOfferCents) verdict = "buy";
  // A seller at a yard sale will often take 20–30% off, so a tag a little over the limit is worth an offer.
  else if (maxOfferCents > 0 && tagCents <= Math.round(maxOfferCents * 1.35)) verdict = "negotiate";
  else verdict = "pass";

  return { verdict, maxOfferCents, expectedNetCents, profitAtTagCents };
}
