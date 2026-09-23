export type Stats = {
  framesProcessed: number;
  itemsIdentified: number;
  searchesPerformed: number;
  modelCalls: number;
  lastUpdated: string | null;
};

export type Comparable = {
  title: string;
  url: string | null;
  /** Price in `currency`. Converted from the source currency when needed. */
  priceCents: number | null;
  currency: string;
  type: "retail" | "active" | "sold";
  /** Where the comp came from, for example "ebay", "pricecharting", "discogs", or "web". */
  source?: string | null;
  soldAt?: string | null;
  condition?: string | null;
  shippingCents?: number | null;
  /** Probability (0–1) that this comp is the same item in a comparable condition. */
  matchScore?: number | null;
  originalPriceCents?: number | null;
  originalCurrency?: string | null;
};

export type BoundingBox = {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
};

export type Market = "US" | "CA";
export type GoodsType = "fashion" | "media" | "electronics" | "collectible" | "home" | "tools" | "toys" | "other";

export type PricingPath = "instant" | "research";
export type PricingStatus = "priced" | "researching" | "research_failed";
export type TriageSource = "jev" | "luna" | "reused" | "config";

/** What you really paid and got for a find. All amounts are in the find's currency. */
export type Ledger = {
  purchaseCents: number | null;
  purchasedAt: string | null;
  saleCents: number | null;
  soldAt: string | null;
  /** A platform id from src/markets.ts, for example "ebay" or "local". */
  platformId: string | null;
  feesCents: number | null;
  shippingCents: number | null;
  /** The app's expected sale price on that platform when the sale was recorded, for accuracy checks. */
  estimateCents: number | null;
};

export type DetectedItem = {
  id: string;
  scanSessionId: string;
  fingerprint: string;
  name: string;
  category: string;
  brand: string | null;
  model: string | null;
  description: string;
  condition: string;
  confidence: number;
  observedPriceCents: number | null;
  currency: string;
  estimatedLowCents: number | null;
  estimatedHighCents: number | null;
  retailPriceCents: number | null;
  activePriceCents: number | null;
  soldPriceCents: number | null;
  onlineSaleCents: number | null;
  shippingCents: number | null;
  goodsType: GoodsType;
  /** At least 20 years old, which makes it eligible for Etsy's vintage category. */
  vintage: boolean;
  /** UPC, EAN, or ISBN read from the item, when one was visible. */
  barcode: string | null;
  valueSummary: string;
  pricingPath: PricingPath;
  pricingStatus: PricingStatus;
  triageSource: TriageSource;
  triageConfidence: number | null;
  researchReason: string | null;
  thumbnailUrl: string;
  boundingBox: BoundingBox | null;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  duplicate: boolean;
  comparables: Comparable[];
  ledger: Ledger | null;
};

export type HistoryPage = {
  items: DetectedItem[];
  nextCursor: string | null;
};

export type DeviceDetection = {
  label: string;
  score: number;
  box: BoundingBox;
};

export type DeviceBarcode = {
  /** Digits only: UPC-A, EAN-13, EAN-8, or ISBN-13. */
  value: string;
  format: string;
  box: BoundingBox | null;
};

/** One line of the NDJSON stream returned by POST /api/analyze. */
export type AnalysisEvent =
  | { type: "items"; phase: "identified" | "researched"; frameId: string; items: DetectedItem[] }
  | {
      type: "done";
      frameId: string;
      stats: Stats;
      run: { latencyMs: number; modelCalls: number; searchesPerformed: number; researchedItems: number };
    }
  | { type: "error"; frameId: string; error: string };

export type AgentRunEvent = {
  sequence: number;
  type: string;
  title: string;
  data: unknown;
};

export type AgentRunHistory = {
  frameId: string;
  scanSessionId: string;
  thumbnailUrl: string;
  capturedAt: string;
  completedAt: string | null;
  latencyMs: number;
  itemCount: number;
  modelCalls: number;
  searchesPerformed: number;
  model: string;
  status: "completed" | "failed";
  error: string | null;
  instructions: string;
  input: unknown;
  events: AgentRunEvent[];
  rawResponses: unknown[];
  output: unknown;
  usage: unknown;
};
