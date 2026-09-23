import type { DetectedItem } from "./types";

// eBay's most common final value fee: 13.25% of the sale total plus a $0.40 per-order fee.
export const MARKETPLACE_FEE_RATE = 0.1325;
export const MARKETPLACE_FIXED_FEE_CENTS = 40;

export type OnlineVerdict = "online" | "local" | "similar";

export type OnlineOutlook = {
  verdict: OnlineVerdict;
  onlineSaleCents: number;
  feesCents: number;
  shippingCents: number;
  onlineNetCents: number;
  shippingKnown: boolean;
  localCents: number;
  premiumCents: number;
};

type PricedItem = Pick<
  DetectedItem,
  "estimatedLowCents" | "estimatedHighCents" | "onlineSaleCents" | "shippingCents" | "soldPriceCents" | "activePriceCents"
>;

/** Midpoint of the conservative resale range, which approximates a quick local sale. */
export function localResaleCents(item: Pick<DetectedItem, "estimatedLowCents" | "estimatedHighCents">): number | null {
  const { estimatedLowCents: low, estimatedHighCents: high } = item;
  if (low === null && high === null) return null;
  return Math.round(((low ?? high ?? 0) + (high ?? low ?? 0)) / 2);
}

/**
 * Compares the net amount after marketplace fees and seller-paid shipping with a local sale.
 * Sold comps are preferred; an active asking price is discounted because listings rarely sell at ask.
 */
export function onlineOutlook(item: PricedItem): OnlineOutlook | null {
  const localCents = localResaleCents(item);
  const onlineSaleCents =
    item.onlineSaleCents ??
    item.soldPriceCents ??
    (item.activePriceCents === null ? null : Math.round(item.activePriceCents * 0.85));
  if (localCents === null || onlineSaleCents === null) return null;

  const shippingCents = item.shippingCents ?? 0;
  const feesCents = Math.round(onlineSaleCents * MARKETPLACE_FEE_RATE) + MARKETPLACE_FIXED_FEE_CENTS;
  const onlineNetCents = onlineSaleCents - feesCents - shippingCents;
  const premiumCents = onlineNetCents - localCents;
  // Listing, packing, and waiting for a buyer are worth at least $5 or 15% of the local price.
  const worthwhileCents = Math.max(500, Math.round(localCents * 0.15));
  let verdict: OnlineVerdict = premiumCents >= worthwhileCents ? "online" : premiumCents <= 0 ? "local" : "similar";
  // Without a shipping estimate the premium is an upper bound, so do not recommend selling online.
  if (verdict === "online" && item.shippingCents === null) verdict = "similar";

  return { verdict, shippingKnown: item.shippingCents !== null, onlineSaleCents, feesCents, shippingCents, onlineNetCents, localCents, premiumCents };
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
