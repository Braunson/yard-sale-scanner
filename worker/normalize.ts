export function normalizeFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

const IGNORED_TOKENS = new Set([
  "a",
  "an",
  "and",
  "for",
  "generic",
  "of",
  "ornate",
  "the",
  "unbranded",
  "unknown",
  "with",
]);

const TOKEN_ALIASES: Record<string, string> = {
  decoration: "decor",
  decorative: "decor",
  tabletop: "top",
};

export function fingerprintSimilarity(left: string, right: string): number {
  const leftTokens = fingerprintTokens(left);
  const rightTokens = fingerprintTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  if (shared < 3) return 0;

  const containment = shared / Math.min(leftTokens.size, rightTokens.size);
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const jaccard = shared / union;
  return containment * 0.65 + jaccard * 0.35;
}

function fingerprintTokens(value: string): Set<string> {
  return new Set(
    normalizeFingerprint(value)
      .split(" ")
      .map((token) => TOKEN_ALIASES[token] ?? token)
      .filter((token) => token && !IGNORED_TOKENS.has(token)),
  );
}
