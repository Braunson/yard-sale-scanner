import type { Market } from "../../src/types";
import { errorMessage, type ItemQuery, MARKET_CONFIG, PROVIDER_TIMEOUT_MS, type ProviderResult } from "./types";

const API = "https://api.discogs.com";
const SOURCE = "discogs";
// Discogs rejects requests without a descriptive User-Agent.
const USER_AGENT = "YardSaleGold/0.1 (resale price lookup)";

type SearchResponse = { results?: Array<{ id: number; title: string; uri?: string }> };
type StatsResponse = {
  lowest_price: { value: number; currency: string } | null;
  num_for_sale: number | null;
};

function empty(error: string | null): ProviderResult {
  return { source: SOURCE, comps: [], total: null, error };
}

export async function searchDiscogs(token: string, item: ItemQuery, market: Market): Promise<ProviderResult> {
  if (item.goodsType !== "media" && !item.barcode) return empty(null);

  const headers = { Authorization: `Discogs token=${token}`, "User-Agent": USER_AGENT };
  const get = async <T>(url: string): Promise<T> => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Discogs request failed with status ${response.status}`);
    return (await response.json()) as T;
  };

  try {
    const search = item.barcode
      ? `barcode=${encodeURIComponent(item.barcode)}`
      : `q=${encodeURIComponent([item.brand, item.model, item.name].filter(Boolean).join(" "))}&type=release`;
    const { results } = await get<SearchResponse>(`${API}/database/search?${search}`);
    const release = results?.[0];
    if (!release) return empty(null);

    const stats = await get<StatsResponse>(
      `${API}/marketplace/stats/${release.id}?curr_abbr=${MARKET_CONFIG[market].currency}`,
    );
    const total = stats.num_for_sale ?? null;
    if (!stats.lowest_price) return { source: SOURCE, comps: [], total, error: null };

    return {
      source: SOURCE,
      comps: [
        {
          title: `${release.title} — lowest of ${total ?? 0} for sale on Discogs`,
          url: release.uri ? `https://www.discogs.com${release.uri}` : null,
          priceCents: Math.round(stats.lowest_price.value * 100),
          currency: stats.lowest_price.currency,
          type: "active",
          // A barcode lookup is exact; a keyword search takes the first result, so it must be scored.
          source: item.barcode ? SOURCE : "discogs-search",
        },
      ],
      total,
      error: null,
    };
  } catch (error) {
    return empty(errorMessage(error, "Discogs lookup failed"));
  }
}
