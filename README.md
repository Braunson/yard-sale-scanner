# Yard Sale Gold

An installable browser/PWA scanner that samples frames from a live camera or uploaded garage-sale footage, sends them to GPT-5.6 Luna through the OpenAI Agents SDK, values visible items, and streams finds into a mobile-first UI.

## Stack

- React 19 + Vite + TypeScript
- TanStack Router for URL-driven navigation and TanStack Query for server-state caching
- Cloudflare Workers and the Cloudflare Vite plugin
- OpenAI Agents SDK with `gpt-5.6-luna`
- Drizzle ORM + Cloudflare D1
- Cloudflare R2 thumbnails
- Vite PWA service worker and manifest

## Run locally

1. Replace the placeholder in `.dev.vars`:

   ```dotenv
   OPENAI_API_KEY=your_real_project_key
   ```

2. Install dependencies and apply local D1 migrations:

   ```bash
   npm install
   npm run db:migrate:local
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open `http://127.0.0.1:5173`. Select a camera for live scanning or snapshots, or upload a photo/video. Garage-sale clips are available in the local `yard-sale-footage/` folder.

The browser samples compressed frames at a configurable 1–20 second interval and allows up to five analyses in flight. Frame images are not bundled with the app.

## Routes and state

- `/scan` — camera, snapshots, uploads, and the live findings feed
- `/history` — saved inventory
- `/finds/:itemId?from=scan|history` — shareable item detail modal with its originating view preserved
- `/finds/:itemId/activity?from=scan|history` — the persisted agent activity for the item's latest frame

TanStack Query owns remote stats and inventory data. Camera streams, capture timers, in-flight frame work, and the current live feed remain local React state because they are ephemeral browser state.

## Useful commands

```bash
npm test                 # deterministic unit tests
npm run build            # type-check and production build
npm run cf-typegen       # regenerate Worker binding types
npm run db:generate      # generate a migration after schema changes
npm run db:migrate:local # apply migrations to local D1
```

## Agent workflow

Each frame starts one bounded agent run. The agent:

1. Identifies distinct sellable objects and reads visible price tags.
2. Calls `check_previous_scans` against D1 for semantic fingerprint matches.
3. Uses hosted web search when the item is identifiable enough for market evidence.
4. Returns structured retail, active-listing, sold-comparable, and resale-range data.
5. Returns normalized item coordinates and draws bounding boxes over saved frames.
6. Persists new or repeated detections atomically. Exact fingerprints are unique, with conservative token-overlap matching to absorb wording changes such as “metal-and-glass console table” versus “glass-top console table.”
7. Stores a sanitized per-frame audit record containing prompts, ordered run items, tool calls and results, raw model responses, final structured output, and usage. API keys, raw base64 images, encrypted reasoning, and hidden reasoning content are excluded.

The UI reports cumulative frames processed, items identified, searches performed, and underlying model calls. See [FEATURES.md](./FEATURES.md) for live-feed tracking, natural-language filters, eBay integration, and batch processing.

## Cloud deployment later

The checked-in D1 database ID is a local placeholder. Before deploying, create the D1 database and R2 bucket, replace the D1 ID in `wrangler.jsonc`, apply remote migrations, and set `OPENAI_API_KEY` with `wrangler secret put OPENAI_API_KEY`.
