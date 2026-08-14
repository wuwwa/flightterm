# Scaling Roadmap

## Current Architecture
- React frontend (Vite) + Express backend monolith
- SQLite (better-sqlite3) with Fly.io persistent volume
- Single `shared-cpu-1x` / 512MB VM, auto-stop enabled
- Multi-stage Dockerfile, deployed on Fly.io (iad region)

## Bottlenecks
1. **SQLite is single-writer** — one process, one machine. Can't horizontally scale because two machines can't share a Fly volume.
2. **Monolith coupling** — backend serves API and static frontend from one process. Can't scale API compute independently.
3. **In-memory caching** — OpenSky token cache lives in process memory. Multiple instances would each re-fetch tokens independently.

## Phase 1: Quick Wins (no architecture change)
- Bump Fly VM to `shared-cpu-2x` / 1GB
- Put a CDN in front (Fly edge caching or Cloudflare) — static assets shouldn't hit origin
- Add SQLite read replicas via LiteFS for multi-region reads

## Phase 2: Decouple the Frontend
- Serve `frontend/dist` from a CDN or static hosting (Cloudflare Pages, Vercel, Netlify)
- Backend becomes a pure API server, scalable independently

## Phase 3: Migrate off SQLite
Only needed if write throughput becomes a problem or multi-instance writes are required.
- **Managed Postgres** — Fly Postgres, Supabase, or Neon. `db.js` is already a clean abstraction layer so the swap is contained.
- **Redis/Valkey** for caching (token cache, API response caching, rate limit counters) instead of in-memory objects

## Phase 4: Horizontal Scaling
Once on Postgres + Redis:
- Run multiple Fly machines behind built-in load balancer
- Set `min_machines_running = 2` for availability
- Add regions (`fly regions add ord lhr`) for latency

## Containerization Next Steps
- Docker Compose for local dev (backend + frontend + Postgres + Redis)
- CI/CD pipeline — `fly deploy` on push to main via GitHub Actions

---

# How the App Is Containerized

## Key Files
- `Dockerfile` — defines how the container image is built
- `fly.toml` — defines how Fly.io runs the container

## The Dockerfile: Multi-Stage Build

### Stage 1: Frontend Build (temporary, discarded after build)
```
FROM node:24-slim AS frontend-build
```
- Starts from a lightweight Node 20 image
- Copies frontend source, runs `npm ci && npm run build`
- Produces static files in `frontend/dist`
- This entire stage is thrown away — it never exists in the final image

### Stage 2: Production Runtime (the actual deployed image)
```
FROM node:24-slim
```
- Starts from a fresh Node 20 slim image
- Installs `python3`, `make`, `g++` because `better-sqlite3` compiles native C++ during install
- Copies backend code, runs `npm ci --omit=dev` (no dev dependencies)
- Copies built frontend assets from Stage 1 via `COPY --from=frontend-build`
- Final image contains: compiled frontend + backend + production deps only

### Why multi-stage?
- The frontend build needs `vite`, `react`, etc. — none of that belongs in production
- Keeps the final image small and reduces attack surface
- Stage 1 tools (vite, build deps) are never shipped

## fly.toml: Runtime Configuration

| Setting | Value | What it does |
|---|---|---|
| `primary_region` | `iad` | Machine runs in Ashburn, Virginia |
| `[[mounts]]` | `/data` | Persistent volume for SQLite — survives deploys |
| `auto_stop_machines` | `stop` | Machine shuts down when idle (saves money) |
| `auto_start_machines` | `true` | Boots back up on next incoming request |
| `min_machines_running` | `0` | Allows full shutdown (cold starts possible) |
| `size` | `shared-cpu-1x` | Shared vCPU, 512MB RAM |

## Deploy Flow (`npm run deploy` / `fly deploy`)
1. Fly.io receives source code
2. Builds Docker image using the Dockerfile on their remote builders
3. Pushes image to Fly's internal registry
4. Stops old machine, starts new one from the new image
5. `/data` volume persists across deploys — SQLite DB survives

## Key Concepts
- **Containers are ephemeral** — anything not on a mounted volume is wiped each deploy. That's why SQLite lives on `/data`, not in the app directory.
- **Images are immutable** — once built, the image never changes. New deploy = new image = new container.
- **Volumes are the escape hatch** — persistent storage that outlives any single container.
- **Port mapping** — the container exposes 3001 internally; Fly handles HTTPS termination and routes external traffic to it.

---

# Code Review: What's Wrong & What to Improve

## Architecture Issues

### 1. The frontend is the brain — it should be the backend
The frontend detects anomalies, scores them, categorizes them, then POSTs finished results to `/api/anomalies`. The backend is just a dumb store. This is backwards: if external systems need to consume anomaly events, detection and scoring belong server-side. The frontend should display results, not produce them.

### 2. Anomaly system is pull-only — no event emission
`recordAnomalies()` in `db.js` writes to SQLite and returns a count. Nothing happens after that. No webhooks, no event bus, no pub/sub, no notification. The data goes in and sits there until someone polls `/api/anomalies/active`.

### 3. `index.js` is a 920-line monolith doing 3 jobs
- **Proxy layer**: forwarding requests to OpenSky, AeroAPI, adsb.fi, aviation weather, hexdb, and FAA NOTAMs
- **Domain logic**: sightings, anomalies, routes, usage tracking
- **Static file server**: serving the frontend

These should be separate Express routers at minimum (`routes/proxy.js`, `routes/anomalies.js`, `routes/sightings.js`, etc.).

### 4. In-memory caches have no eviction
`_notamCache`, `_osTokens`, `_serviceHealth` grow without bound. Low risk at current scale, but becomes a memory leak with more airports or users.

### 5. No input validation on proxy routes
`/api/apl/point` passes `lat`, `lon`, `radius` directly into URL path construction with no sanitization. `/api/adsbfi/hex/:hex` and others do the same. User-controlled input should be validated before constructing upstream URLs.

### 6. `resolveAnomalies` is N+1
Loops over `icaos` array and runs one `UPDATE` per ICAO instead of a single batched `WHERE icao IN (...)` query.

---

# Event-Driven Anomaly Architecture

The goal: anomaly data → API endpoint → event-driven actions that fire based on detection.

## Current Flow (implemented)

```text
Backend poller (POLL_INTERVAL) → fetches OpenSky → scores anomalies → writes to DB
                                                           → emits EventEmitter events
                                                           → pushes to SSE stream
                                                           → frontend displays via EventSource
```

## Future Flow

```text
Same as above, plus:
→ webhook delivery to external consumers
→ Redis pub/sub for multi-instance
→ versioned external API
```

## Step 1: Move Detection Server-Side
- Create a polling service in the backend that fetches from OpenSky/adsb.fi on a timer
- Run anomaly scoring logic server-side (port the frontend detection code to Node)
- Frontend becomes a pure display layer that reads from `/api/anomalies/active`

## Step 2: Add Event Emission
Start simple — Node's built-in `EventEmitter`:
```js
// anomalyEvents.js
const { EventEmitter } = require('events')
const anomalyBus = new EventEmitter()
module.exports = anomalyBus

// in recordAnomalies():
anomalyBus.emit('anomaly:new', { icao, score, severity, category })
anomalyBus.emit('anomaly:critical', { ... })  // filtered high-severity
```

Graduate to Redis pub/sub or BullMQ when you need:
- Durability (events survive process restarts)
- Multiple consumers (separate services subscribing)
- Retry logic (failed webhook deliveries)

## Step 3: Add Consumer Endpoints

### Server-Sent Events (SSE) — simplest real-time option
```
GET /api/anomalies/stream
```
- Client opens a persistent HTTP connection
- Server pushes anomaly events as they happen
- Works through firewalls, no WebSocket upgrade needed
- Perfect for dashboards and monitoring tools

### Webhooks — for external integrations
```
POST /api/webhooks { url: "https://...", events: ["anomaly:critical"] }
```
- Register a callback URL + filter criteria
- Backend POSTs to registered URLs when matching events fire
- Add retry queue (BullMQ) for failed deliveries

### WebSocket — for bidirectional / low-latency
- Use if consumers need to send commands back (e.g., "acknowledge this anomaly")
- Overkill if you just need push notifications

## Step 4: External API
Clean, versioned, documented endpoint for third-party consumers:
```
GET  /api/v1/anomalies/active         — current unresolved anomalies
GET  /api/v1/anomalies/stream         — SSE real-time feed
GET  /api/v1/anomalies/stats          — aggregate stats
POST /api/v1/anomalies/subscribe      — register webhook
```

## Recommended Stack Addition
| Need | Tool | Why |
|---|---|---|
| Event bus (in-process) | Node EventEmitter | Zero dependencies, good enough for single instance |
| Event bus (distributed) | Redis pub/sub | When you have multiple backend instances |
| Job queue (webhooks, retries) | BullMQ + Redis | Reliable delivery with backoff and dead-letter |
| Real-time push | SSE (`res.write()`) | Simpler than WebSockets, works everywhere |

---

# Migration Plan: Anomaly Detection to Backend

## Status: COMPLETE ✓

All five phases completed. Anomaly detection now runs server-side. 127 backend tests passing.

## What Changed

### Backend (new)

- **`backend/anomaly.js`** — scoring logic copied from frontend, unchanged
- **`backend/anomaly.test.js`** — 95 characterization tests covering all scoring paths
- **`backend/poller.js`** — polling service (POLL_INTERVAL, default 45s, configurable region)
  - Fetches from OpenSky, maintains track history, scores per aircraft
  - Records anomalies to SQLite, resolves after 3 consecutive clear cycles
  - Emits events via EventEmitter (`anomaly:new`, `anomaly:critical`, `anomaly:resolved`)
  - Fetches weather context (PIREPs, SIGMETs) for scoring
  - Caches latest flight data for `/api/flights` endpoint
- **`backend/poller.test.js`** — 22 unit tests for poller internals
- **`backend/integration.test.js`** — 10 end-to-end tests (poller → event → SSE → API → DB)
- **`backend/index.js`** — new endpoints:
  - `GET /api/flights` — serves poller's cached flight data
  - `GET /api/anomalies/stream` — SSE endpoint for real-time anomaly events
  - `POST /api/poller/start` / `POST /api/poller/stop` / `GET /api/poller/status`

### Frontend (stripped)

- **Removed from `App.jsx`:**
  - `scoreAnomaly()` / `ANOMALY_THRESHOLD` imports and all scoring logic (~110 lines)
  - `fetchPireps`, `fetchSigmets`, `summarizePireps`, `summarizeSigmets` weather calls
  - `recordAnomalies`, `resolveAnomalies` database calls
  - `weatherRef`, `anomalyMissRef` refs and grace-period resolution loop
  - Per-aircraft anomaly scoring loop inside `fetchFlights`
- **Added to `App.jsx`:**
  - SSE listener (`EventSource` on `/api/anomalies/stream`) for real-time anomaly/critical/resolved events
  - Flight data from `/api/flights` (poller cache) instead of direct OpenSky calls
  - Region fallback: if poller region ≠ user-selected region, falls back to direct OpenSky proxy
- **Preserved:**
  - AeroAPI enrichment remains click-only (no change)
  - ADSBx and adsb.fi fallback sources intact
  - Route rate limiting, sightings dedup, all display components intact
  - `frontend/src/utils/anomaly.js` still exists (used by frontend display components for constants)

### API Call Reduction

- Before: frontend polled OpenSky every 90s per browser tab (~960 calls/day/tab, doubled with multiple tabs)
- After: single backend poller makes ~1920 calls/day total, regardless of connected clients (dual-key: 8000 credits/day)
- Frontend reads cached data from `/api/flights` — zero direct OpenSky calls when region matches

## Architecture After Migration

| Component | Location | Notes |
|---|---|---|
| `scoreAnomaly()`, `detectPhase()` | `backend/anomaly.js` | Unchanged logic, 95 tests |
| Polling service | `backend/poller.js` | Fetches + scores on POLL_INTERVAL timer |
| Track history | In-memory Map in poller | Per-aircraft, capped at 30 snapshots |
| Route cache | SQLite `routes` table + in-memory | DB-backed, poller reads via `getRoutesBulk()` |
| Weather context | Re-fetched each cycle | PIREPs + SIGMETs for scoring context |
| Event emission | `poller.anomalyEvents` | Node EventEmitter (upgrade to Redis pub/sub for multi-instance) |
| SSE stream | `GET /api/anomalies/stream` | Real-time push to connected frontends |
| AnomalyFeed, Drilldown | `frontend/src/components/` | Display only, reads from SSE + API |
| App.jsx fetch cycle | `frontend/src/App.jsx` | Reads flights from poller, anomalies from SSE |

---

## Reality Check
SQLite on a single Fly machine with LiteFS read replicas can handle thousands of concurrent users. The AeroAPI cost cap ($5.00) will throttle usage long before SQLite becomes the bottleneck. External API rate limits are the real ceiling, not infrastructure.
