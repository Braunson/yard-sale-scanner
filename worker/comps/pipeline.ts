import { compStats, type CompStats } from "../../src/comps";
import type { Comparable, Market } from "../../src/types";
import { convertComps, getRate } from "../fx";
import { searchDiscogs } from "./discogs";
import { type EbayCredentials, searchEbayByImage } from "./ebay";
import { scoreComps, type MatchItem } from "./match";
import { searchPriceCharting } from "./pricecharting";
import { MARKET_CONFIG } from "./types";

/** The most comps kept for one item, best matches first. */
export const MAX_COMPS_PER_ITEM = 40;

export type ProviderKeys = {
  priceChartingToken?: string;
  discogsToken?: string;
  ebayCredentials?: EbayCredentials;
};

/**
 * Exact-product lookups that do not need the model. They start as soon as an item is sent to
 * research and run next to the research agent.
 */
export async function specialistComps(
  item: MatchItem,
  market: Market,
  keys: ProviderKeys,
  frameBase64: string | null,
): Promise<{ comps: Comparable[]; errors: string[] }> {
  const lookups = await Promise.all([
    keys.priceChartingToken ? searchPriceCharting(keys.priceChartingToken, item) : null,
    keys.discogsToken ? searchDiscogs(keys.discogsToken, item, market) : null,
    // eBay image search sees the whole frame, so it only helps when the frame shows one item.
    keys.ebayCredentials && frameBase64 ? searchEbayByImage(keys.ebayCredentials, frameBase64, market) : null,
  ]);
  const results = lookups.filter((result) => result !== null);
  return {
    comps: results.flatMap((result) => result.comps),
    errors: results.flatMap((result) => (result.error ? [`${result.source}: ${result.error}`] : [])),
  };
}

/**
 * Two keys, so that a listing the model copied from a tool result (often without its URL or
 * condition) is still a duplicate of the structured copy.
 */
function compKeys(comp: Comparable): string[] {
  const titlePrice = `${comp.title.toLowerCase().replace(/\s+/g, " ").trim()}|${comp.priceCents ?? ""}`;
  return comp.url ? [comp.url, titlePrice] : [titlePrice];
}

/**
 * Converts every comp to the market currency, removes duplicates, scores every comp against the
 * item, and computes the statistics. Provider comps win duplicates because they have structured
 * fields. The model's comps are scored too, so a wrong variant it picked does not move the medians.
 */
export async function finalizeComps(options: {
  item: MatchItem;
  market: Market;
  providerComps: Comparable[];
  modelComps: Comparable[];
  jevApiKey: string | undefined;
  getRateFn?: (from: string, to: string) => Promise<number>;
  now?: number;
}): Promise<{ comps: Comparable[]; stats: CompStats; matchSource: "jev" | "similarity" | null }> {
  const currency = MARKET_CONFIG[options.market].currency;
  const convert = (comps: Comparable[]) => convertComps(comps, currency, options.getRateFn ?? getRate);
  const [provider, model] = await Promise.all([convert(options.providerComps), convert(options.modelComps)]);

  const seen = new Set<string>();
  const unique = (comps: Comparable[]) =>
    comps.filter((comp) => {
      const keys = compKeys(comp);
      if (keys.some((key) => seen.has(key))) return false;
      for (const key of keys) seen.add(key);
      return true;
    });
  const all = [...unique(provider), ...unique(model).map((comp) => ({ ...comp, source: comp.source ?? "web" }))];

  let matchSource: "jev" | "similarity" | null = null;
  let scored = all;
  if (all.length > 0) {
    const { scores, source } = await scoreComps(options.item, all, options.jevApiKey);
    matchSource = source;
    scored = all.map((comp, index) => ({ ...comp, matchScore: scores[index] ?? 0 }));
  }

  const comps = scored
    .sort((left, right) => (right.matchScore ?? 0) - (left.matchScore ?? 0))
    .slice(0, MAX_COMPS_PER_ITEM);
  return { comps, stats: compStats(comps, currency, options.now), matchSource };
}

/**
 * Prices computed from comps replace the model's own numbers when there is enough evidence.
 * The model's figures stay as the fallback, so an item with no usable comps still has a price.
 */
export function pricesFromStats(
  stats: CompStats,
  model: { soldPriceCents: number | null; activePriceCents: number | null; onlineSaleCents: number | null; retailPriceCents: number | null },
) {
  const soldMedian = stats.sold?.medianCents ?? null;
  return {
    soldPriceCents: soldMedian ?? model.soldPriceCents,
    activePriceCents: stats.active?.medianCents ?? model.activePriceCents,
    onlineSaleCents: soldMedian !== null && (stats.sold?.count ?? 0) >= 2 ? soldMedian : model.onlineSaleCents,
    retailPriceCents: model.retailPriceCents ?? stats.retail?.medianCents ?? null,
  };
}
