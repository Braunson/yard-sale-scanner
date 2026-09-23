import { PLATFORMS, marketForCurrency } from "./markets";
import { localResaleCents, onlineSalePrice } from "./pricing";
import type { DetectedItem, Ledger } from "./types";

export const EMPTY_LEDGER: Ledger = {
  purchaseCents: null,
  purchasedAt: null,
  saleCents: null,
  soldAt: null,
  platformId: null,
  feesCents: null,
  shippingCents: null,
  estimateCents: null,
};

/** The price the app expected on this platform: the local price for local sales, else the online price. */
export function expectedSaleCents(item: DetectedItem, platformId: string): number | null {
  return platformId === "local" ? localResaleCents(item) : onlineSalePrice(item);
}

/** The platform's standard fee for this sale, used to prefill the fee field. */
export function defaultFeesCents(currency: string, platformId: string, saleCents: number): number | null {
  const platform = PLATFORMS[marketForCurrency(currency)].find((candidate) => candidate.id === platformId);
  return platform ? platform.feeCents(saleCents) : null;
}

/** Profit after fees and shipping. Null until the item is both bought and sold. */
export function realizedProfitCents(ledger: Ledger): number | null {
  if (ledger.purchaseCents === null || ledger.saleCents === null) return null;
  return ledger.saleCents - (ledger.feesCents ?? 0) - (ledger.shippingCents ?? 0) - ledger.purchaseCents;
}

export type CurrencyTotals = {
  currency: string;
  bought: number;
  sold: number;
  /** Paid for every bought item, sold or not. */
  spentCents: number;
  /** Paid for items that are not sold yet. */
  inventoryCents: number;
  revenueCents: number;
  feesCents: number;
  shippingCents: number;
  /** Profit on items that are bought and sold. */
  profitCents: number;
  /** Profit divided by the cost of the sold items. */
  roi: number | null;
};

export type AccuracyGroup = {
  group: string;
  count: number;
  /** Median of (sale − estimate) ÷ estimate. Negative means the app estimated too high. */
  medianErrorPct: number;
  /** Median of |sale − estimate| ÷ estimate. */
  medianAbsErrorPct: number;
};

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function ledgerSummary(items: DetectedItem[]): { totals: CurrencyTotals[]; accuracy: AccuracyGroup[] } {
  const totals = new Map<string, CurrencyTotals & { soldCostCents: number }>();
  const errors = new Map<string, number[]>();

  for (const item of items) {
    const ledger = item.ledger;
    if (!ledger || (ledger.purchaseCents === null && ledger.saleCents === null)) continue;
    const entry = totals.get(item.currency) ?? {
      currency: item.currency,
      bought: 0,
      sold: 0,
      spentCents: 0,
      inventoryCents: 0,
      revenueCents: 0,
      feesCents: 0,
      shippingCents: 0,
      profitCents: 0,
      roi: null,
      soldCostCents: 0,
    };
    if (ledger.purchaseCents !== null) {
      entry.bought += 1;
      entry.spentCents += ledger.purchaseCents;
      if (ledger.saleCents === null) entry.inventoryCents += ledger.purchaseCents;
    }
    if (ledger.saleCents !== null) {
      entry.sold += 1;
      entry.revenueCents += ledger.saleCents;
      entry.feesCents += ledger.feesCents ?? 0;
      entry.shippingCents += ledger.shippingCents ?? 0;
      const profit = realizedProfitCents(ledger);
      if (profit !== null) {
        entry.profitCents += profit;
        entry.soldCostCents += ledger.purchaseCents ?? 0;
      }
      if (ledger.estimateCents && ledger.estimateCents > 0) {
        const error = (ledger.saleCents - ledger.estimateCents) / ledger.estimateCents;
        const groups = [
          "All sales",
          `Pricing: ${item.pricingPath === "instant" ? "instant" : "researched"}`,
          `Goods: ${item.goodsType}`,
          `Sold ${ledger.platformId === "local" ? "locally" : "online"}`,
        ];
        for (const group of groups) errors.set(group, [...(errors.get(group) ?? []), error]);
      }
    }
    totals.set(item.currency, entry);
  }

  return {
    totals: [...totals.values()].map(({ soldCostCents, ...entry }) => ({
      ...entry,
      roi: soldCostCents > 0 ? entry.profitCents / soldCostCents : null,
    })),
    accuracy: [...errors.entries()].map(([group, values]) => ({
      group,
      count: values.length,
      medianErrorPct: median(values),
      medianAbsErrorPct: median(values.map(Math.abs)),
    })),
  };
}

/** Parses a typed amount such as "12", "12.5", or "$1,200.00" into cents. Empty text is null. */
export function parseMoneyInput(text: string): number | null | "invalid" {
  const cleaned = text.replace(/[$,\s]|CA/g, "");
  if (!cleaned) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return "invalid";
  return Math.round(Number(cleaned) * 100);
}
