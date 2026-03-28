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
FROM node:20-slim AS frontend-build
```
- Starts from a lightweight Node 20 image
- Copies frontend source, runs `npm ci && npm run build`
- Produces static files in `frontend/dist`
- This entire stage is thrown away — it never exists in the final image

### Stage 2: Production Runtime (the actual deployed image)
```
FROM node:20-slim
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
- **Proxy layer**: forwarding requests to OpenSky, AeroAPI, adsb.fi, aviation weather, hexdb, airplanes.live, FAA NOTAMs
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

## Current Flow (what exists)
```
Frontend polls data sources → Frontend detects anomalies → POST /api/anomalies → SQLite → (nothing)
```

## Target Flow
```
Backend polls data sources → Backend detects anomalies → writes to DB
                                                       → emits event
                                                       → notifies subscribers (webhook, SSE, WebSocket)
                                                       → external consumers react
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

## Current State
- `frontend/src/utils/anomaly.js` (~705 lines) — pure scoring logic, zero React dependencies
- `App.jsx` fetch cycle — polls data sources, calls `scoreAnomaly()` per aircraft, POSTs results
- Track history, enrichment cache, weather context — all in-memory in browser tab
- **No tests exist anywhere in the project** — no framework, no specs, no coverage

## The Problem
No browser tab open = no anomaly detection. The system only works when a human is watching.

## Migration Strategy: Test → Move → Verify

### Phase 0: Add a Test Framework
- Install `vitest` (already compatible with the Vite frontend, works standalone for backend too)
- Add `npm test` scripts to both `frontend/package.json` and `backend/package.json`

### Phase 1: Write Characterization Tests (BEFORE moving code)
Test `scoreAnomaly()` in-place in the frontend. These tests capture what the code *actually does* — so after migration, if they still pass, behavior is preserved.

**Critical test groups:**

| Test Group | What to Assert | Priority |
|---|---|---|
| Squawk detection | 7700 → CRITICAL/80+, 7500 → score 100, 7600 → adds 20 | P0 (safety) |
| Phase detection | Altitude deltas map to correct CLIMB/CRUISE/DESCENT/APPROACH | P0 |
| Altitude anomaly | Vertical rate outside phase norms → correct score | P0 |
| Severity tiers | Score thresholds → correct LOW/MEDIUM/HIGH/CRITICAL | P0 |
| Confirmation logic | Two consecutive large descents → confirmed flag, 1.3x boost | P1 |
| Tolerance multipliers | Light aircraft → 2-3x leniency, heavy → 0.9x | P1 |
| Weather dampening | Convective SIGMET → 0.3x, turbulence → 0.5x, never suppresses emergency | P1 |
| Spatial context | Group maneuvering → 0.4x dampen, lone deviant → 1.3x boost | P1 |
| Airport proximity | Descent within 50km of major airport → 0.25x | P2 |
| Noise recovery | 500m spike then recovery → 0.3x dampen | P2 |
| Edge cases | Null enrichment, empty snapshots, missing fields, <2 snapshots → no crash | P2 |

**Test fixture approach:**
- Build reusable factory functions for flight objects, snapshot arrays, weather context
- Each test group gets its own describe block with deterministic inputs
- Snapshot the exact scores so regressions are caught immediately

### Phase 2: Copy `anomaly.js` to Backend
- Copy `frontend/src/utils/anomaly.js` → `backend/anomaly.js`
- Copy the test file alongside it
- Run the same tests — they must all pass with zero changes

### Phase 3: Build the Backend Polling Service
New file: `backend/poller.js`
- `setInterval` or cron-based timer (every 30-90s)
- Calls OpenSky/adsb.fi/airplanes.live directly (not through Express proxy routes)
- Maintains in-memory track history Map (keyed by ICAO)
- Runs `scoreAnomaly()` per aircraft after each fetch
- Calls `recordAnomalies()` for anything above threshold
- Emits events via EventEmitter for downstream consumers

### Phase 4: Integration Tests
- Test the full loop: mock API response → poller processes → anomaly recorded in SQLite → event emitted
- Test recovery: poller handles API failures, timeouts, malformed responses gracefully
- Test state: track history accumulates correctly, old entries evicted

### Phase 5: Remove Frontend Detection
- Remove `scoreAnomaly()` calls from `App.jsx` fetch cycle
- Frontend reads from `GET /api/anomalies/active` and `GET /api/anomalies/stream` (SSE)
- Delete `frontend/src/utils/anomaly.js` (backend is now the source of truth)
- Keep display components (AnomalyFeed, AnomalyDrilldown) — they just read from API now

## What Stays Where After Migration

| Component | Location | Notes |
|---|---|---|
| `scoreAnomaly()`, `detectPhase()` | `backend/anomaly.js` | Unchanged logic, tested |
| Polling service | `backend/poller.js` | New — fetches + scores on timer |
| Track history | In-memory Map + SQLite `track_snapshots` | Hybrid: Map for speed, SQLite for persistence across restarts |
| Enrichment cache | In-memory Map with TTL | Same pattern as existing `_notamCache` |
| Route cache | SQLite `routes` table | Already exists |
| Weather context | Re-fetched each cycle | Cheap, no need to persist |
| Event emission | `backend/anomalyEvents.js` | New — EventEmitter, then Redis pub/sub |
| AnomalyFeed, Drilldown | `frontend/src/components/` | Display only, reads from API |
| App.jsx fetch cycle | `frontend/src/App.jsx` | Stripped of anomaly logic, just displays flights |

---

## Reality Check
SQLite on a single Fly machine with LiteFS read replicas can handle thousands of concurrent users. The AeroAPI cost cap ($5.00) will throttle usage long before SQLite becomes the bottleneck. External API rate limits are the real ceiling, not infrastructure.
