import type { Comparable, GoodsType, Market } from "../../src/types";

export type ItemQuery = {
  name: string;
  brand: string | null;
  model: string | null;
  category: string;
  goodsType: GoodsType;
  condition: string;
  barcode: string | null;
};

export type ProviderResult = {
  source: string;
  comps: Comparable[];
  /** total listings reported by the source, when it reports one */
  total: number | null;
  error: string | null;
};

export const MARKET_CONFIG: Record<
  Market,
  { currency: "USD" | "CAD"; ebayMarketplace: "EBAY_US" | "EBAY_CA"; country: "US" | "CA" }
> = {
  US: { currency: "USD", ebayMarketplace: "EBAY_US", country: "US" },
  CA: { currency: "CAD", ebayMarketplace: "EBAY_CA", country: "CA" },
};

export const PROVIDER_TIMEOUT_MS = 6_000;

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
