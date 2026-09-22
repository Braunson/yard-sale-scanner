import { describe, expect, it } from "vitest";
import { fingerprintSimilarity, normalizeFingerprint } from "./normalize";

describe("normalizeFingerprint", () => {
  it("creates a stable identity without punctuation or irregular whitespace", () => {
    expect(normalizeFingerprint("  Sony  Walkman®  WM-FX195! ")).toBe("sony walkman wm fx195");
  });

  it("caps fingerprints before they reach D1", () => {
    expect(normalizeFingerprint("A".repeat(250))).toHaveLength(180);
  });

  it("matches semantically stable identities despite descriptive wording changes", () => {
    expect(
      fingerprintSimilarity(
        "unbranded black metal glass console table",
        "unbranded black glass top console table",
      ),
    ).toBeGreaterThan(0.72);
    expect(
      fingerprintSimilarity("unbranded rolled area rug", "unbranded rolled beige patterned area rug"),
    ).toBeGreaterThan(0.72);
  });

  it("does not merge distinct objects that only share a generic category", () => {
    expect(fingerprintSimilarity("large round wall mirror", "pink oval wall mirror")).toBe(0);
    expect(fingerprintSimilarity("rolled beige area rug", "gray black abstract area rug")).toBe(0);
  });

  it("retrieves likely duplicates from their names and descriptions despite different fingerprints", () => {
    const jonJosef = [
      "jon josef pointed toe flats",
      "Jon Josef pointed-toe flats",
      "Mint-green pointed-toe slip-on flats with visible Jon Josef branding and Made in Spain marking",
    ].join(" ");
    const mintPumps = [
      "mint green pointed toe pumps",
      "Mint green pointed-toe pumps",
      "Pair of mint green pointed-toe pumps with sculpted high heels and spring shoe trees",
    ].join(" ");

    expect(fingerprintSimilarity(jonJosef, mintPumps)).toBeGreaterThan(0);
  });
});
