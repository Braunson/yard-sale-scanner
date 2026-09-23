import type { Comparable, GoodsType } from "../../src/types";
import { errorMessage, type ItemQuery, PROVIDER_TIMEOUT_MS, type ProviderResult } from "./types";

const API = "https://www.pricecharting.com/api";
/** A barcode lookup is an exact product match; a keyword search takes the first result and must be scored. */
const SOURCE = "pricecharting";
const SEARCH_SOURCE = "pricecharting-search";
/** PriceCharting allows one request per second. */
const MIN_REQUEST_GAP_MS = 1_100;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const QUALIFYING_TYPES = new Set<GoodsType>(["media", "collectible", "toys", "electronics"]);

const PRICE_FIELDS = [
  ["loose-price", "Loose"],
  ["cib-price", "Complete in box"],
  ["new-price", "New"],
  ["graded-price", "Graded"],
  ["box-only-price", "Box only"],
  ["manual-only-price", "Manual only"],
] as const;

type PriceField = (typeof PRICE_FIELDS)[number][0];

/**
 * Each PriceCharting price is for one condition, so only the one that fits the item is a comp.
 * Graded, box-only, and manual-only prices are for other things and are never used.
 */
export function priceFieldForCondition(condition: string): "new-price" | "cib-price" | "loose-price" {
  if (/\b(sealed|unopened|new in box|nib|brand new|factory)\b/i.test(condition)) return "new-price";
  if (/\b(complete|cib|in (the )?box|boxed|with box)\b/i.test(condition)) return "cib-price";
  return "loose-price";
}

let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
const cache = new Map<string, { at: number; result: ProviderResult }>();

/** Runs PriceCharting requests one at a time across the isolate, at most one per second. */
function throttled<T>(request: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return request();
  });
  queue = run.catch(() => undefined);
  return run;
}

export function clearPriceChartingState(): void {
  queue = Promise.resolve();
  lastRequestAt = 0;
  cache.clear();
}

type Product = {
  status?: string;
  "error-message"?: string;
  id?: string | number;
  "product-name"?: string;
  "console-name"?: string;
} & Partial<Record<PriceField, number | string | null>>;

function empty(error: string | null): ProviderResult {
  return { source: SOURCE, comps: [], total: null, error };
}

function pennies(value: number | string | null | undefined): number | null {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function hasPrices(product: Product): boolean {
  return PRICE_FIELDS.some(([field]) => pennies(product[field]) !== null);
}

async function getJson(url: string): Promise<Product & { products?: Product[] }> {
  const response = await throttled(() => fetch(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }));
  if (!response.ok) throw new Error(`PriceCharting request failed with status ${response.status}`);
  const data = (await response.json()) as Product & { products?: Product[] };
  if (data.status === "error") throw new Error(data["error-message"] ?? "PriceCharting returned an error");
  return data;
}

/**
 * PriceCharting allows one request per second, so a lookup makes at most two calls: a search
 * (or UPC lookup) and, only when the search result carries no prices, one product fetch.
 */
export async function searchPriceCharting(token: string, item: ItemQuery): Promise<ProviderResult> {
  if (!item.barcode && !QUALIFYING_TYPES.has(item.goodsType)) return empty(null);
  const cacheKey = item.barcode ? `upc:${item.barcode}` : `q:${[item.brand, item.model, item.name].filter(Boolean).join(" ").toLowerCase()}`;
  const field = priceFieldForCondition(item.condition);
  const cached = cache.get(`${cacheKey}|${field}`);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  try {
    const t = encodeURIComponent(token);
    let product: Product | undefined;
    if (item.barcode) {
      product = await getJson(`${API}/product?t=${t}&upc=${encodeURIComponent(item.barcode)}`);
    } else {
      const query = [item.brand, item.model, item.name].filter(Boolean).join(" ");
      const search = await getJson(`${API}/products?t=${t}&q=${encodeURIComponent(query)}`);
      product = search.products?.[0];
      if (product && !hasPrices(product) && product.id !== undefined) {
        product = await getJson(`${API}/product?t=${t}&id=${encodeURIComponent(String(product.id))}`);
      }
    }
    if (!product?.["product-name"]) return empty(null);

    const name = product["product-name"];
    const consoleName = product["console-name"];
    const label = consoleName ? `${name} (${consoleName})` : name;
    const url = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(name)}&type=prices`;
    const comps: Comparable[] = [];
    // Fall back to the loose price when the matching condition has none.
    const [chosenField, condition] =
      PRICE_FIELDS.find(([candidate]) => candidate === field && pennies(product[candidate]) !== null) ??
      PRICE_FIELDS[0];
    const priceCents = pennies(product[chosenField]);
    if (priceCents !== null) {
      comps.push({
        title: `${label} — ${condition}`,
        url,
        priceCents,
        currency: "USD",
        // PriceCharting prices are built from completed sales.
        type: "sold",
        source: item.barcode ? SOURCE : SEARCH_SOURCE,
        condition,
      });
    }
    const result: ProviderResult = { source: SOURCE, comps, total: null, error: null };
    cache.set(`${cacheKey}|${field}`, { at: Date.now(), result });
    return result;
  } catch (error) {
    return empty(errorMessage(error, "PriceCharting lookup failed"));
  }
}
