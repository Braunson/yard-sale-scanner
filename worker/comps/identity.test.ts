import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBarcodeCache, isValidBarcode, lookupBarcode } from "./identity";

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
