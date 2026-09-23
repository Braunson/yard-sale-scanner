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
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | No | `.dev.vars` / `wrangler secret put` | Adds the eBay active-listing search tool to the research stage. |

Browser settings, kept in `localStorage` on each device: find criteria, concurrent processing, live scan frequency, and **On-device detection** (default on).

### Jev is optional

Without `TYPESAFE_API_KEY` the app runs normally. The server never calls TypeSafe, and Luna's `pricingHint` from the identify step does the triage. This hint costs nothing extra, because it comes from the same call.

Two-stage pricing is still on without Jev. Luna can mark a generic, low-value item `instant`, and that item then gets no web research. Set `PRICING_TRIAGE=research_all` to research every item, as the app did before.

## Upgrading from the single-stage version

- **Apply migration `0004_two_stage_pricing.sql`** (`npm run db:migrate:local` or `npm run db:migrate:remote`) before you deploy the new Worker. The migration adds pricing columns to `items`. It also marks existing items as researched, so a new scan does not replace their prices.
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
2. **Triage (Jev, optional).** When `TYPESAFE_API_KEY` is set, one TypeSafe Jev call asks a Choice question per item: can it be priced now, or does it need research? An item skips research only when Jev gives `instant` a probability of at least 0.70. Without the key, or if Jev fails, Luna's hint is used. Any item that might be worth $50 or more is always researched. Items researched in the last 14 days reuse that research.
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

## Online versus local

The item detail sheet compares a local sale (the midpoint of the resale range) with an online sale after eBay fees (13.25% + $0.40) and seller-paid shipping. It recommends online only when the net gain is at least $5 or 15% of the local price.

The UI reports cumulative frames processed, items identified, searches performed, underlying model calls, frames skipped on the device, and frames still in research. See [FEATURES.md](./FEATURES.md) for live-feed tracking, natural-language filters, eBay integration, and batch processing.

## Cloud deployment

Before deploying your own instance, create a D1 database and R2 bucket, replace the resource names and D1 ID in `wrangler.jsonc`, and replace or remove the author's custom domain in `routes`. Apply remote migrations and set `OPENAI_API_KEY` with `wrangler secret put OPENAI_API_KEY`. Optionally set `TYPESAFE_API_KEY` the same way.
