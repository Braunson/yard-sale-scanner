import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBarcodeCache, deviceBarcodeForItem, isValidBarcode, lookupBarcode } from "./identity";

afterEach(() => {
  vi.unstubAllGlobals();
  clearBarcodeCache();
});

describe("isValidBarcode", () => {
  it("accepts valid ISBN-13, UPC-A, EAN-13, and EAN-8 codes", () => {
    expect(isValidBarcode("9780306406157")).toBe(true);
    expect(isValidBarcode("978-0-306-40615-7")).toBe(true);
    expect(isValidBarcode("036000291452")).toBe(true);
    expect(isValidBarcode("4006381333931")).toBe(true);
    expect(isValidBarcode("96385074")).toBe(true);
  });

  it("rejects wrong check digits, lengths, and non-digits", () => {
    expect(isValidBarcode("9780306406158")).toBe(false);
    expect(isValidBarcode("036000291453")).toBe(false);
    expect(isValidBarcode("12345")).toBe(false);
    expect(isValidBarcode("03600029145A")).toBe(false);
    expect(isValidBarcode("")).toBe(false);
  });
});

describe("lookupBarcode", () => {
  it("resolves an ISBN through Open Library, including up to two author names", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/isbn/9780306406157.json")) {
        return Response.json({
          title: "Pollution Control",
          publishers: ["Plenum Press"],
          authors: [{ key: "/authors/OL1A" }, { key: "/authors/OL2A" }, { key: "/authors/OL3A" }],
        });
      }
      if (url.endsWith("/authors/OL2A.json")) return new Response("", { status: 404 });
      return Response.json({ name: "Ada Author" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const identity = await lookupBarcode("978-0306406157");

    expect(identity).toEqual({
      barcode: "9780306406157",
      kind: "isbn",
      title: "Pollution Control",
      brand: "Plenum Press",
      authors: ["Ada Author"],
      source: "openlibrary",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://openlibrary.org/authors/OL1A.json");
  });

  it("resolves a UPC through UPCitemdb for identity only", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ items: [{ title: "Wheaties Cereal", brand: "General Mills", lowest_recorded_price: 1 }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const identity = await lookupBarcode("036000291452");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.upcitemdb.com/prod/trial/lookup?upc=036000291452");
    expect(identity).toEqual({
      barcode: "036000291452",
      kind: "upc",
      title: "Wheaties Cereal",
      brand: "General Mills",
      authors: [],
      source: "upcitemdb",
    });
  });

  it("returns nulls instead of throwing when the lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    expect(await lookupBarcode("036000291452")).toEqual({
      barcode: "036000291452",
      kind: "upc",
      title: null,
      brand: null,
      authors: [],
      source: null,
    });
  });

  it("returns nulls when UPCitemdb knows nothing about the code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [] })));
    const identity = await lookupBarcode("036000291452");
    expect(identity.source).toBeNull();
    expect(identity.title).toBeNull();
  });
});

describe("lookupBarcode cache", () => {
  it("keeps a code the service does not know, so it is not looked up on every frame", async () => {
    const fetchMock = vi.fn(async () => Response.json({ code: "OK", total: 0, items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await lookupBarcode("036000291452")).source).toBeNull();
    expect((await lookupBarcode("036000291452")).source).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an ISBN that Open Library returns 404 for", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await lookupBarcode("9780306406157");
    await lookupBarcode("9780306406157");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("looks up a code once, and tries again after a failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValue(Response.json({ code: "OK", items: [{ title: "Ketchup", brand: "Heinz" }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await lookupBarcode("036000291452")).source).toBeNull();
    expect((await lookupBarcode("036000291452")).title).toBe("Ketchup");
    expect((await lookupBarcode("036000291452")).title).toBe("Ketchup");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("deviceBarcodeForItem", () => {
  const item = { xMin: 100, yMin: 100, xMax: 500, yMax: 500 };
  const read = (value: string, box: { xMin: number; yMin: number; xMax: number; yMax: number } | null) => ({ value, format: "ean_13", box });

  it("accepts only codes the device read, and on the item when the position is known", () => {
    expect(deviceBarcodeForItem("978-0-306-40615-7", item, [read("9780306406157", { xMin: 200, yMin: 200, xMax: 300, yMax: 250 })])).toBe("9780306406157");
    expect(deviceBarcodeForItem("9780306406157", item, [read("9780306406157", null)])).toBe("9780306406157");
  });

  it("rejects an invented code and a code that is on another item", () => {
    expect(deviceBarcodeForItem("036000291452", item, [read("9780306406157", null)])).toBeNull();
    expect(deviceBarcodeForItem("9780306406157", item, [read("9780306406157", { xMin: 700, yMin: 700, xMax: 800, yMax: 750 })])).toBeNull();
    expect(deviceBarcodeForItem(null, item, [])).toBeNull();
  });
});
