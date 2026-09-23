import type { Comparable } from "../src/types";

const FX_ENDPOINT = "https://api.frankfurter.dev/v1/latest";
const FX_TIMEOUT_MS = 6_000;
// ECB reference rates change once a day, so half a day per isolate is fresh enough.
const FX_CACHE_MS = 12 * 60 * 60 * 1000;

const rateCache = new Map<string, { rate: number; expiresAt: number }>();

export function clearRateCache(): void {
  rateCache.clear();
}

/** Units of `to` per one unit of `from`. Throws when the rate is unavailable. */
export async function getRate(from: string, to: string): Promise<number> {
  const base = from.toUpperCase();
  const symbol = to.toUpperCase();
  if (base === symbol) return 1;

  const key = `${base}:${symbol}`;
  const cached = rateCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.rate;

  const response = await fetch(
    `${FX_ENDPOINT}?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(symbol)}`,
    { signal: AbortSignal.timeout(FX_TIMEOUT_MS) },
  );
  if (!response.ok) throw new Error(`FX request failed with status ${response.status}`);
  const data = (await response.json()) as { rates?: Record<string, number> };
  const rate = data.rates?.[symbol];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`FX rate ${base}->${symbol} missing from response`);
  }
  rateCache.set(key, { rate, expiresAt: Date.now() + FX_CACHE_MS });
  return rate;
}

function convertCents(cents: number | null | undefined, rate: number): number | null {
  if (cents === null || cents === undefined) return null;
  return Math.round(cents * rate);
}

/**
 * Converts comps into `to`. Comps whose rate cannot be found are dropped, because a list that
 * mixes currencies would give wrong medians downstream.
 */
export async function convertComps(
  comps: Comparable[],
  to: string,
  getRateFn: (from: string, to: string) => Promise<number> = getRate,
): Promise<Comparable[]> {
  const target = to.toUpperCase();
  const rates = new Map<string, number | null>();
  for (const currency of new Set(comps.map((comp) => comp.currency.toUpperCase()))) {
    if (currency === target) continue;
    try {
      rates.set(currency, await getRateFn(currency, target));
    } catch {
      rates.set(currency, null);
    }
  }

  const converted: Comparable[] = [];
  for (const comp of comps) {
    const currency = comp.currency.toUpperCase();
    if (currency === target) {
      converted.push(comp);
      continue;
    }
    const rate = rates.get(currency);
    if (rate === null || rate === undefined) continue;
    converted.push({
      ...comp,
      priceCents: convertCents(comp.priceCents, rate),
      shippingCents: comp.shippingCents === undefined ? undefined : convertCents(comp.shippingCents, rate),
      currency: target,
      originalPriceCents: comp.priceCents,
      originalCurrency: comp.currency,
    });
  }
  return converted;
}
