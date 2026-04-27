# flightterm

A terminal-style flight tracking dashboard built with React + Vite (frontend) and Express (backend).
Follows the FullStackOpen architecture: Vite proxies `/api/*` to Express, keeping API keys server-side.

## Stack

| Layer     | Technology                      |
| --------- | ------------------------------- |
| Frontend  | React 18, Vite 5, axios         |
| Backend   | Node.js, Express, axios, dotenv |
| Dev tools | concurrently, nodemon           |

## Data sources

| Source              | What it provides                        | Cost       |
| ------------------- | --------------------------------------- | ---------- |
| OpenSky Network     | Live radar — positions, altitude, speed | Free       |
| ADS-B Exchange      | Live radar — unfiltered incl. military  | ~$10/mo    |
| adsbdb              | Aircraft type, owner, route             | Free       |
| FlightAware AeroAPI | Schedules, delays, status, times        | $5/mo free |

## Quick start

### 1. Install dependencies

```bash
npm install          # installs concurrently at root
npm run install:all  # installs backend + frontend deps
```

### 2. Configure AeroAPI key

```bash
cp backend/.env.example backend/.env
# Edit backend/.env and set:
# AEROAPI_KEY=your_actual_key_here
```

Your AeroAPI key is available at:
https://www.flightaware.com/aeroapi/portal → My AeroAPI → Overview → Add API Key

### 3. Start both servers

```bash
npm run dev
```

This runs:

- Express backend on http://localhost:3001
- Vite frontend on http://localhost:5173

Open http://localhost:5173 in your browser.

### Run servers separately (if needed)

```bash
# Terminal 1
npm run dev:backend

# Terminal 2
npm run dev:frontend
```

## How the proxy works (FullStackOpen pattern)

Vite's dev server proxies any request starting with `/api` to the Express backend:

```
Browser → GET /api/aero/flights/BAW117
        → Vite proxy → Express :3001 /api/aero/flights/BAW117
        → Express adds x-apikey header → FlightAware AeroAPI
        → Response back to browser (no CORS, no key exposure)
```

OpenSky and adsbdb are called directly from the browser — they support CORS.
AeroAPI does NOT support CORS, which is why it goes through the backend.

## Project structure

```
flightterm/
├── package.json              # root scripts (concurrently)
├── .gitignore
├── README.md
│
├── backend/
│   ├── package.json
│   ├── index.js              # Express server + AeroAPI proxy routes
│   ├── .env.example          # copy to .env and add your key
│   └── .env                  # ← gitignored, your keys live here
│
└── frontend/
    ├── package.json
    ├── vite.config.js         # proxy /api → localhost:3001
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx            # root component, all state management
        ├── index.css          # global styles, CSS variables
        ├── components/
        │   ├── TopBar.jsx     # status bar (stats, source badge, clock)
        │   ├── ControlBar.jsx # fetch, auto-refresh, region, filter
        │   ├── LogPanel.jsx   # scrolling activity log
        │   ├── FlightTable.jsx# sortable flight list
        │   ├── DetailPanel.jsx# per-flight enrichment (adsbdb + aeroapi)
        │   ├── UsagePanel.jsx # AeroAPI usage stats + cost map
        │   └── SettingsModal.jsx
        └── services/
            ├── opensky.js     # OpenSky Network API
            ├── adsbx.js       # ADS-B Exchange via RapidAPI
            ├── adsbdb.js      # adsbdb aircraft + route lookup
            └── aeroapi.js     # AeroAPI via Express proxy (/api/aero/*)
```

## AeroAPI endpoints used

| Endpoint             | Cost/result set | Used for                  |
| -------------------- | --------------- | ------------------------- |
| GET /flights/{ident} | $0.005          | Per-flight scheduled data |
| GET /account/usage   | free            | Usage statistics panel    |
| GET /api/aero/costs  | free (local)    | Cost map display          |

## Settings (persisted to localStorage)

- **Source**: auto / opensky only / adsbx only
- **ADS-B Exchange key**: RapidAPI key (stored in browser localStorage)
- **ADS-B Exchange radius**: search radius in nautical miles (1–100)
- **OpenSky credentials**: optional username/password for better rate limits
- **Auto-refresh interval**: seconds between fetches (min 15s)

Note: AeroAPI key is NOT in settings — it lives in `backend/.env` only.

## Usage panel ($ button)

Shows live AeroAPI account stats fetched from `/account/usage`:

- Total calls, total cost, free credit remaining
- Per-endpoint breakdown with cost per call
- Full cost map for all 40+ endpoints

Data is updated every 10 minutes by FlightAware.

# fly deploy -c fly.swim.toml

# fly deploy
