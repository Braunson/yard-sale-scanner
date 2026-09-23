# Yard Sale Gold — Feature Log

This file tracks intentionally deferred product ideas so the MVP can stay focused.

## Planned

- **Live-feed bounding-box tracking:** Match on-device detections to saved finds so their prices follow the object on the moving camera feed.
- **Natural-language discovery filters:** Let the scanner prompt Luna with filters such as “only show me band T-shirts valued over $50.” Keep capturing activity metrics even when a detected item is filtered from the visible feed.
- **eBay sold-comps integration:** Add an eBay MCP server or eBay developer API tool when credentials are available. Prefer sold listings and retain links and timestamps for each comparable.
- **Configurable alert rules:** Filter by category, value, estimated profit, ROI, brand, condition, or confidence.
- **Batch processing mode:** Use the OpenAI Batch API for non-live uploaded footage where throughput and cost matter more than immediate results. Live camera analysis should continue using concurrent low-latency requests.
- **Visual similarity deduplication:** Add embeddings or image-feature matching so duplicate detection is not limited to normalized semantic fingerprints.
- **Multi-user accounts and shared finds:** Add authentication, ownership, and optional shared collections after the single-user workflow is validated.
- **TanStack Start migration:** Revisit moving the full app to TanStack Start when SSR, server functions, authentication, or route-level server loading provide a concrete benefit. TanStack Start is officially supported on Cloudflare Workers, but the current camera-first PWA keeps its existing Worker API.

## MVP decisions

- Installable React/Vite PWA that is easy to debug in a desktop or mobile browser.
- GPT-5.6 Luna through the TypeScript OpenAI Agents SDK.
- Browser camera and uploaded-video frame sampling; no direct video model input.
- Scrolling live results with a sound and an R2-backed thumbnail per detected item.
- Every detected item appears; no value/category filter in the MVP.
- Value records can include retail price, active listings, and sold comparables.
- Dedupe within the active scan and across historical scans.
- D1 stores metadata; R2 stores thumbnails.
- No authentication; single local user.
- Live scale counters: frames processed, items identified, searches performed, and total model calls.
- Luna returns normalized item coordinates; saved-frame thumbnails and detail views render item-level bounding boxes.
- Two-stage pricing: quick prices first, web research only for items that need it. Jev (optional) or Luna decides.
- On-device MediaPipe detection draws live boxes and skips live frames with nothing new in view.
- The detail sheet shows the pricing path, tag profit and ROI, sold and listed prices, and an online-versus-local verdict.
