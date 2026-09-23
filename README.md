# Yard Sale Gold

An installable browser/PWA scanner that samples frames from a live camera or uploaded garage-sale footage, sends them to GPT-5.6 Luna through the OpenAI Agents SDK, values visible items, and streams finds into a mobile-first UI.

## Stack

- React 19 + Vite + TypeScript
- TanStack Router for URL-driven navigation and TanStack Query for server-state caching
- Cloudflare Workers and the Cloudflare Vite plugin
- OpenAI Agents SDK with `gpt-5.6-luna`
- TypeSafe Jev (optional) for pricing triage
- MediaPipe Tasks Vision for on-device object detection
- Drizzle ORM + Cloudflare D1
- Cloudflare R2 thumbnails
- Vite PWA service worker and manifest

## Run locally

1. Copy `.dev.vars.example` to `.dev.vars` and replace the placeholder. Only `OPENAI_API_KEY` is required; see [Configuration](#configuration) for the optional values.

   ```dotenv
   OPENAI_API_KEY=your_real_project_key
   TYPESAFE_API_KEY=
   PRICING_TRIAGE=auto
   EBAY_CLIENT_ID=
   EBAY_CLIENT_SECRET=
   PRICECHARTING_TOKEN=
   DISCOGS_TOKEN=
   ```

2. The checked-in `wrangler.jsonc` targets the author's Cloudflare resources and uses remote D1/R2 bindings. For local development, remove `remote: true` from both bindings. Install dependencies and apply local D1 migrations:

   ```bash
   npm install
   npm run db:migrate:local
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open `http://127.0.0.1:5173`. Select a camera for live scanning or snapshots, or upload a photo/video. You can keep your own garage-sale clips in the ignored local `yard-sale-footage/` folder; footage is not included in this repository.

The browser samples compressed frames at a configurable 1–30 second interval and allows up to 100 analyses in flight. Frame images are not bundled with the app.

## Configuration

| Variable | Required | Where | What it does |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | Yes | `.dev.vars` / `wrangler secret put` | Runs GPT-5.6 Luna for identification and research. Scanning returns a 503 error without it. |
| `OPENAI_MODEL` | Yes (set in `wrangler.jsonc`) | `vars` in `wrangler.jsonc` | The model for both agent stages. Default `gpt-5.6-luna`. |
| `TYPESAFE_API_KEY` | No | `.dev.vars` / `wrangler secret put` | Turns on Jev pricing triage. Empty or missing: Luna's own hint decides. If Jev fails or takes more than 4 s, Luna's hint decides. |
| `PRICING_TRIAGE` | No | `.dev.vars` / `wrangler secret put` or `vars` | `auto` (default): cheap common items get an instant price and skip web research. `research_all`: every item gets web research, as before two-stage pricing. Jev is not called. |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | No | `.dev.vars` / `wrangler secret put` | eBay Browse API app keys. Adds eBay active-listing search (eBay.com or eBay.ca, from the market) and eBay image search for single-item frames. |
| `PRICECHARTING_TOKEN` | No | `.dev.vars` / `wrangler secret put` | Paid PriceCharting API token. Adds prices built from completed sales for video games, trading cards, comics, LEGO, and Funko, looked up by barcode or name. |
| `DISCOGS_TOKEN` | No | `.dev.vars` / `wrangler secret put` | Free Discogs personal access token. Adds the lowest current price and listing count for records, CDs, and other media, looked up by barcode or name. |

Every comp source is optional. Without any of them, research uses web search and the model's own comps, as before.

Browser settings, kept in `localStorage` on each device:

- **Market and currency:** United States (USD) or Canada (CAD). New finds are priced in this currency, with USPS or Canada Post shipping, and the fees of that country's platforms. Saved finds keep the currency they were priced in.
- **Minimum profit to buy** (default $10) and **minimum ROI to buy** (default 100%), for the buy / negotiate / pass verdict.
- **On-device detection** (default on): object detection, barcode reading, live price labels, and frame skipping.
- Find criteria, concurrent processing, and live scan frequency.

### Jev is optional

Without `TYPESAFE_API_KEY` the app runs normally. The server never calls TypeSafe, and Luna's `pricingHint` from the identify step does the triage. This hint costs nothing extra, because it comes from the same call.

Two-stage pricing is still on without Jev. Luna can mark a generic, low-value item `instant`, and that item then gets no web research. Set `PRICING_TRIAGE=research_all` to research every item, as the app did before.

## Upgrading from the single-stage version

- **Apply migrations `0004_two_stage_pricing.sql` and `0005_comps_and_markets.sql`** (`npm run db:migrate:local` or `npm run db:migrate:remote`) before you deploy the new Worker. The migration adds pricing columns to `items`. It also marks existing items as researched, so a new scan does not replace their prices.
- **`POST /api/analyze` now returns NDJSON** (`application/x-ndjson`), not one JSON object. See [Analyze stream](#analyze-stream). Scripts that call this endpoint must change.
- **`npm run cf-typegen` reads `.dev.vars`.** Keep `TYPESAFE_API_KEY` and `PRICING_TRIAGE` in `.dev.vars`, even with empty values. If you do not, the regenerated `worker-configuration.d.ts` does not have them and the Worker does not compile.
- **Local dev uses HTTP/1.1.** A browser opens only 6 connections to one origin. Research streams stay open after their concurrency slot is released. If you scan fast on `wrangler dev`, new requests can wait. Production on HTTP/2 does not have this problem.
- The first live scan downloads the MediaPipe WASM from jsDelivr and a 4.5 MB model from Google Cloud Storage. If the download fails, the app sends every frame, as before.

## Routes and state

- `/scan` — camera, snapshots, uploads, and the live findings feed
- `/history` — saved inventory
- `/finds/:itemId?from=scan|history` — shareable item detail modal with its originating view preserved
- `/finds/:itemId/activity?from=scan|history` — the persisted agent activity for the item's latest frame

TanStack Query owns remote stats and inventory data. Camera streams, capture timers, in-flight frame work, and the current live feed remain local React state because they are ephemeral browser state.

## Useful commands

```bash
npm test                 # deterministic unit tests (no Cloudflare credentials needed)
npm run build            # type-check and production build
npm run cf-typegen       # regenerate Worker binding types
npm run db:generate      # generate a migration after schema changes
npm run db:migrate:local # apply migrations to local D1
```

GitHub Actions runs `npm test` and `npm run build` on every pull request and on pushes to `main` (`.github/workflows/ci.yml`). Neither step needs secrets.

## Agent workflow

Each frame runs through three steps, and results stream back as NDJSON so quick prices appear before research finishes:

1. **Identify (Luna, no web).** Finds distinct sellable objects, reads visible price tags, calls `check_previous_scans` for dedupe, returns normalized item coordinates, and gives a quick price, online sale price, and shipping estimate from general knowledge. It also returns a `pricingHint` of `instant` or `research`.
2. **Triage (Jev, optional).** When `TYPESAFE_API_KEY` is set, one TypeSafe Jev call asks a Choice question per item: can it be priced now, or does it need research? An item skips research only when Jev gives `instant` a probability of at least 0.70. Without the key, or if Jev fails, Luna's hint is used. Any item that might be worth $50 or more, or has no high estimate, is always researched. Items researched in the last 14 days reuse that research.

Research state is claimed atomically. When two frames see the same find at the same time, only one runs research; the other uses its result. Each research run records its start time, and only the run with that start time can finish it, so a late result from a stale run cannot overwrite a newer one.
3. **Research (Luna + web + eBay).** Only for items that need it. Searches manufacturers and retailers alongside eBay active listings and returns retail, active-listing, sold, online-sale, shipping, and resale-range data. The saved item is then updated and the client receives the new prices.

Why both models: Jev cannot see images, so Luna must identify the items. Jev is a fast (about 70–500 ms), low-cost classifier with calibrated probabilities, which suits the one yes/no routing decision. Luna's own hint is free because it comes from the same identify call, so Jev is optional.

Exact fingerprints are unique, with conservative token-overlap matching to absorb wording changes. A sanitized per-frame audit record stores prompts, ordered run items for both stages, the triage decisions, tool calls and results, raw model responses, final structured output, and usage. API keys, raw base64 images, encrypted reasoning, and hidden reasoning content are excluded.

## On-device detection

The browser runs MediaPipe EfficientDet-Lite0 (COCO) on the live camera or video at about 5 fps. It draws boxes over the preview and gates automatic captures: a frame is skipped when no sellable object is in view, or when the objects match the last frame sent (same label, IoU ≥ 0.5). A still scene is re-sent every 20 seconds because COCO does not know many sale items. Manual snapshots and uploaded photos are never skipped. The detections are sent with the frame as hints for Luna. You can turn this off in Settings.

## Analyze stream

`POST /api/analyze` (multipart: `image`, `sessionId`, `capturedAt`, `findCriteria`, optional `deviceDetections` JSON) returns one JSON event on each line:

```jsonc
{ "type": "items", "phase": "identified", "frameId": "…", "items": [/* quick prices; research items have pricingStatus "researching" */] }
{ "type": "items", "phase": "researched", "frameId": "…", "items": [/* updated items; only sent when research ran */] }
{ "type": "done", "frameId": "…", "stats": { /* … */ }, "run": { "latencyMs": 0, "modelCalls": 0, "searchesPerformed": 0, "researchedItems": 0 } }
{ "type": "error", "frameId": "…", "error": "message" } // in place of "done"
```

Validation errors before the stream starts, such as a missing image or a missing API key, are still returned as JSON with a 4xx or 5xx status.

Item pricing fields: `pricingPath` (`instant` | `research`), `pricingStatus` (`priced` | `researching` | `research_failed`), `triageSource` (`jev` | `luna` | `reused` | `config`), `triageConfidence`, `researchReason`, `onlineSaleCents`, and `shippingCents`. If research has not finished 10 minutes after it started, the item is shown as `research_failed` with its quick price.

## Comps

Research collects comps from several sources for each item:

| Source | Type | When |
| --- | --- | --- |
| Web search (Luna) | retail, sold, active | Always |
| eBay Browse search | active | eBay keys set; the model runs the query |
| eBay image search | active | eBay keys set and the frame has one item |
| PriceCharting | sold-based, one price for the item's condition (loose, complete in box, or new) | Token set; games, cards, comics, LEGO, Funko, electronics, or a barcode |
| Discogs | active (lowest price) | Token set; media or a barcode |

The code then does the math, not the model:

1. Converts every comp to the market currency with the daily ECB rate from Frankfurter. The original price is kept.
2. Removes duplicates by URL and by title plus price, so a listing the model copied from a tool result counts once.
3. Scores every comp, including the ones the research model picked, for "same product, comparable condition": with Jev when `TYPESAFE_API_KEY` is set, or with a token match on brand, model, and name. A barcode lookup on PriceCharting or Discogs is exact and scores 0.9; a keyword search on them is scored like any other comp. Comps below 0.6, and comps saved before scoring existed, are shown struck through and are not used.
4. Computes the median and range for sold, listed, and retail comps, after removing outliers (Tukey fences) and preferring sales from the last 180 days.
5. Uses the sold median for the online sale price when there are at least 2 sold comps, and the listed median for the active price. Otherwise it keeps the model's figures.

eBay's sold-listing API (Marketplace Insights) is limited to approved partners, so sold evidence comes from PriceCharting and web search.

PriceCharting requests go through one queue at most once a second, as its terms require, and results are cached for 6 hours in each Worker isolate. Barcode identities are cached for 24 hours, because UPCitemdb's free tier allows about 100 lookups a day.

## Barcodes

The browser reads UPC-A, EAN-13, EAN-8, and ISBN barcodes. It uses the native `BarcodeDetector` in Chrome and Android, and the ZXing WebAssembly ponyfill in Safari, iOS, and Firefox. Codes with a bad check digit are ignored. A new barcode always sends a frame, even when the scene has not changed. Barcodes are also read from uploaded photos.

The server looks up each code while Luna identifies the frame: ISBNs with Open Library, and other codes with UPCitemdb (title and brand only; its prices are not reliable). Luna links each code to the item it is on. The server keeps a link only when the device read that code in the frame and, when the code's position is known, its center is inside the item's box. Research and the PriceCharting and Discogs lookups then use the exact identity.

## Live price labels

When a frame's finds arrive, each find is linked to the on-device detection box that overlaps it in that frame. The first match with a live detection needs an IoU of at least 0.5, because the boxes are seconds old by then. After that, the label follows its object as the camera moves (same COCO label, IoU ≥ 0.3). A label is removed 1.5 seconds after its object leaves the view, and finds that arrive more than 10 seconds after capture get no label. Tap a label, or focus it and press Enter, to open the find.

## Where to sell, and buy or pass

The item detail sheet lists the net for each platform in the item's market, after fees and seller-paid shipping:

| Market | Platforms and fees (checked September 2026, most categories) |
| --- | --- |
| US | Local (0%), eBay (13.6% + $0.30 or $0.40), Mercari (10%), Poshmark (fashion and home; $2.95 under $15, else 20%; buyer pays shipping), Facebook shipped (10%, minimum $0.80), Etsy (vintage only; 6.5% + 3% + $0.25 + $0.20) |
| CA | Local (0%), eBay.ca (13.6% + C$0.30 or C$0.40), Poshmark Canada (fashion and home; C$3.95 under C$20, else 20%), Etsy (vintage only; 6.5% + 3% + 1.15% + C$0.25 + about C$0.28) |

Fee schedules are in `src/markets.ts`. Platforms change their fees, so check them from time to time. A platform where the seller pays shipping is left out of the comparison until a shipping estimate exists. Selling online is recommended only when the best online net beats a local sale by at least $5 or 15%.

The **buy / negotiate / pass** verdict uses the best net. The profit target is a number in the item's own currency: $10 means US$10 for a USD find and C$10 for a CAD find. The maximum offer is the lower of "net minus minimum profit" and "net ÷ (1 + minimum ROI)", rounded down to a whole dollar. A tag up to 35% over the maximum gives "negotiate", because yard-sale sellers often take less. Without a tag, the sheet shows only the maximum offer.

The UI reports cumulative frames processed, items identified, searches performed, underlying model calls, frames skipped on the device, and frames still in research. See [FEATURES.md](./FEATURES.md) for live-feed tracking, natural-language filters, eBay integration, and batch processing.

## Cloud deployment

Before deploying your own instance, create a D1 database and R2 bucket, replace the resource names and D1 ID in `wrangler.jsonc`, and replace or remove the author's custom domain in `routes`. Apply remote migrations and set `OPENAI_API_KEY` with `wrangler secret put OPENAI_API_KEY`. Optionally set `TYPESAFE_API_KEY` the same way.
