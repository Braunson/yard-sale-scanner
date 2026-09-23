import { Buffer } from "node:buffer";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type {
  AgentRunEvent,
  AgentRunHistory,
  AnalysisEvent,
  Comparable,
  DetectedItem,
  DeviceBarcode,
  DeviceDetection,
  HistoryPage,
  Market,
  Stats,
} from "../src/types";
import { HISTORY_PAGE_SIZE, HistoryQueryError, historyQuery } from "./history";
import {
  AGENT_INSTRUCTIONS,
  type AgentRunAudit,
  buildAgentInputText,
  identifyFrame,
  type IdentifiedItem,
  researchItems,
} from "./agent";
import { appStats, frameRuns, items, scanSessions, valuationSources } from "./db/schema";
import { fingerprintSimilarity, normalizeFingerprint } from "./normalize";
import { type TriageDecision, type TriageRun, triageItems } from "./triage";
import { isResearchStale, keepsExistingPricing } from "./research";
import { deviceBarcodeForItem, isValidBarcode, lookupBarcode } from "./comps/identity";
import { finalizeComps, MAX_COMPS_PER_ITEM, pricesFromStats, specialistComps } from "./comps/pipeline";
import { MARKET_CONFIG } from "./comps/types";

const MAX_FRAME_BYTES = 2_500_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ ok: true, model: env.OPENAI_MODEL });
      }

      if (request.method === "GET" && url.pathname === "/api/stats") {
        return Response.json(await getStats(env));
      }

      if (request.method === "GET" && url.pathname === "/api/items") {
        return Response.json(await getItems(env, url.searchParams));
      }

      if (request.method === "DELETE" && url.pathname === "/api/items") {
        return Response.json(await deleteAllItems(env));
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/items/")) {
        const itemId = decodeURIComponent(url.pathname.slice("/api/items/".length));
        if (!itemId || itemId.includes("/")) throw new HttpError(400, "Invalid item id.");
        return Response.json(await deleteItem(env, itemId));
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/agent-runs/by-item/")) {
        const itemId = decodeURIComponent(url.pathname.slice("/api/agent-runs/by-item/".length));
        if (!itemId || itemId.includes("/")) throw new HttpError(400, "Invalid item id.");
        return Response.json(await getAgentRunForItem(env, itemId));
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/items/")) {
        const itemId = decodeURIComponent(url.pathname.slice("/api/items/".length));
        if (!itemId || itemId.includes("/")) throw new HttpError(400, "Invalid item id.");
        return Response.json(await getFrameItems(env, itemId));
      }

      if (request.method === "POST" && url.pathname === "/api/sessions") {
        return await createSession(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/analyze") {
        return await analyzeRequest(request, env, ctx);
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/thumbnails/")) {
        return await serveThumbnail(url, env);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof HistoryQueryError ? 400 : 500;
      const message = error instanceof Error ? error.message : "Unexpected error";
      console.error(JSON.stringify({ message: "request failed", path: url.pathname, status, error: message }));
      return Response.json({ error: message }, { status });
    }
  },
} satisfies ExportedHandler<Env>;

async function createSession(request: Request, env: Env): Promise<Response> {
  const body = await request.json<unknown>();
  if (!isRecord(body) || typeof body.id !== "string") {
    throw new HttpError(400, "A session id is required.");
  }

  const sourceType = body.sourceType === "video" || body.sourceType === "image" ? body.sourceType : "camera";
  const sourceName = typeof body.sourceName === "string" ? body.sourceName.slice(0, 240) : null;
  const startedAt = new Date().toISOString();
  const db = drizzle(env.DB);

  await db
    .insert(scanSessions)
    .values({ id: body.id, sourceType, sourceName, startedAt })
    .onConflictDoNothing();

  return Response.json({ id: body.id, sourceType, sourceName, startedAt }, { status: 201 });
}

async function analyzeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === "your_openai_api_key_here") {
    throw new HttpError(503, "Add your OpenAI API key to .dev.vars before scanning.");
  }

  const started = Date.now();
  const form = await request.formData();
  const image = form.get("image");
  const sessionId = form.get("sessionId");
  const capturedAtValue = form.get("capturedAt");
  const findCriteriaValue = form.get("findCriteria");

  if (!(image instanceof File) || !image.type.startsWith("image/")) {
    throw new HttpError(400, "A JPEG or WebP frame is required.");
  }
  if (image.size > MAX_FRAME_BYTES) {
    throw new HttpError(413, "Frame exceeds the 2.5 MB limit.");
  }
  if (typeof sessionId !== "string" || !sessionId) {
    throw new HttpError(400, "A session id is required.");
  }
  if (findCriteriaValue !== null && typeof findCriteriaValue !== "string") {
    throw new HttpError(400, "Find criteria must be text.");
  }
  const findCriteria = (findCriteriaValue ?? "").slice(0, 1000);
  const deviceDetections = parseDeviceDetections(form.get("deviceDetections"));
  const market: Market = form.get("market") === "CA" ? "CA" : "US";
  const currency = MARKET_CONFIG[market].currency;
  const barcodes = parseBarcodes(form.get("barcodes"));
  // Barcode identity lookups run while Luna identifies the frame; research uses the results.
  const barcodeIdentities = Promise.all(barcodes.map((barcode) => lookupBarcode(barcode.value)));

  const capturedAt =
    typeof capturedAtValue === "string" && !Number.isNaN(Date.parse(capturedAtValue))
      ? new Date(capturedAtValue).toISOString()
      : new Date().toISOString();
  const frameId = crypto.randomUUID();
  const extension = image.type === "image/webp" ? "webp" : "jpg";
  const thumbnailKey = `frames/${sessionId}/${frameId}.${extension}`;
  const bytes = await image.arrayBuffer();
  const imageDataUrl = `data:${image.type};base64,${Buffer.from(bytes).toString("base64")}`;
  const db = drizzle(env.DB);

  await db
    .insert(scanSessions)
    .values({ id: sessionId, sourceType: "camera", sourceName: null, startedAt: capturedAt })
    .onConflictDoNothing();
  await env.THUMBNAILS.put(thumbnailKey, bytes, {
    httpMetadata: { contentType: image.type, cacheControl: "private, max-age=31536000, immutable" },
  });

  // Items are streamed as NDJSON: quick prices first, then researched prices for items that need them.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event: AnalysisEvent) => {
    writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {
      // The client went away. Keep going so the frame is still saved and researched.
    });
  };

  const pipeline = (async () => {
    let modelCalls = 0;
    let searchesPerformed = 0;
    let runRecorded = false;
    const savedRows = new Map<string, SavedItem>();
    try {
      const identified = await identifyFrame({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL,
        imageDataUrl,
        db,
        sessionId,
        findCriteria,
        deviceDetections,
        market,
        barcodes,
      });
      modelCalls += identified.modelCalls;
      searchesPerformed += identified.searchesPerformed;

      const triage = await triageItems(identified.output, {
        apiKey: env.TYPESAFE_API_KEY || undefined,
        mode: env.PRICING_TRIAGE,
      });

      const knownFingerprints = await db
        .select({ id: items.id, fingerprint: items.fingerprint })
        .from(items)
        .orderBy(desc(items.lastSeenAt))
        .limit(250);
      const frameFingerprints = new Set<string>();
      for (const [index, candidate] of identified.output.entries()) {
        const saved = await saveIdentifiedItem(db, {
          candidate,
          decision: triage.decisions[index]!,
          knownFingerprints,
          frameFingerprints,
          sessionId,
          thumbnailKey,
          capturedAt,
          currency,
          deviceBarcodes: barcodes,
        });
        if (saved) savedRows.set(saved.row.id, saved);
      }

      const identifiedItems = await hydrateItems(env, [...savedRows.values()].map((saved) => saved.row));
      for (const item of identifiedItems) item.duplicate = savedRows.get(item.id)?.duplicate ?? item.duplicate;
      send({ type: "items", phase: "identified", frameId, items: identifiedItems });

      const toResearch = [...savedRows.values()].filter((saved) => saved.needsResearch);
      let research: Awaited<ReturnType<typeof researchItems>> | null = null;
      let researchError: string | null = null;
      const compsAudit: Array<{ item: string; comps: number; matchSource: string | null; errors: string[] }> = [];
      if (toResearch.length > 0) {
        const ebayCredentials =
          env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET
            ? { clientId: env.EBAY_CLIENT_ID, clientSecret: env.EBAY_CLIENT_SECRET }
            : undefined;
        const matchItems = toResearch.map((saved) => ({ ...saved.candidate, barcode: saved.row.barcode }));
        const toolComps = matchItems.map(() => [] as Comparable[]);
        let toolCompsClosed = false;
        // Exact-product lookups need no model, so they run next to the research agent.
        const frameBase64 = identified.output.length === 1 ? imageDataUrl.slice(imageDataUrl.indexOf(",") + 1) : null;
        const specialist = Promise.all(matchItems.map((item) =>
          specialistComps(item, market, {
            priceChartingToken: env.PRICECHARTING_TOKEN || undefined,
            discogsToken: env.DISCOGS_TOKEN || undefined,
            ebayCredentials,
          }, frameBase64),
        ));
        try {
          research = await researchItems({
            apiKey: env.OPENAI_API_KEY,
            model: env.OPENAI_MODEL,
            imageDataUrl,
            items: toResearch.map((saved) => ({ ...saved.candidate, barcode: saved.row.barcode, currency })),
            market,
            barcodeIdentities: await barcodeIdentities,
            ebayCredentials,
            onComps: (index, comps) => {
              // A tool call still running after research failed must not change comps being finalized.
              if (!toolCompsClosed) toolComps[index]?.push(...comps);
            },
          });
          modelCalls += research.modelCalls;
          searchesPerformed += research.searchesPerformed;
        } catch (error) {
          researchError = error instanceof Error ? error.message : "Research failed";
          console.error(JSON.stringify({ message: "item research failed", frameId, error: researchError }));
        }
        const specialistResults = await specialist;
        toolCompsClosed = true;

        const researchedAt = new Date().toISOString();
        const updatedRows: Array<typeof items.$inferSelect> = [];
        for (const [index, saved] of toResearch.entries()) {
          const valuation = research?.output.find((candidate) => candidate.index === index);
          const { comps, stats, matchSource } = await finalizeComps({
            item: matchItems[index]!,
            market,
            providerComps: [...toolComps[index]!, ...specialistResults[index]!.comps],
            modelComps: (valuation?.comparables ?? []).map((comparable) => ({ ...comparable, source: null })),
            jevApiKey: env.TYPESAFE_API_KEY || undefined,
          });
          compsAudit.push({ item: saved.candidate.name, comps: comps.length, matchSource, errors: specialistResults[index]!.errors });
          const prices = pricesFromStats(stats, {
            soldPriceCents: valuation?.soldPriceCents ?? saved.row.soldPriceCents,
            activePriceCents: valuation?.activePriceCents ?? saved.row.activePriceCents,
            onlineSaleCents: valuation?.onlineSaleCents ?? saved.row.onlineSaleCents,
            retailPriceCents: valuation?.retailPriceCents ?? saved.row.retailPriceCents,
          });
          // Comps found by code still improve the price when the research model failed.
          const [updated] = valuation
            ? await db
                .update(items)
                .set({
                  ...prices,
                  estimatedLowCents: valuation.estimatedLowCents,
                  estimatedHighCents: valuation.estimatedHighCents,
                  shippingCents: valuation.shippingCents,
                  valueSummary: valuation.valueSummary,
                  pricingPath: "research",
                  pricingStatus: "priced",
                  researchedAt,
                })
                .where(ownsResearch(saved.row))
                .returning()
            : await db
                .update(items)
                .set({ ...prices, pricingStatus: "research_failed" })
                .where(ownsResearch(saved.row))
                .returning();
          if (!updated) continue;
          updatedRows.push(updated);
          // The consolidated list replaces older comps, so repeated research does not pile up duplicates.
          const rows = comps.map((comparable) => ({
            id: crypto.randomUUID(),
            itemId: updated.id,
            sourceType: comparable.type,
            title: comparable.title.slice(0, 500),
            url: comparable.url,
            priceCents: comparable.priceCents,
            currency: comparable.currency,
            source: comparable.source ?? null,
            soldAt: comparable.soldAt ?? null,
            condition: comparable.condition ?? null,
            shippingCents: comparable.shippingCents ?? null,
            matchScore: comparable.matchScore ?? null,
            originalPriceCents: comparable.originalPriceCents ?? null,
            originalCurrency: comparable.originalCurrency ?? null,
            capturedAt,
          }));
          // D1 allows 100 bound parameters per statement, so insert a few rows at a time in one batch.
          const rowsPerInsert = Math.floor(100 / Object.keys(rows[0] ?? { id: "" }).length);
          const inserts = [];
          for (let start = 0; start < rows.length; start += rowsPerInsert) {
            inserts.push(db.insert(valuationSources).values(rows.slice(start, start + rowsPerInsert)));
          }
          await db.batch([db.delete(valuationSources).where(eq(valuationSources.itemId, updated.id)), ...inserts]);
        }
        const researchedItems = await hydrateItems(env, updatedRows);
        for (const item of researchedItems) item.duplicate = savedRows.get(item.id)?.duplicate ?? item.duplicate;
        send({ type: "items", phase: "researched", frameId, items: researchedItems });
      }

      if (savedRows.size === 0) {
        await env.THUMBNAILS.delete(thumbnailKey);
        console.info(JSON.stringify({
          message: "frame analysis returned no items",
          frameId,
          sessionId,
          capturedAt,
          latencyMs: Date.now() - started,
          model: env.OPENAI_MODEL,
          modelCalls,
          searchesPerformed,
        }));
      }

      const latencyMs = Date.now() - started;
      const audit = combineAudits(identified.audit, triage, research?.audit ?? null, researchError, compsAudit);
      await db.insert(frameRuns).values({
        id: frameId,
        scanSessionId: sessionId,
        thumbnailKey,
        capturedAt,
        completedAt: new Date().toISOString(),
        latencyMs,
        itemCount: savedRows.size,
        modelCalls,
        searchesPerformed,
        model: env.OPENAI_MODEL,
        instructions: audit.instructions,
        inputJson: JSON.stringify(audit.input),
        eventsJson: JSON.stringify(audit.events),
        rawResponsesJson: JSON.stringify(audit.rawResponses),
        outputJson: JSON.stringify(audit.output),
        usageJson: JSON.stringify(audit.usage),
        status: "completed",
        error: researchError,
      });
      await incrementStats(env, { frames: 1, items: savedRows.size, searches: searchesPerformed, modelCalls });
      runRecorded = true;

      send({
        type: "done",
        frameId,
        stats: await getStats(env),
        run: { latencyMs, modelCalls, searchesPerformed, researchedItems: toResearch.length },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Frame analysis failed";
      console.error(JSON.stringify({ message: "frame analysis failed", frameId, error: message }));
      const cleanup: Array<Promise<unknown>> = [];
      if (savedRows.size > 0) {
        // Saved finds keep their thumbnail; research this frame owns falls back to its quick price.
        for (const saved of savedRows.values()) {
          if (saved.needsResearch) {
            cleanup.push(db.update(items).set({ pricingStatus: "research_failed" }).where(ownsResearch(saved.row)));
          }
        }
      } else {
        cleanup.push(env.THUMBNAILS.delete(thumbnailKey));
      }
      if (!runRecorded) {
        cleanup.push(
          db.insert(frameRuns).values({
            id: frameId,
            scanSessionId: sessionId,
            thumbnailKey,
            capturedAt,
            completedAt: new Date().toISOString(),
            latencyMs: Date.now() - started,
            itemCount: savedRows.size,
            modelCalls,
            searchesPerformed,
            model: env.OPENAI_MODEL,
            instructions: AGENT_INSTRUCTIONS,
            inputJson: JSON.stringify({
              role: "user",
              content: [
                { type: "input_text", text: buildAgentInputText(findCriteria, deviceDetections, market, barcodes) },
                { type: "input_image", image: "[frame stored in R2]", detail: "high" },
              ],
            }),
            eventsJson: "[]",
            rawResponsesJson: "[]",
            outputJson: "null",
            usageJson: "null",
            status: "failed",
            error: message.slice(0, 1000),
          }),
          incrementStats(env, { frames: 1, items: savedRows.size, searches: searchesPerformed, modelCalls }),
        );
      }
      await Promise.allSettled(cleanup);
      send({ type: "error", frameId, error: message });
    } finally {
      await writer.close().catch(() => undefined);
    }
  })();
  ctx.waitUntil(pipeline);

  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

type SavedItem = { row: typeof items.$inferSelect; candidate: IdentifiedItem; duplicate: boolean; needsResearch: boolean };


async function saveIdentifiedItem(
  db: ReturnType<typeof drizzle>,
  options: {
    candidate: IdentifiedItem;
    decision: TriageDecision;
    knownFingerprints: Array<{ id: string; fingerprint: string }>;
    /** Fingerprints already saved from this frame; a second candidate for the same object is dropped. */
    frameFingerprints: Set<string>;
    sessionId: string;
    thumbnailKey: string;
    capturedAt: string;
    /** The market currency; every price for a new find is in this currency. */
    currency: string;
    /** Barcodes the device read in this frame; the only codes an item may have. */
    deviceBarcodes: DeviceBarcode[];
  },
): Promise<SavedItem | null> {
  const { candidate, decision, knownFingerprints, capturedAt } = options;
  const proposedFingerprint = normalizeFingerprint(candidate.fingerprint || candidate.name);
  if (!proposedFingerprint) return null;

  const lunaMatch = candidate.previousMatchId
    ? knownFingerprints.find((known) => known.id === candidate.previousMatchId)
    : undefined;
  const fingerprintFallback = knownFingerprints
    .map((known) => ({ ...known, score: fingerprintSimilarity(proposedFingerprint, known.fingerprint) }))
    .filter((known) => known.score >= 0.72)
    .sort((left, right) => right.score - left.score)[0];
  const previousMatch = lunaMatch ?? fingerprintFallback;
  const fingerprint = previousMatch?.fingerprint ?? proposedFingerprint;
  if (options.frameFingerprints.has(fingerprint)) return null;
  options.frameFingerprints.add(fingerprint);

  const identity = {
    name: candidate.name,
    category: candidate.category,
    brand: candidate.brand,
    model: candidate.model,
    description: candidate.description,
    condition: candidate.condition,
    confidence: candidate.confidence,
    observedPriceCents: candidate.observedPriceCents,
    currency: options.currency,
    goodsType: candidate.goodsType,
    vintage: candidate.vintage,
    barcode: deviceBarcodeForItem(candidate.barcode, candidate.boundingBox, options.deviceBarcodes),
    thumbnailKey: options.thumbnailKey,
    boxXMin: candidate.boundingBox.xMin,
    boxYMin: candidate.boundingBox.yMin,
    boxXMax: candidate.boundingBox.xMax,
    boxYMax: candidate.boundingBox.yMax,
    rawJson: JSON.stringify(candidate),
    lastSeenAt: capturedAt,
  };
  const { currency: _newCurrency, ...identityUpdate } = identity;
  const pricing = {
    estimatedLowCents: candidate.quickLowCents,
    estimatedHighCents: candidate.quickHighCents,
    retailPriceCents: null,
    activePriceCents: null,
    soldPriceCents: null,
    onlineSaleCents: candidate.onlineSaleCents,
    shippingCents: candidate.shippingCents,
    valueSummary: candidate.quickSummary,
    pricingPath: decision.path,
    pricingStatus: decision.path === "research" ? ("researching" as const) : ("priced" as const),
    triageSource: decision.source,
    triageConfidence: decision.confidence,
    researchReason: candidate.researchReason,
    researchedAt: null,
    researchStartedAt: decision.path === "research" ? capturedAt : null,
  };

  // A new row is inserted with its pricing. For an existing row the conflict update only refreshes
  // identity, so a stale read can never overwrite pricing that another frame just wrote.
  const proposedId = crypto.randomUUID();
  const [upserted] = await db
    .insert(items)
    .values({
      id: proposedId,
      scanSessionId: options.sessionId,
      fingerprint,
      ...identity,
      ...pricing,
      firstSeenAt: capturedAt,
      seenCount: 1,
    })
    .onConflictDoUpdate({
      target: items.fingerprint,
      set: { ...identityUpdate, seenCount: sql`${items.seenCount} + 1` },
    })
    .returning();
  if (!upserted) throw new Error("D1 did not return the saved item.");
  const duplicate = proposedId !== upserted.id;
  if (!duplicate) {
    knownFingerprints.push({ id: upserted.id, fingerprint });
    return { row: upserted, candidate, duplicate, needsResearch: upserted.pricingStatus === "researching" };
  }

  // A saved find keeps the currency it was priced in. Seen again in another market, it keeps its
  // prices and comps, so ledger amounts and comps never change currency.
  if (upserted.currency !== options.currency || keepsExistingPricing(upserted, decision, capturedAt)) {
    return { row: upserted, candidate, duplicate, needsResearch: false };
  }
  // Claim the row: the new pricing applies only if nobody changed the pricing state since the
  // upsert read it. Of two frames that race, only the winner researches.
  const [claimed] = await db
    .update(items)
    .set(pricing)
    .where(and(
      eq(items.id, upserted.id),
      eq(items.pricingStatus, upserted.pricingStatus),
      sql`${items.researchStartedAt} IS ${upserted.researchStartedAt}`,
      sql`${items.researchedAt} IS ${upserted.researchedAt}`,
    ))
    .returning();
  if (claimed) return { row: claimed, candidate, duplicate, needsResearch: claimed.pricingStatus === "researching" };
  const current = await db.select().from(items).where(eq(items.id, upserted.id)).limit(1).then((rows) => rows[0]);
  return { row: current ?? upserted, candidate, duplicate, needsResearch: false };
}

/**
 * Only the frame that claimed the research may finish it. A later frame that restarts stale
 * research sets a new start time, so a late result from the old run no longer matches.
 */
function ownsResearch(row: typeof items.$inferSelect) {
  return and(
    eq(items.id, row.id),
    eq(items.pricingStatus, "researching"),
    sql`${items.researchStartedAt} IS ${row.researchStartedAt}`,
  );
}


function combineAudits(
  identify: AgentRunAudit,
  triage: TriageRun,
  research: AgentRunAudit | null,
  researchError: string | null,
  compsAudit: unknown[] = [],
): AgentRunAudit {
  const events = [
    ...identify.events.map((event) => ({ ...event, title: `Identify · ${event.title}` })),
    {
      sequence: 0,
      type: "triage",
      title: `Triage · ${{ jev: "Jev", luna: "Luna hint", config: "Research all", reused: "Reused" }[triage.decisions[0]?.source ?? "luna"]}`,
      data: triage,
    },
    ...(research?.events ?? []).map((event) => ({ ...event, title: `Research · ${event.title}` })),
    ...(compsAudit.length > 0 ? [{ sequence: 0, type: "comps", title: "Comps · Matched and priced", data: compsAudit }] : []),
    ...(researchError ? [{ sequence: 0, type: "error", title: "Research · Failed", data: { error: researchError } }] : []),
  ].map((event, sequence) => ({ ...event, sequence }));

  return {
    instructions: research
      ? `${identify.instructions}\n\n--- Research stage ---\n\n${research.instructions}`
      : identify.instructions,
    input: { identify: identify.input, research: research?.input ?? null },
    events,
    rawResponses: [...identify.rawResponses, ...(research?.rawResponses ?? [])],
    output: { identify: identify.output, triage: triage.decisions, research: research?.output ?? null },
    usage: { identify: identify.usage, research: research?.usage ?? null },
  };
}

function parseDeviceDetections(value: ReturnType<FormData["get"]>): DeviceDetection[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is DeviceDetection =>
        isRecord(entry) &&
        typeof entry.label === "string" &&
        typeof entry.score === "number" &&
        isRecord(entry.box) &&
        ["xMin", "yMin", "xMax", "yMax"].every((key) => typeof (entry.box as Record<string, unknown>)[key] === "number"),
      )
      .slice(0, 20)
      .map((entry) => ({
        label: entry.label.slice(0, 40),
        score: Math.min(1, Math.max(0, entry.score)),
        box: {
          xMin: clampCoordinate(entry.box.xMin),
          yMin: clampCoordinate(entry.box.yMin),
          xMax: clampCoordinate(entry.box.xMax),
          yMax: clampCoordinate(entry.box.yMax),
        },
      }));
  } catch {
    return [];
  }
}

function parseBarcodes(value: ReturnType<FormData["get"]>): DeviceBarcode[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is { value: string; format?: unknown; box?: unknown } => isRecord(entry) && typeof entry.value === "string")
      .map((entry) => ({ ...entry, value: entry.value.replace(/\D/g, "") }))
      .filter((entry) => isValidBarcode(entry.value))
      .slice(0, 5)
      .map((entry) => {
        const box = isRecord(entry.box) && ["xMin", "yMin", "xMax", "yMax"].every((key) => typeof (entry.box as Record<string, unknown>)[key] === "number")
          ? (entry.box as DeviceBarcode["box"] & object)
          : null;
        return {
          value: entry.value,
          format: typeof entry.format === "string" ? entry.format.slice(0, 20) : "unknown",
          box: box && {
            xMin: clampCoordinate(box.xMin),
            yMin: clampCoordinate(box.yMin),
            xMax: clampCoordinate(box.xMax),
            yMax: clampCoordinate(box.yMax),
          },
        };
      });
  } catch {
    return [];
  }
}

function clampCoordinate(value: number): number {
  return Math.min(1000, Math.max(0, Math.round(value)));
}

async function getItems(env: Env, params: URLSearchParams): Promise<HistoryPage> {
  const db = drizzle(env.DB);
  const rows = await historyQuery(db, params);
  const page = rows.slice(0, HISTORY_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: await hydrateItems(env, page),
    nextCursor: rows.length > HISTORY_PAGE_SIZE && last
      ? JSON.stringify({ lastSeenAt: last.lastSeenAt, id: last.id })
      : null,
  };
}

async function deleteItem(env: Env, itemId: string): Promise<{ deletedId: string }> {
  const db = drizzle(env.DB);
  const storedItem = await db
    .select({ id: items.id, thumbnailKey: items.thumbnailKey })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!storedItem) throw new HttpError(404, "Find not found.");

  await db.delete(items).where(eq(items.id, itemId));
  const thumbnailStillUsed = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.thumbnailKey, storedItem.thumbnailKey))
    .limit(1)
    .then((rows) => rows.length > 0);
  if (!thumbnailStillUsed) await deleteThumbnailKeys(env, [storedItem.thumbnailKey]);

  return { deletedId: itemId };
}

async function deleteAllItems(env: Env): Promise<{ deleted: number }> {
  const db = drizzle(env.DB);
  const storedItems = await db.select({ id: items.id, thumbnailKey: items.thumbnailKey }).from(items);
  await db.delete(items);
  await deleteThumbnailKeys(env, [...new Set(storedItems.map((item) => item.thumbnailKey))]);
  return { deleted: storedItems.length };
}

async function deleteThumbnailKeys(env: Env, keys: string[]): Promise<void> {
  try {
    for (let index = 0; index < keys.length; index += 1_000) {
      await env.THUMBNAILS.delete(keys.slice(index, index + 1_000));
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: "thumbnail cleanup failed after deleting finds",
      keys: keys.length,
      error: error instanceof Error ? error.message : "Unknown R2 error",
    }));
  }
}

async function getFrameItems(env: Env, itemId: string): Promise<DetectedItem[]> {
  const db = drizzle(env.DB);
  const selected = await db.select().from(items).where(eq(items.id, itemId)).limit(1).then((rows) => rows[0]);
  if (!selected) throw new HttpError(404, "Find not found.");
  const rows = await db
    .select()
    .from(items)
    .where(eq(items.thumbnailKey, selected.thumbnailKey))
    .orderBy(desc(items.lastSeenAt));
  return hydrateItems(env, rows);
}

async function getAgentRunForItem(env: Env, itemId: string): Promise<AgentRunHistory> {
  const db = drizzle(env.DB);
  const selected = await db
    .select({ thumbnailKey: items.thumbnailKey })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!selected) throw new HttpError(404, "Find not found.");

  const run = await db
    .select()
    .from(frameRuns)
    .where(eq(frameRuns.thumbnailKey, selected.thumbnailKey))
    .orderBy(desc(frameRuns.capturedAt))
    .limit(1)
    .then((rows) => rows[0]);
  if (!run || !run.instructions) {
    throw new HttpError(404, "Agent activity was not recorded for this older find.");
  }

  return {
    frameId: run.id,
    scanSessionId: run.scanSessionId,
    thumbnailUrl: `/api/thumbnails/${selected.thumbnailKey}`,
    capturedAt: run.capturedAt,
    completedAt: run.completedAt,
    latencyMs: run.latencyMs,
    itemCount: run.itemCount,
    modelCalls: run.modelCalls,
    searchesPerformed: run.searchesPerformed,
    model: run.model ?? "Unknown model",
    status: run.status,
    error: run.error,
    instructions: run.instructions,
    input: parseJson(run.inputJson, null),
    events: parseJson<AgentRunEvent[]>(run.eventsJson, []),
    rawResponses: parseJson<unknown[]>(run.rawResponsesJson, []),
    output: parseJson(run.outputJson, null),
    usage: parseJson(run.usageJson, null),
  };
}

async function hydrateItems(env: Env, rows: Array<typeof items.$inferSelect>): Promise<DetectedItem[]> {
  const db = drizzle(env.DB);
  const ids = rows.map((row) => row.id);
  const sources =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(valuationSources)
          .where(inArray(valuationSources.itemId, ids))
          .orderBy(desc(valuationSources.capturedAt), desc(sql`coalesce(${valuationSources.matchScore}, 0)`));
  const sourceMap = new Map<string, Comparable[]>();
  for (const source of sources) {
    const comparables = sourceMap.get(source.itemId) ?? [];
    if (comparables.length < MAX_COMPS_PER_ITEM) {
      comparables.push({
        title: source.title,
        url: source.url,
        priceCents: source.priceCents,
        currency: source.currency,
        type: source.sourceType,
        source: source.source,
        soldAt: source.soldAt,
        condition: source.condition,
        shippingCents: source.shippingCents,
        matchScore: source.matchScore,
        originalPriceCents: source.originalPriceCents,
        originalCurrency: source.originalCurrency,
      });
      sourceMap.set(source.itemId, comparables);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    scanSessionId: row.scanSessionId,
    fingerprint: row.fingerprint,
    name: row.name,
    category: row.category,
    brand: row.brand,
    model: row.model,
    description: row.description,
    condition: row.condition,
    confidence: row.confidence,
    observedPriceCents: row.observedPriceCents,
    currency: row.currency,
    estimatedLowCents: row.estimatedLowCents,
    estimatedHighCents: row.estimatedHighCents,
    retailPriceCents: row.retailPriceCents,
    activePriceCents: row.activePriceCents,
    soldPriceCents: row.soldPriceCents,
    onlineSaleCents: row.onlineSaleCents,
    shippingCents: row.shippingCents,
    goodsType: row.goodsType,
    vintage: row.vintage,
    barcode: row.barcode,
    valueSummary: row.valueSummary,
    pricingPath: row.pricingPath,
    pricingStatus:
      row.pricingStatus === "researching" && isResearchStale(row.researchStartedAt, new Date().toISOString())
        ? "research_failed"
        : row.pricingStatus,
    triageSource: row.triageSource,
    triageConfidence: row.triageConfidence,
    researchReason: row.researchReason,
    thumbnailUrl: `/api/thumbnails/${row.thumbnailKey}`,
    boundingBox:
      row.boxXMin === null || row.boxYMin === null || row.boxXMax === null || row.boxYMax === null
        ? null
        : { xMin: row.boxXMin, yMin: row.boxYMin, xMax: row.boxXMax, yMax: row.boxYMax },
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    seenCount: row.seenCount,
    duplicate: row.seenCount > 1,
    comparables: sourceMap.get(row.id) ?? [],
  }));
}

async function serveThumbnail(url: URL, env: Env): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice("/api/thumbnails/".length));
  if (!key.startsWith("frames/") || key.includes("..")) {
    throw new HttpError(400, "Invalid thumbnail key.");
  }
  const object = await env.THUMBNAILS.get(key);
  if (!object) throw new HttpError(404, "Thumbnail not found.");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

async function incrementStats(
  env: Env,
  delta: { frames: number; items: number; searches: number; modelCalls: number },
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO app_stats (id, frames_processed, items_identified, searches_performed, model_calls, last_updated)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       frames_processed = frames_processed + excluded.frames_processed,
       items_identified = items_identified + excluded.items_identified,
       searches_performed = searches_performed + excluded.searches_performed,
       model_calls = model_calls + excluded.model_calls,
       last_updated = excluded.last_updated`,
  )
    .bind(delta.frames, delta.items, delta.searches, delta.modelCalls, updatedAt)
    .run();
}

async function getStats(env: Env): Promise<Stats> {
  const db = drizzle(env.DB);
  const row = await db.select().from(appStats).where(eq(appStats.id, 1)).limit(1).then((rows) => rows[0]);
  return {
    framesProcessed: row?.framesProcessed ?? 0,
    itemsIdentified: row?.itemsIdentified ?? 0,
    searchesPerformed: row?.searchesPerformed ?? 0,
    modelCalls: row?.modelCalls ?? 0,
    lastUpdated: row?.lastUpdated ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
