import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEbayTokenCache, searchEbayActive, searchEbayByImage } from "./ebay";

const credentials = { clientId: "client", clientSecret: "secret" };

const searchResponse = {
  total: 42,
  itemSummaries: [
    {
      title: "Nintendo Game Boy DMG-01",
      price: { value: "59.99", currency: "CAD" },
      condition: "Used",
      itemWebUrl: "https://www.ebay.ca/itm/1",
      shippingOptions: [{ shippingCost: { value: "12.50", currency: "CAD" } }],
    },
    { title: "Game Boy shell" },
  ],
};

function mockEbay(search: () => Response = () => Response.json(searchResponse)) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("oauth2/token")) return Response.json({ access_token: "token", expires_in: 7200 });
    return search();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => clearEbayTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("searchEbayActive", () => {
  it("searches fixed-price listings in the market's country with its marketplace header", async () => {
    const fetchMock = mockEbay();
    const result = await searchEbayActive(credentials, "game boy dmg-01", "CA", 10);

    const [url, init] = fetchMock.mock.calls[1] ?? [];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("https://api.ebay.com/buy/browse/v1/item_summary/search");
    expect(parsed.searchParams.get("q")).toBe("game boy dmg-01");
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect(parsed.searchParams.get("filter")).toBe("buyingOptions:{FIXED_PRICE},itemLocationCountry:{CA}");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_CA");
    expect(headers.Authorization).toBe("Bearer token");

    expect(result.total).toBe(42);
    expect(result.error).toBeNull();
    expect(result.comps[0]).toEqual({
      title: "Nintendo Game Boy DMG-01",
      url: "https://www.ebay.ca/itm/1",
      priceCents: 5999,
      currency: "CAD",
      type: "active",
      source: "ebay",
      condition: "Used",
      shippingCents: 1250,
    });
    expect(result.comps[1]).toMatchObject({ priceCents: null, currency: "CAD", shippingCents: null, url: null });
  });

  it("uses EBAY_US and the US location filter for the US market", async () => {
    const fetchMock = mockEbay();
    await searchEbayActive(credentials, "walkman", "US");
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(new URL(String(url)).searchParams.get("filter")).toContain("itemLocationCountry:{US}");
    expect(new URL(String(url)).searchParams.get("limit")).toBe("20");
    expect((init?.headers as Record<string, string>)["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_US");
  });

  it("caches the app token per client id", async () => {
    const fetchMock = mockEbay();
    await searchEbayActive(credentials, "a", "US");
    await searchEbayActive(credentials, "b", "US");
    await searchEbayActive({ clientId: "other", clientSecret: "secret" }, "c", "US");
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("oauth2/token"));
    expect(tokenCalls).toHaveLength(2);
  });

  it("returns an empty result instead of throwing on HTTP errors", async () => {
    mockEbay(() => new Response("nope", { status: 500 }));
    const result = await searchEbayActive(credentials, "a", "US");
    expect(result).toEqual({ source: "ebay", comps: [], total: null, error: expect.stringContaining("500") });
  });

  it("returns an empty result when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await searchEbayActive(credentials, "a", "US");
    expect(result.comps).toEqual([]);
    expect(result.error).toBe("network down");
  });
});

describe("searchEbayByImage", () => {
  it("posts bare base64 to search_by_image", async () => {
    const fetchMock = mockEbay();
    const result = await searchEbayByImage(credentials, "data:image/jpeg;base64,QUJD", "CA", 5);

    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe("https://api.ebay.com/buy/browse/v1/item_summary/search_by_image?limit=5");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ image: "QUJD" });
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_CA");
    expect(result.comps[0]?.source).toBe("ebay-image");
    expect(result.source).toBe("ebay-image");
  });
});
