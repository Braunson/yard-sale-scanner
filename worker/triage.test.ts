import { afterEach, describe, expect, it, vi } from "vitest";
import { decidePath, type TriageCandidate, triageItems } from "./triage";

const mug: TriageCandidate = {
  name: "Plain ceramic coffee mug",
  category: "Kitchen",
  brand: null,
  model: null,
  description: "White mug",
  condition: "Good",
  observedPriceCents: 50,
  quickLowCents: 50,
  quickHighCents: 200,
  pricingHint: "instant",
  researchReason: "Generic mug",
};

const choice = (instant: number) => ({
  type: "choice" as const,
  choice: instant >= 0.5 ? "instant" : "research",
  probabilities: { instant, research: 1 - instant },
  confidence: Math.abs(instant - 0.5) * 2,
});

afterEach(() => vi.unstubAllGlobals());

describe("decidePath", () => {
  it("prices instantly only when Jev is confident", () => {
    expect(decidePath(mug, choice(0.9))).toEqual({ path: "instant", source: "jev", confidence: 0.9 });
    expect(decidePath(mug, choice(0.6)).path).toBe("research");
  });

  it("always researches items that might be valuable or have no high estimate", () => {
    expect(decidePath({ ...mug, quickHighCents: null }, choice(0.99)).path).toBe("research");
    expect(decidePath({ ...mug, quickHighCents: null }, null).path).toBe("research");
    expect(decidePath({ ...mug, quickHighCents: 8_000 }, choice(0.99))).toEqual({
      path: "research",
      source: "jev",
      confidence: null,
    });
    expect(decidePath({ ...mug, quickHighCents: 8_000 }, null).path).toBe("research");
  });

  it("falls back to Luna's hint without a Jev answer", () => {
    expect(decidePath(mug, null)).toEqual({ path: "instant", source: "luna", confidence: null });
    expect(decidePath({ ...mug, pricingHint: "research" }, null).path).toBe("research");
  });
});

describe("triageItems", () => {
  it("does not call Jev without an API key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const run = await triageItems([mug], { apiKey: undefined, mode: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run.decisions[0]?.source).toBe("luna");
  });

  it("asks Jev one choice question per item in a single request", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(Object.keys(body.questions)).toEqual(["path_0", "path_1"]);
      expect(body.model).toBe("jev-latest");
      return Response.json({ answers: { path_0: choice(0.95), path_1: choice(0.1) } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const run = await triageItems([mug, { ...mug, name: "Nintendo Game Boy" }], { apiKey: "key", mode: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(run.decisions.map((decision) => decision.path)).toEqual(["instant", "research"]);
  });

  it("falls back to Luna when Jev fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("overloaded", { status: 529 })));
    const run = await triageItems([mug], { apiKey: "key", mode: undefined });
    expect(run.decisions[0]).toEqual({ path: "instant", source: "luna", confidence: null });
    expect(run.jevError).toContain("529");
  });

  it("researches every item, without calling Jev, when PRICING_TRIAGE is research_all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const run = await triageItems([mug, mug], { apiKey: "key", mode: "research_all" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run.decisions).toEqual([
      { path: "research", source: "config", confidence: null },
      { path: "research", source: "config", confidence: null },
    ]);
  });
});
