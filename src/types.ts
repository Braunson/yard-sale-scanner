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
  priceCents: number | null;
  currency: string;
  type: "retail" | "active" | "sold";
};

export type BoundingBox = {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
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
  valueSummary: string;
  thumbnailUrl: string;
  boundingBox: BoundingBox | null;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  duplicate: boolean;
  comparables: Comparable[];
};

export type AnalysisResponse = {
  frameId: string;
  items: DetectedItem[];
  stats: Stats;
  run: {
    latencyMs: number;
    modelCalls: number;
    searchesPerformed: number;
  };
};
