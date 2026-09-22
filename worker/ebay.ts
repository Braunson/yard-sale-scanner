import { tool } from "@openai/agents";
import { z } from "zod";

export type EbayCredentials = { clientId: string; clientSecret: string };

export type EbayListing = {
  title: string;
  priceCents: number | null;
  shippingCents: number | null;
  currency: string;
  condition: string | null;
  url: string | null;
};

let ebayAppToken: { token: string; expiresAt: number } | null = null;

async function getEbayAppAccessToken({ clientId, clientSecret }: EbayCredentials): Promise<string> {
  if (ebayAppToken && Date.now() < ebayAppToken.expiresAt) {
    return ebayAppToken.token;
  }
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
  });
  if (!response.ok) {
    throw new Error(`eBay token request failed with status ${response.status}`);
  }
  const data = (await response.json()) as { access_token: string; expires_in: number };
  ebayAppToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function parseCents(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

export function createEbayTools(credentials: EbayCredentials | undefined) {
  if (!credentials) return [];

  const searchEbayActiveListings = tool({
    name: "search_ebay_active_listings",
    description:
      'Secondary market-research tool that may run in parallel with retailer-focused web search once the product identity is specific enough. Searches live eBay fixed-price listings and returns asking prices with condition and shipping. These are active listings, never completed sales or the primary retail-price baseline; report them as type "active".',
    parameters: z.object({
      query: z.string().min(2).max(300).describe("Search query with brand, item type, and key attributes."),
      limit: z.number().int().min(1).max(20).default(8),
    }),
    execute: async ({ query, limit }) => {
      try {
        const accessToken = await getEbayAppAccessToken(credentials);
        const response = await fetch(
          `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=${limit}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
            },
          },
        );
        if (!response.ok) {
          return {
            listings: [] as EbayListing[],
            total: 0,
            error: `eBay search failed with status ${response.status}`,
          };
        }
        const data = (await response.json()) as {
          total?: number;
          itemSummaries?: Array<{
            title: string;
            price?: { value: string; currency: string };
            condition?: string;
            itemWebUrl?: string;
            shippingOptions?: Array<{ shippingCost?: { value: string; currency: string } }>;
          }>;
        };
        const listings: EbayListing[] = (data.itemSummaries ?? []).map((summary) => ({
          title: summary.title,
          priceCents: parseCents(summary.price?.value),
          shippingCents: parseCents(summary.shippingOptions?.[0]?.shippingCost?.value),
          currency: summary.price?.currency ?? "USD",
          condition: summary.condition ?? null,
          url: summary.itemWebUrl ?? null,
        }));
        return { listings, total: data.total ?? listings.length };
      } catch (error) {
        return {
          listings: [] as EbayListing[],
          total: 0,
          error: error instanceof Error ? error.message : "eBay search failed",
        };
      }
    },
  });

  return [searchEbayActiveListings];
}
