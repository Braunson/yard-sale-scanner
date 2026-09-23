# Changelog

All notable changes to Yard Sale Gold. Dates use ISO 8601.

## [Unreleased] — 2026-09-23

### Added

- **Two-stage pricing.** Each frame is identified first, without web search. Research then runs only for items that need it.
  - The identify stage (Luna) returns a quick local price, a typical online sale price, a shipping estimate, a `pricingHint` (`instant` or `research`), and a reason.
  - The research stage (Luna + web search + eBay) runs in one batch for the items that need research. It returns retail, active, sold, online-sale, shipping, and resale-range prices with comps.
  - Research from the last 14 days is reused, so the app does not search again for an item it has seen.
- **Optional Jev triage** (`worker/triage.ts`). When `TYPESAFE_API_KEY` is set, one TypeSafe Jev call decides for each item if it can be priced now. An item skips research only if Jev is at least 70% sure. Items that can be worth $50 or more are always researched. If Jev is not set up, fails, or takes more than 4 s, Luna's hint decides.
- **`PRICING_TRIAGE` setting.** `auto` (default) or `research_all`. `research_all` gives the old behavior: every item is researched.
- **Streamed results.** `POST /api/analyze` returns NDJSON events: `identified`, then `researched`, then `done` or `error`. Quick prices show immediately and change when research is done. A frame's concurrency slot is released after the quick prices arrive.
- **On-device object detection** (`src/detector.ts`, `src/detection.ts`). MediaPipe EfficientDet-Lite0 runs in the browser at about 5 fps.
  - Draws live boxes over the camera or video.
  - Skips automatic live frames when nothing new is in view, and re-checks a still scene every 20 s.
  - Sends its detections to Luna as location hints.
  - Settings toggle **On-device detection** (default on).
- **Bottom sheet details.**
  - Pricing path panel: how the price was made, who decided, how sure it was, and why.
  - Price breakdown: tag price, profit and ROI at the tag, sold online, listed online, and resale as a percentage of retail.
  - **Online or local panel**: online sale minus eBay fees (13.25% + $0.40) minus shipping, compared with a local sale, with a verdict. It recommends online only for a gain of at least $5 or 15%, and only when the shipping cost is known.
  - More facts: category and first-seen date.
- **Item card badges**: Instant, Researching, Researched, or Quick estimate, and "+$X online" when selling online pays more.
- **Scan ribbon counters**: frames still in research, and frames skipped by on-device detection.
- **Audit trail** includes both stages and the triage decision (source, Jev latency, errors) for each frame.
- **Migration `0004_two_stage_pricing`**: `online_sale_cents`, `shipping_cents`, `pricing_path`, `pricing_status`, `triage_source`, `triage_confidence`, `research_reason`, `researched_at`, `research_started_at`.
- Unit tests for pricing math, the detection gate, and triage (33 tests in total).
- `vitest.config.ts`, so `npm test` runs without Cloudflare credentials.
- GitHub Actions CI (`.github/workflows/ci.yml`): `npm ci`, `npm test`, and `npm run build` on every pull request and on pushes to `main`.

### Changed

- `POST /api/analyze` returns `application/x-ndjson`, not one JSON object. **This is a breaking change** for other callers.
- The agent model comes from `OPENAI_MODEL`. It was hard-coded before.
- `@mediapipe/tasks-vision` is pinned to `1.0.1`, the same version as the WASM loaded from the CDN.

### Fixed

These problems were found in review before release:

- The detection gate stopped all live frames when COCO saw no object, for example at a clothing rack. The 20 s re-check now runs first.
- Existing items lost their researched prices on the next scan after the migration. The migration now marks them as researched.
- A failure after items were saved deleted their thumbnail, and it could record the frame and its stats two times.
- Items could stay in "researching" permanently if the Worker stopped during research. After 10 minutes the app shows the quick price.
- A quick price overwrote researched prices for older or stale items. Earlier research is now kept when the new triage is `instant`.
- Two detections of one object in the same frame were counted as a repeat sighting, and the second one could skip the $50 research rule. The second one is now dropped.
- Two frames could research the same item at the same time. A frame now skips research while another frame researches that item.
- The item sheet showed old "Researching" data until a refetch finished. The cache is now updated in place.
- The detection overlay re-rendered the app 5 times each second. It now renders only when the boxes change. Its labels are scaled to screen pixels.
- Old boxes stayed on screen after the video stopped. A detector error now turns detection off and does not throw on every frame.
- A stream that closed without a final event was treated as a success.
- The UI showed "Jev … 5% sure" when the $50 rule, not Jev, forced research.
