import { afterEach, describe, expect, it, vi } from "vitest";
import { searchDiscogs } from "./discogs";
import type { ItemQuery } from "./types";

const record: ItemQuery = {
  name: "Thriller",
  brand: "Michael Jackson",
  model: null,
  category: "Vinyl records",
  goodsType: "media",
  condition: "Good",
  barcode: null,
};

const searchResult = { results: [{ id: 1234, title: "Michael Jackson - Thriller", uri: "/release/1234-Thriller" }] };

function mockDiscogs(stats: unknown) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    url.includes("/database/search") ? Response.json(searchResult) : Response.json(stats),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("searchDiscogs", () => {
  it("searches by barcode, then reads marketplace stats in the market currency", async () => {
    const fetchMock = mockDiscogs({ lowest_price: { value: 12.5, currency: "CAD" }, num_for_sale: 37 });

    const result = await searchDiscogs("tok", { ...record, goodsType: "other", barcode: "074643811224" }, "CA");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.discogs.com/database/search?barcode=074643811224",
      "https://api.discogs.com/marketplace/stats/1234?curr_abbr=CAD",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Discogs token=tok");
      expect(headers["User-Agent"]).toBe("YardSaleGold/0.1 (resale price lookup)");
    }
    expect(result).toEqual({
      source: "discogs",
      comps: [
        {
          title: "Michael Jackson - Thriller — lowest of 37 for sale on Discogs",
          url: "https://www.discogs.com/release/1234-Thriller",
          priceCents: 1250,
          currency: "CAD",
          type: "active",
          source: "discogs",
        },
      ],
      total: 37,
      error: null,
    });
  });

  it("searches releases by text without a barcode", async () => {
    const fetchMock = mockDiscogs({ lowest_price: { value: 9, currency: "USD" }, num_for_sale: 3 });
    await searchDiscogs("tok", record, "US");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.discogs.com/database/search?q=Michael%20Jackson%20Thriller&type=release",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain("curr_abbr=USD");
  });

  it("returns no comps when nothing is for sale", async () => {
    mockDiscogs({ lowest_price: null, num_for_sale: 0 });
    const result = await searchDiscogs("tok", record, "US");
    expect(result.comps).toEqual([]);
    expect(result.error).toBeNull();
  });

  it("does not call Discogs for non-media items without a barcode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchDiscogs("tok", { ...record, goodsType: "tools" }, "US");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.comps).toEqual([]);
    expect(result.error).toBeNull();
  });

  it("returns an empty result on HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const result = await searchDiscogs("tok", record, "US");
    expect(result.comps).toEqual([]);
    expect(result.error).toContain("401");
  });
});
