# Business Jet Tracker Handoff

## Original User Request

The user asked for a new, dominant tracker near the top of Flightterm. It should:

- Watch a fixed cohort of business jets, not all aircraft.
- Build that cohort from FAA registry data using a practical business-jet filter.
- Match live aircraft by ICAO hex identifier.
- About every 30 minutes, download an available ADS-B heatmap/snapshot, parse it, match aircraft against the cohort, and store latest position, altitude, speed, heading, and related fields.
- Show the matched aircraft on a live map in the app.
- Build historical context from the same heatmap format.
- Backfill previous half-hour snapshots.
- Show a least-to-most-likely scale asking whether the current airborne count is unusual for this time.
- Calibrate the highest end so the trailing year should exceed it only rarely.
- Treat it as an "early apocalypse warning system."

After implementation, the user reported the flight table was not visible. That was caused by the new tracker consuming the desktop grid height. It was fixed by bounding the tracker grid row with explicit CSS.

## What Was Implemented

### Backend Storage

Implemented in `backend/db.js`.

New FAA aircraft reference table:

- `faa_aircraft_ref`
- Ingests `ACFTREF.txt` from the FAA releasable aircraft zip.
- Decodes FAA model code into manufacturer, model, aircraft type, engine type, seats, weight, speed, etc.

New business-jet tracker tables:

- `business_jet_cohort`
- `business_jet_snapshots`
- `business_jet_positions`

`business_jet_cohort` and `business_jet_positions` now also carry cohort tier / owner class metadata so the API and UI can explain what kind of aircraft are being measured.

`business_jet_snapshots` has `sample_slot`, a UTC half-hour bucket with a unique partial index. This is intentional: the tracker should store at most one snapshot per 30-minute bucket so the database does not grow out of control.

New helpers include:

- `upsertFaaAircraftRefBulk`
- `getFaaAircraftRefCount`
- `rebuildBusinessJetCohort`
- `getBusinessJetCohort`
- `getBusinessJetCohortByHex`
- `getBusinessJetBaseline`
- `recordBusinessJetSnapshot`
- `getBusinessJetLatest`

### Cohort Logic

The cohort is built from FAA `MASTER.txt` joined to `ACFTREF.txt`.

Current filter after the user's "scope down / really rich people" clarification:

- FAA registration status `V`.
- Valid 6-character ICAO24 hex.
- `type_aircraft = 5`.
- `type_engine = 5`.
- 1 to 4 engines.
- 8 to 32 seats by default.
- Wealth-signal model families only:
  - Gulfstream large-cabin/long-range aircraft.
  - Dassault Falcon/Mystere Falcon aircraft.
  - Bombardier Global / `BD-700*`.
  - Challenger 600-series via `CL-600-2B16`.
  - Citation X via model `750`.
- Excludes common regional/airline-ish patterns:
  - `DHC-*`, `ERJ-*`, `EMB-1*`, `*CRJ*`, several CRJ-related `CL-600` variants, `*AIRLINER*`.
  - Owners containing `AIRLINES`, `AIRWAYS`, `CARGO`, or `FREIGHT`.
- Excludes obvious government and medical operators.
- Keeps but tags fractional/charter-style wealth service operators separately.

The default cohort intentionally no longer includes small and mid-market jets such as HondaJet, Pilatus PC-24, Eclipse, Cirrus Vision, Phenom, broad Citation 500/525/560/680/700 families, Embraer Legacy/Praetor, Hawker, Learjet, or generic Bombardier `BD-100`.

New cohort metadata:

- `cohort_tier`: `ultra_long_range` or `large_cabin`.
- `owner_class`: `private_corp`, `trust`, or `wealth_service`.
- `wealth_weight`: currently `1.0` for private/corp, `0.9` for trust, `0.55` for wealth-service/fractional style operators.
- `include_reason`: short text explaining why the aircraft was admitted.

Local strict rebuild produced a cohort of `5,244` aircraft:

- `3,325` large-cabin.
- `1,919` ultra-long-range.
- `4,070` private/corp.
- `1,102` trust.
- `72` wealth-service.

The prior broad cohort was `13,562`, so the tracker was reduced by about 61%.

### FAA Registry Ingest

Updated `backend/jobs/faaRegistryJob.js`.

Changes:

- Added `parseAircraftRefLine`.
- Added `ingestAircraftRefFile`.
- Added extraction of `ACFTREF.txt` alongside `MASTER.txt`.
- Added a guard so if `faa_aircraft_ref` is empty, the job ingests even when the FAA zip hash matches the previous ingest.
- Rebuilds the business jet cohort after ingest.

The existing CLI `backend/scripts/ingest-faa-registry.js --fetch` now pulls both FAA files and rebuilds the cohort.

### Tracker Service

Added `backend/businessJetTracker.js`.

Responsibilities:

- Reads the fixed cohort from SQLite.
- Accepts tar1090/readsb-style snapshots via URL if configured.
- Falls back to the app's existing poller cache when no snapshot URL is configured.
- Normalizes both tar1090/readsb fields and app poller fields.
- Matches aircraft by lowercase ICAO hex.
- Stores one snapshot and one row per airborne matched aircraft.
- Computes a trailing-year time-of-week baseline using same weekday and nearby minute-of-day.
- Computes `unusualScore` from baseline mean to p99.
- Exposes latest tracker state for the UI.
- Supports historical backfill using a URL template.
- Cold starts do not trigger immediate catch-up writes. The scheduler waits until the next UTC half-hour slot, then samples every 30 minutes. Missing slots are acceptable.

Config knobs:

- `BUSINESS_JET_TRACKER_DISABLED=true` disables startup scheduler.
- `BUSINESS_JET_TRACKER_INTERVAL_MS`, default `1800000` ms.
- `BUSINESS_JET_HEATMAP_URL` or `ADSB_HEATMAP_URL` for live tar1090/readsb JSON or `.json.gz`.
- `BUSINESS_JET_HISTORY_URL_TEMPLATE` or `ADSB_HISTORY_URL_TEMPLATE` for historical backfill.
- `BUSINESS_JET_BASELINE_DAYS`, default `365`.
- `BUSINESS_JET_BASELINE_WINDOW_MINUTES`, default `45`.
- `BUSINESS_JET_COHORT_MAX_SEATS`, default `32`.

Even if `BUSINESS_JET_TRACKER_INTERVAL_MS` is changed or `/api/business-jet-tracker/sample` is called manually, live sampling is guarded by a 30-minute minimum and duplicate half-hour `sample_slot` writes are skipped. Historical backfill also clamps `--step-minutes` to at least 30.

### Main Poller Fallback

Production check on `2026-05-06` showed the app was serving HTML/assets, but `/api/flights` was empty and Fly logs showed repeated OpenSky timeouts from the VM. To keep the dashboard alive when OpenSky is unreachable, `backend/poller.js` now falls back to Airplanes.live point queries.

Details:

- Enabled by default unless `AIRPLANES_LIVE_FALLBACK_DISABLED=true`.
- Uses `AIRPLANES_LIVE_BASE`, default `https://api.airplanes.live/v2`.
- For `POLL_REGION=usa`, queries 12 representative points at 250 nm radius, then dedupes by ICAO hex.
- Normalizes Airplanes.live feet/knots/ft-min fields back into the app's OpenSky-style meters/m/s shape.
- Existing dashboard consumers still read `/api/flights`; no frontend API change.

Historical URL template tokens:

- `{yyyy}`, `{yy}`, `{MM}`, `{dd}`, `{HH}`, `{mm}`, `{ss}`, `{epoch}`

### Backfill CLI

Added `backend/scripts/backfill-business-jets.js`.

Usage:

```bash
node backend/scripts/backfill-business-jets.js --start=2026-05-01T00:00:00Z --end=2026-05-02T00:00:00Z --step-minutes=30
```

Requires `BUSINESS_JET_HISTORY_URL_TEMPLATE`.

### API Routes

Implemented in `backend/index.js`.

Routes:

- `GET /api/business-jet-tracker`
- `POST /api/business-jet-tracker/sample` with admin secret.
- `POST /api/business-jet-tracker/cohort/rebuild` with admin secret.

Startup:

- `businessJetTracker.start()` runs unless `BUSINESS_JET_TRACKER_DISABLED=true`.
- Samples immediately, then at the configured interval.
- Stops on graceful shutdown.

### Frontend Service

Updated `frontend/src/services/dashboard.js`.

Added:

- `fetchBusinessJetTracker()`

### Frontend UI

Added `frontend/src/components/BusinessJetTracker.jsx`.

UI includes:

- Top-of-app compact "Early Warning" status strip.
- Current airborne count.
- Fixed cohort size.
- Wealth-signal cohort labeling.
- Tier and owner-class breakdowns in the expanded detail view.
- Least-to-most-likely scale.
- Baseline p99/confidence/sample age in the strip.
- Historical airborne trend line chart with observed line plus historical mean/p99 curves when backfill exists, behind the details toggle.
- Leaflet map of matched airborne cohort aircraft, behind the details toggle.
- Latest matched aircraft list with callsign/registration/model/altitude/speed, behind the details toggle.

Latest UX adjustment:

- The default tracker no longer renders the large score/chart row.
- `frontend/src/index.css` changed the desktop app grid from a fixed `minmax(240px, 38vh)` tracker row to an auto-sized row.
- `.business-jet-shell` now has `max-height: 58vh` so expanded details can scroll without taking over the dashboard.

Mounted in `frontend/src/App.jsx` above `InterestingFeed` and `FlightTable`.

### Flight Table Visibility Fix

The new tracker initially made the flight table disappear because the desktop grid row was content-sized.

Fix:

- Added `.app-shell` and `.business-jet-shell` CSS in `frontend/src/index.css`.
- Desktop grid now uses:

```css
grid-template-rows: auto auto minmax(240px, 38vh) minmax(0, 1fr) auto auto;
```

This gives the tracker a dominant but bounded top row and preserves remaining space for the flight table.

`frontend/src/App.jsx` now uses:

- `className="app-shell flex flex-col min-h-screen"`
- `className="business-jet-shell col-span-full min-h-0 overflow-y-auto"`

## Current Runtime State Observed Locally

Dev app was running at:

- `http://localhost:5173`

Backend:

- `http://localhost:3001`

FAA ingest was run locally and produced:

- `312,546` FAA registry rows.
- `93,715` FAA aircraft reference rows.
- `5,244` strict wealth-signal cohort aircraft.

Old broad-cohort tracker snapshots were deleted after the strict cohort rebuild because they were no longer comparable to the new cohort.

Current local API state after the strict rebuild:

- `GET /api/business-jet-tracker` returns `running: true`.
- `cohortSize: 5244`.
- `snapshot: null` because old snapshots were purged.
- `lastError: business jet tracker source poller returned no aircraft; skipping snapshot`.
- The app poller is currently empty because OpenSky credits are exhausted until `2026-05-07T01:03:19.259Z`.

The tracker will work better with an actual tar1090/readsb heatmap URL configured via `BUSINESS_JET_HEATMAP_URL`; the poller fallback is functional but is not the exact heatmap source requested.

## Verification Performed

Passed:

```bash
node --check backend/businessJetTracker.js
node --check backend/db.js
npm run build --prefix frontend
```

Also smoke-tested:

- Tracker state API.
- Strict cohort rebuild from FAA registry data.
- Local API returned `cohortSize: 5244` and strict tier/owner breakdown.
- In-app browser confirmed `Early Warning`, `wealth-signal aircraft cohort`, `5,244`, `large cabin 3325`, `ultra long range 1919`, `no sample yet`, and the no-feed error are visible.

Known existing test failures:

```bash
npm test --prefix backend
```

The full backend suite is not clean in this checkout. Failures were in older poller/position tests involving OpenSky credit/mocking behavior and `getPositionTrail` fixtures. They did not appear tied to the new tracker path, but they remain unresolved.

## Dirty Worktree Notes

Pre-existing unrelated modified worktree pointers were present under:

- `.claude/worktrees/charming-jones-8820cd`
- `.claude/worktrees/friendly-austin-ce036f`
- `.claude/worktrees/hardcore-villani-8f1d2a`
- `.claude/worktrees/relaxed-robinson-2e6676`

Do not revert those unless the user explicitly asks.

Files changed for this feature:

- `.gitignore`
- `backend/db.js`
- `backend/index.js`
- `backend/jobs/faaRegistryJob.js`
- `backend/businessJetTracker.js`
- `backend/scripts/backfill-business-jets.js`
- `frontend/src/App.jsx`
- `frontend/src/index.css`
- `frontend/src/services/dashboard.js`
- `frontend/src/components/BusinessJetTracker.jsx`

## Suggested Next Steps

1. Configure a real tar1090/readsb live snapshot URL:

```env
BUSINESS_JET_HEATMAP_URL=https://example/path/aircraft.json
```

2. Configure historical source template:

```env
BUSINESS_JET_HISTORY_URL_TEMPLATE=https://example/history/{yyyy}/{MM}/{dd}/{HH}{mm}{ss}Z.json.gz
```

3. Run backfill for the trailing year in chunks. Start with one day to confirm provider path and rate behavior.

4. Revisit cohort precision after seeing false positives/false negatives. The current filter is practical and reproducible, but not perfect.

5. Add focused tests for:

- `parseAircraftRefLine`.
- cohort rebuild selection.
- tar1090 normalization.
- baseline p99/unusual score.
- API response shape.
