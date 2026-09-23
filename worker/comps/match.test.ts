import { afterEach, describe, expect, it, vi } from "vitest";
import type { Comparable } from "../../src/types";
import { type MatchItem, scoreComps, similarityScore } from "./match";

const gameBoy: MatchItem = {
  name: "Game Boy handheld console",
  brand: "Nintendo",
  model: "DMG-01",
  category: "Video game consoles",
  goodsType: "electronics",
  condition: "Used",
  barcode: null,
  description: "Grey original Game Boy",
};

const comp = (title: string, source = "ebay"): Comparable => ({
  title,
  url: null,
  priceCents: 5000,
  currency: "USD",
  type: "active",
  source,
  condition: "Used",
});

afterEach(() => vi.unstubAllGlobals());

describe("similarityScore", () => {
  it("scores the share of item tokens found in the title", () => {
    expect(similarityScore(gameBoy, "Nintendo Game Boy DMG-01 handheld console grey")).toBe(1);
    expect(similarityScore(gameBoy, "Nintendo DMG01 Game Boy")).toBeCloseTo(5 / 7);
  });

  it("caps the score when the model is missing from the title", () => {
    expect(similarityScore(gameBoy, "Nintendo Game Boy Color handheld console")).toBe(0.4);
  });

  it("caps the score when the brand is missing from the title", () => {
    expect(similarityScore(gameBoy, "Game Boy DMG-01 handheld console clone")).toBe(0.4);
  });

  it("returns 0 when the item has no usable tokens", () => {
    expect(similarityScore({ name: "a", brand: null, model: null }, "anything")).toBe(0);
  });
});

describe("scoreComps", () => {
  it("uses similarity without a Jev key and trusts exact product lookups", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await scoreComps(
      gameBoy,
      [comp("Nintendo Game Boy DMG-01 handheld console"), comp("Game Boy (GameBoy) — Loose", "pricecharting"), comp("Lamp")],
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ scores: [1, 0.9, 0], source: "similarity" });
  });

  it("asks Jev one noul question per comp in a single request", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("jev-latest");
      expect(Object.keys(body.questions)).toEqual(["match_0", "match_1"]);
      expect(body.questions.match_1.type).toBe("noul");
      expect(body.questions.match_1.instructions).toContain("`comps[1]`");
      expect(body.questions.match_1.criteria).toEqual({
        true: "Same product, comparable condition",
        false: "Different product, accessory, lot, or very different condition",
      });
      expect(body.state.comps[0]).toEqual({
        title: "Game Boy",
        condition: "Used",
        price_cents: 5000,
        currency: "USD",
        source: "ebay",
      });
      expect(body.state.item.brand).toBe("Nintendo");
      return Response.json({ answers: { match_0: { noul: 0.92 }, match_1: { noul: 0.05 } } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await scoreComps(gameBoy, [comp("Game Boy"), comp("Game Boy battery cover")], "key");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect((fetchMock.mock.calls[0]?.[1].headers as Record<string, string>).Authorization).toBe("Bearer key");
    expect(result).toEqual({ scores: [0.92, 0.05], source: "jev" });
  });

  it("splits more than 60 comps into batches and keeps their order", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const answers = Object.fromEntries(
        body.state.comps.map((entry: { title: string }, index: number) => [
          `match_${index}`,
          { noul: Number(entry.title) / 100 },
        ]),
      );
      return Response.json({ answers });
    });
    vi.stubGlobal("fetch", fetchMock);

    const comps = Array.from({ length: 75 }, (_, index) => comp(String(index)));
    const result = await scoreComps(gameBoy, comps, "key");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("jev");
    expect(result.scores).toHaveLength(75);
    expect(result.scores[74]).toBeCloseTo(0.74);
  });

  it("falls back to similarity when Jev fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("overloaded", { status: 529 })));
    const result = await scoreComps(gameBoy, [comp("Nintendo Game Boy DMG-01 handheld console")], "key");
    expect(result).toEqual({ scores: [1], source: "similarity" });
  });

  it("falls back to similarity when Jev omits an answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ answers: {} })));
    const result = await scoreComps(gameBoy, [comp("Lamp")], "key");
    expect(result).toEqual({ scores: [0], source: "similarity" });
  });
});

describe("keyword-search comps", () => {
  it("are scored by similarity, not trusted like a barcode lookup", async () => {
    const walkman = { name: "Walkman", brand: "Sony", model: "WM-FX195", category: "Electronics", goodsType: "electronics" as const, condition: "Used", barcode: null, description: "" };
    const wrongGame = { title: "Super Mario Land (GameBoy) — Loose", url: null, priceCents: 1_700, currency: "USD", type: "sold" as const };
    const { scores } = await scoreComps(walkman, [
      { ...wrongGame, source: "pricecharting-search" },
      { ...wrongGame, source: "pricecharting" },
    ], undefined);
    expect(scores[0]).toBeLessThan(0.6);
    expect(scores[1]).toBe(0.9);
  });
});
