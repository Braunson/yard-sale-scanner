import type { Comparable, Market } from "../../src/types";
import { errorMessage, MARKET_CONFIG, PROVIDER_TIMEOUT_MS, type ProviderResult } from "./types";

export type EbayCredentials = { clientId: string; clientSecret: string };

const BROWSE_ENDPOINT = "https://api.ebay.com/buy/browse/v1/item_summary";

// Keyed by clientId so two apps in one isolate never share a token.
const appTokens = new Map<string, { token: string; expiresAt: number }>();

export function clearEbayTokenCache(): void {
  appTokens.clear();
}

async function getEbayAppAccessToken({ clientId, clientSecret }: EbayCredentials): Promise<string> {
  const cached = appTokens.get(clientId);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const basic = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`eBay token request failed with status ${response.status}`);
  }
  const data = (await response.json()) as { access_token: string; expires_in: number };
  appTokens.set(clientId, { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 });
  return data.access_token;
}

function parseCents(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

type EbaySearchResponse = {
  total?: number;
  itemSummaries?: Array<{
    title: string;
    price?: { value: string; currency: string };
    condition?: string;
    itemWebUrl?: string;
    shippingOptions?: Array<{ shippingCost?: { value: string; currency: string } }>;
  }>;
};

async function runSearch(
  credentials: EbayCredentials,
  source: string,
  market: Market,
  url: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<ProviderResult> {
  try {
    const accessToken = await getEbayAppAccessToken(credentials);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKET_CONFIG[market].ebayMarketplace,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
      method: init.method,
      headers,
      body: init.body,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { source, comps: [], total: null, error: `eBay search failed with status ${response.status}` };
    }
    const data = (await response.json()) as EbaySearchResponse;
    const comps: Comparable[] = (data.itemSummaries ?? []).map((summary) => ({
      title: summary.title,
      url: summary.itemWebUrl ?? null,
      priceCents: parseCents(summary.price?.value),
      currency: summary.price?.currency ?? MARKET_CONFIG[market].currency,
      type: "active",
      source,
      condition: summary.condition ?? null,
      shippingCents: parseCents(summary.shippingOptions?.[0]?.shippingCost?.value),
    }));
    return { source, comps, total: data.total ?? null, error: null };
  } catch (error) {
    return { source, comps: [], total: null, error: errorMessage(error, "eBay search failed") };
  }
}

export function searchEbayActive(
  credentials: EbayCredentials,
  query: string,
  market: Market,
  limit = 20,
): Promise<ProviderResult> {
  const filter = `buyingOptions:{FIXED_PRICE},itemLocationCountry:{${MARKET_CONFIG[market].country}}`;
  const url = `${BROWSE_ENDPOINT}/search?q=${encodeURIComponent(query)}&limit=${limit}&filter=${encodeURIComponent(filter)}`;
  return runSearch(credentials, "ebay", market, url, { method: "GET" });
}

export function searchEbayByImage(
  credentials: EbayCredentials,
  imageBase64: string,
  market: Market,
  limit = 20,
): Promise<ProviderResult> {
  // eBay wants bare base64, not a data URL.
  const image = imageBase64.replace(/^data:[^,]*,/, "");
  return runSearch(credentials, "ebay-image", market, `${BROWSE_ENDPOINT}/search_by_image?limit=${limit}`, {
    method: "POST",
    body: JSON.stringify({ image }),
  });
}
