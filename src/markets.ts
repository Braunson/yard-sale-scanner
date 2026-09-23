import type { DetectedItem, GoodsType, Market } from "./types";

export const MARKETS: Record<Market, { label: string; currency: "USD" | "CAD"; carrier: string }> = {
  US: { label: "United States (USD)", currency: "USD", carrier: "USPS Ground Advantage" },
  CA: { label: "Canada (CAD)", currency: "CAD", carrier: "Canada Post" },
};

export function marketForCurrency(currency: string): Market {
  return currency === "CAD" ? "CA" : "US";
}

export type Platform = {
  id: string;
  name: string;
  kind: "local" | "online";
  /** Fees in cents for a sale at this price, in the market currency. */
  feeCents: (saleCents: number) => number;
  /** False when the buyer pays for a prepaid label, as on Poshmark. */
  sellerPaysShipping: boolean;
  feeSummary: string;
  /** Platforms that only suit some goods, for example Etsy's vintage rule. */
  suits?: (item: Pick<DetectedItem, "goodsType" | "vintage">) => boolean;
};

const percent = (saleCents: number, rate: number) => Math.round(saleCents * rate);
const FASHION_AND_HOME: GoodsType[] = ["fashion", "home"];

// Fee schedules checked September 2026. Most-category rates; some categories differ.
export const PLATFORMS: Record<Market, Platform[]> = {
  US: [
    {
      id: "local",
      name: "Local sale (Facebook, Craigslist)",
      kind: "local",
      feeCents: () => 0,
      sellerPaysShipping: false,
      feeSummary: "No fees for local pickup",
    },
    {
      id: "ebay",
      name: "eBay",
      kind: "online",
      feeCents: (sale) => percent(sale, 0.136) + (sale > 1_000 ? 40 : 30),
      sellerPaysShipping: true,
      feeSummary: "13.6% + $0.30 (≤ $10) or $0.40",
    },
    {
      id: "mercari",
      name: "Mercari",
      kind: "online",
      feeCents: (sale) => percent(sale, 0.1),
      sellerPaysShipping: true,
      feeSummary: "10%",
    },
    {
      id: "poshmark",
      name: "Poshmark",
      kind: "online",
      feeCents: (sale) => (sale < 1_500 ? 295 : percent(sale, 0.2)),
      sellerPaysShipping: false,
      feeSummary: "$2.95 under $15, else 20%; buyer pays shipping",
      suits: (item) => FASHION_AND_HOME.includes(item.goodsType),
    },
    {
      id: "facebook-shipped",
      name: "Facebook Marketplace (shipped)",
      kind: "online",
      feeCents: (sale) => Math.max(80, percent(sale, 0.1)),
      sellerPaysShipping: true,
      feeSummary: "10% (minimum $0.80)",
    },
    {
      id: "etsy",
      name: "Etsy (vintage)",
      kind: "online",
      feeCents: (sale) => percent(sale, 0.065) + percent(sale, 0.03) + 25 + 20,
      sellerPaysShipping: true,
      feeSummary: "6.5% + 3% + $0.25 + $0.20 listing",
      suits: (item) => item.vintage,
    },
  ],
  CA: [
    {
      id: "local",
      name: "Local sale (Facebook, Kijiji)",
      kind: "local",
      feeCents: () => 0,
      sellerPaysShipping: false,
      feeSummary: "No fees for local pickup",
    },
    {
      id: "ebay",
      name: "eBay.ca",
      kind: "online",
      feeCents: (sale) => percent(sale, 0.136) + (sale > 1_000 ? 40 : 30),
      sellerPaysShipping: true,
      feeSummary: "13.6% + C$0.30 (≤ C$10) or C$0.40",
    },
    {
      id: "poshmark",
      name: "Poshmark Canada",
      kind: "online",
      feeCents: (sale) => (sale < 2_000 ? 395 : percent(sale, 0.2)),
      sellerPaysShipping: false,
      feeSummary: "C$3.95 under C$20, else 20%; buyer pays shipping",
      suits: (item) => FASHION_AND_HOME.includes(item.goodsType),
    },
    {
      id: "etsy",
      name: "Etsy (vintage)",
      kind: "online",
      // Transaction, payment processing, Canadian regulatory fee, and the US$0.20 listing fee in CAD.
      feeCents: (sale) => percent(sale, 0.065) + percent(sale, 0.03) + percent(sale, 0.0115) + 25 + 28,
      sellerPaysShipping: true,
      feeSummary: "6.5% + 3% + 1.15% + C$0.25 + about C$0.28 listing",
      suits: (item) => item.vintage,
    },
  ],
};
