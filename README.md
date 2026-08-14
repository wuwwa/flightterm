# flightterm

Flightterm is a terminal-style flight-tracking dashboard with a React frontend,
an Express API, a SQLite data store, and an optional FAA SWIM worker.

## Runtime architecture

```text
Browser
  └─ React 19 + Vite 8 static application
       └─ /api/*
            └─ Express API + SQLite
                 ├─ OpenSky live states (primary)
                 ├─ adsb.fi community states (rate-limited fallback)
                 ├─ FlightAware AeroAPI
                 ├─ Aviation Weather / FAA / context services
                 └─ flightterm-swim worker (optional FAA SWIM ingestion)
```

The production image uses Node.js 24. OpenSky OAuth credentials improve rate
limits but are optional; the poller can make anonymous requests and falls back
to adsb.fi when OpenSky is unavailable or out of credits.

## Local setup

Requirements:

- Node.js 24
- npm 11+

Install the three locked dependency trees:

```bash
npm ci
npm ci --prefix backend
npm ci --prefix frontend
```

Create the backend environment file:

```bash
cp backend/.env.example backend/.env
```

`backend/.env` is preferred and is gitignored. For compatibility with older
local setups, a dotless `backend/env` file is also loaded as a fallback.

Useful variables:

| Variable | Purpose | Required |
| --- | --- | --- |
| `AEROAPI_KEY` | FlightAware enrichment | No |
| `OS_CLIENT_ID`, `OS_CLIENT_SECRET` | OpenSky OAuth and higher rate limits | No |
| `FAA_CLIENT_ID`, `FAA_CLIENT_SECRET` | FAA NOTAM API | No |
| `POLLER_ENABLED` | Start the server-side live-flight poller | No; defaults off locally |
| `ANOMALY_DETECTION_ENABLED` | Enable anomaly scoring and sightings writes | No |
| `ADMIN_SECRET` | Protect administrative endpoints | Recommended |
| `S3_BUCKET` and AWS credentials | Archive data to S3 | No |

See [backend/.env.example](backend/.env.example) for the complete list.

Start the complete local development stack:

```bash
npm run dev
```

This starts the API on <http://localhost:3001>, Vite on
<http://localhost:5173>, and the local SWIM service. To run only part of the
stack:

```bash
npm run dev:backend
npm run dev:frontend
npm run dev:swim
```

## Verification

```bash
npm test --prefix backend
npm test --prefix frontend
npm run build
npm audit --audit-level=high
npm audit --prefix backend --audit-level=high
npm audit --prefix frontend --audit-level=high
```

The GitHub CI workflow runs these checks with Node.js 24. Fly deployment only
runs after CI succeeds.

Health endpoints:

- `GET /api/health` — configuration and poller snapshot
- `GET /api/health/live` — process liveness
- `GET /api/health/ready` — database readiness
- `GET /api/health/services` — passive upstream-service status
- SWIM worker: `GET /health`

## Production

The main application and SWIM worker use separate Fly configurations:

```bash
fly deploy
fly deploy -c fly.swim.toml
```

The main service can scale to zero. Its first request may therefore include a
cold start. `poller_last_fetch`, `poller_feed_source`, and `poller_aircraft` in
`/api/health` distinguish a running process from a successful data poll.

## Project layout

```text
backend/                 Express API, poller, SQLite, jobs, SWIM consumers
frontend/src/            React dashboard, data clients, tests
.github/workflows/       CI, gated Fly deployment, SWIM wake schedule
scripts/                 Local development helpers
Dockerfile               Node 24 production image
Dockerfile.swim          Node 24 SWIM worker image
fly.toml                 Main Fly application
fly.swim.toml            SWIM Fly application
```
