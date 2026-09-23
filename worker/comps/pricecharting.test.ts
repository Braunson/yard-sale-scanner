import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPriceChartingState, priceFieldForCondition, searchPriceCharting } from "./pricecharting";
import type { ItemQuery } from "./types";

const game: ItemQuery = {
  name: "Super Mario Land",
  brand: "Nintendo",
  model: null,
  category: "Video games",
  goodsType: "media",
  condition: "Used",
  barcode: null,
};

const product = {
  status: "success",
  id: "6910",
  "product-name": "Super Mario Land",
  "console-name": "GameBoy",
  "loose-price": 1732,
  "cib-price": 5499,
  "new-price": 0,
  "graded-price": null,
  "manual-only-price": 800,
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearPriceChartingState();
});

describe("priceFieldForCondition", () => {
  it("picks the price that fits the item's condition", () => {
    expect(priceFieldForCondition("Factory sealed")).toBe("new-price");
    expect(priceFieldForCondition("Complete in box, light wear")).toBe("cib-price");
    expect(priceFieldForCondition("Used, cartridge only")).toBe("loose-price");
  });
});

describe("searchPriceCharting", () => {
  it("looks up a barcode directly and keeps only the price for the item's condition", async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json(product));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchPriceCharting("tok", { ...game, goodsType: "other", barcode: "045496730741" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://www.pricecharting.com/api/product?t=tok&upc=045496730741");
    expect(result.error).toBeNull();
    expect(result.comps.map((comp) => [comp.condition, comp.priceCents])).toEqual([["Loose", 1732]]);
    expect(result.comps[0]).toEqual({
      title: "Super Mario Land (GameBoy) — Loose",
      url: "https://www.pricecharting.com/search-products?q=Super%20Mario%20Land&type=prices",
      priceCents: 1732,
      currency: "USD",
      type: "sold",
      source: "pricecharting",
      condition: "Loose",
    });
  });

  it("searches by name and fetches the product only when the search result has no prices", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/products?")
        ? Response.json({ status: "success", products: [{ id: 6910, "product-name": "Super Mario Land" }] })
        : Response.json(product),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchPriceCharting("tok", game);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://www.pricecharting.com/api/products?t=tok&q=Nintendo%20Super%20Mario%20Land",
      "https://www.pricecharting.com/api/product?t=tok&id=6910",
    ]);
    expect(result.comps).toHaveLength(1);
    // A keyword search can return the wrong product, so it is marked for match scoring.
    expect(result.comps[0]?.source).toBe("pricecharting-search");
  });

  it("uses the complete-in-box price, and falls back to loose when the new price is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(product)));
    const cib = await searchPriceCharting("tok", { ...game, barcode: "045496730741", condition: "Complete in box" });
    expect(cib.comps.map((comp) => [comp.condition, comp.priceCents])).toEqual([["Complete in box", 5499]]);
    const sealed = await searchPriceCharting("tok", { ...game, barcode: "045496730741", condition: "Sealed" });
    expect(sealed.comps.map((comp) => comp.condition)).toEqual(["Loose"]);
  });

  it("caches results, so a repeated lookup makes no request", async () => {
    const fetchMock = vi.fn(async () => Response.json(product));
    vi.stubGlobal("fetch", fetchMock);
    await searchPriceCharting("tok", { ...game, barcode: "045496730741" });
    await searchPriceCharting("tok", { ...game, barcode: "045496730741" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses search result prices without a second request", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ status: "success", products: [{ ...product, "console-name": undefined }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchPriceCharting("tok", game);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.comps[0]?.title).toBe("Super Mario Land — Loose");
  });

  it("does not call PriceCharting for goods types it does not cover", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchPriceCharting("tok", { ...game, goodsType: "fashion" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ source: "pricecharting", comps: [], total: null, error: null });
  });

  it("returns an empty result with the API's error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "error", "error-message": "Invalid token" })),
    );
    const result = await searchPriceCharting("bad", game);
    expect(result.comps).toEqual([]);
    expect(result.error).toBe("Invalid token");
  });

  it("returns an empty result on HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    const result = await searchPriceCharting("tok", game);
    expect(result.comps).toEqual([]);
    expect(result.error).toContain("429");
  });
});
