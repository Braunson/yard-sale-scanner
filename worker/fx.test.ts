import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comparable } from "../src/types";
import { clearRateCache, convertComps, getRate } from "./fx";

const usdComp: Comparable = {
  title: "Nintendo Game Boy DMG-01",
  url: null,
  priceCents: 1000,
  currency: "USD",
  type: "active",
  source: "ebay",
  shippingCents: 500,
};

beforeEach(() => clearRateCache());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getRate", () => {
  it("returns 1 for the same currency without a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getRate("usd", "USD")).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests the pair from Frankfurter and caches it for 12 hours", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ amount: 1, base: "USD", date: "2026-09-22", rates: { CAD: 1.4089 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await getRate("USD", "CAD")).toBe(1.4089);
    expect(await getRate("USD", "CAD")).toBe(1.4089);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD");

    vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 1);
    await getRate("USD", "CAD");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(getRate("USD", "CAD")).rejects.toThrow("503");
  });

  it("throws when the rate is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ rates: {} })));
    await expect(getRate("USD", "CAD")).rejects.toThrow("missing");
  });
});

describe("convertComps", () => {
  it("converts and rounds price and shipping, keeping the original price", async () => {
    const [converted] = await convertComps([usdComp], "CAD", async () => 1.4089);
    expect(converted).toMatchObject({
      priceCents: 1409,
      shippingCents: 704,
      currency: "CAD",
      originalPriceCents: 1000,
      originalCurrency: "USD",
    });
  });

  it("leaves comps already in the target currency unchanged", async () => {
    const rateFn = vi.fn(async () => 1.4089);
    const cadComp = { ...usdComp, currency: "CAD" };
    const result = await convertComps([cadComp], "CAD", rateFn);
    expect(result[0]).toBe(cadComp);
    expect(rateFn).not.toHaveBeenCalled();
  });

  it("looks up each source currency once", async () => {
    const rateFn = vi.fn(async () => 1.5);
    await convertComps([usdComp, usdComp, { ...usdComp, priceCents: null }], "CAD", rateFn);
    expect(rateFn).toHaveBeenCalledTimes(1);
  });

  it("drops comps whose rate lookup fails instead of mixing currencies", async () => {
    const rateFn = async (from: string) => {
      if (from === "EUR") throw new Error("no rate");
      return 1.4089;
    };
    const result = await convertComps(
      [usdComp, { ...usdComp, currency: "EUR" }, { ...usdComp, currency: "CAD" }],
      "CAD",
      rateFn,
    );
    expect(result.map((comp) => comp.currency)).toEqual(["CAD", "CAD"]);
    expect(result.map((comp) => comp.originalCurrency ?? null)).toEqual(["USD", null]);
  });

  it("uses the Frankfurter rate by default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ rates: { CAD: 1.4089 } })));
    const [converted] = await convertComps([usdComp], "CAD");
    expect(converted?.priceCents).toBe(1409);
  });
});
