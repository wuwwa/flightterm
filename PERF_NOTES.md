# flightterm performance notes

A running log of what we tried, why, and what the measurable outcome was.
Append-only. Most recent at bottom.

---

## 2026-04-18 — Event-loop stall root-cause

**Symptom:** `/api/health/ready` taking 6–9 s to respond. Fly health checks
flapping critical/passing. SWIM worker's internal POSTs hitting `timeout of
10000ms exceeded` because the main app's loop was frozen when SWIM tried to
push. User reported "flightterm crashed" — but the machine never actually
restarted. Alive but unresponsive.

**Real cause, ranked:**

1. **Anomaly scoring loop** in `poller.js` iterated ~6800 flights with no
   `setImmediate` yield. Per iteration: `scoreAnomaly()` (CPU-heavy branching/
   math) + up to 2 DB lookups (`getFlowEventsByAirport`,
   `getTerminalWeatherByAirport`). Result: 20–40 s of sync work per poll.
2. `db.exec('ANALYZE')` fired synchronously after every sightings purge
   (`purgeOldSightings`). On a 400 MB DB, ANALYZE blocks 10–20 s.
3. `db.exec('VACUUM')` fired synchronously in `enforceStorageCap` whenever
   DB > `STORAGE_CAP_MB`. Blocks 20–40 s on 400 MB DB.

**What worked:**

- Chunked the scoring loop: `SCORE_CHUNK = 500`, `await new Promise(r =>
  setImmediate(r))` between chunks. Same pattern for the APL re-score loop
  (`RESCORE_CHUNK = 100`).
- Added per-cycle memoization for `getFlowEventsByAirport` /
  `getTerminalWeatherByAirport` (map by airport; many flights share dest).
- Hoisted `require('./anomaly')` out of the hot path. Tiny win but free.
- Removed the sync `ANALYZE` from `purgeOldSightings`. Query planner tolerates
  stale stats. Daily dedup pass still refreshes them.
- Raised `STORAGE_CAP_MB` (via env in `fly.toml`) to keep the file size under
  the cap so `enforceStorageCap` never fires.

**Numbers after:** health endpoint went 6–9 s → 145–180 ms. Post-deploy event
loop `max=48016ms p99=51ms` — a single startup hit (deferred maintenance),
then the 99th percentile settled sub-second.

**Gotcha:** `new Date(0).toISOString()` as the `lastLifecycleCheckIso`
watermark meant the first call to `cleanupLandedFlights` pulled *every*
TFMS/STDDS landing since 1970. Burst size is bounded by the tables' 2h
retention, so it's only a few hundred rows — noisy but fine.

---

## 2026-04-18 — Global retention cap

**Why:** user wanted "max 2 hours" across everything. Said "I'm not looking
to store anything."

**What changed:**

- In-code cutoffs (`db.js`): notams, terminal_weather, surface_events,
  position_history, callsign_routes → all `-2 hours`. Was 6h–60d.
- Env (`fly.toml`): `TFMS_PLANS_RETENTION_HOURS=2`,
  `TFMS_FLOW_RETENTION_HOURS=2`, `PURGE_AFTER_HOURS=2`.
- `archiveToDailySummary` call disabled inside `purgeOldSightings` — S3
  archival is off, daily rollups were dead weight.
- `rollupYesterday` call removed from `runPurgeCycle` — 90d zone rollup was
  the table with the longest retention, now empty.
- `zoneDailyPurge` cutoff flipped to `DATE('now', '+1 day')` = wipe all.
- `purgeOldDailySummaries` cutoff flipped similarly = wipe all.

**Numbers after:** DB went 398 MB → 71.5 MB in one purge cycle, stabilized
around 90–120 MB at steady state.

---

## 2026-04-18 — Flight lifecycle cleanup (end-to-end tracking)

**Goal:** drop a flight's rows as soon as it lands, not wait for the 2h cap.

**Design:** 4 signals OR'd, first to fire wins:

1. `flight_plans.ata IS NOT NULL` since last check (authoritative — TFMS)
2. `surface_events.event_type='ON'` since last check (STDDS, ~40 US airports)
3. `grounded=1` for 3 consecutive cycles AND within 5 nm of TFMS `arr_arpt`
4. Aircraft in `trackHistory` not seen in 5 min → treat as landed/lost

Per-callsign TTL (`purgedCallsigns`, 30 min) dedups repeat triggers.

**What worked:**

- `deleteFlightArtifacts({icao, callsign})` cascades DELETE across
  `sightings` (by icao), `anomalies` (by icao), `flight_positions` (by
  callsign), `flight_plans` (by acid). One DB transaction per flight.
- Clearing poller in-memory state (`trackHistory`, `activeAnomalies`,
  `enrichCache`, etc.) keyed by icao at the same time.
- Added `callsign` to trackHistory snapshots so the "lost" path can still
  reach flight_plans even after the aircraft is out of the feed.

**What didn't work (v1):** the cleanup loop was unchunked. First post-restart
cycle found ~88 landed flights (big backlog), did 88 back-to-back sync
transactions = 350 DB calls, event-loop `max=5759ms`. Same pattern as the
pre-fix scoring loop.

**Fix:** `CLEANUP_CHUNK=20`, `await new Promise(r => setImmediate(r))` every
20 deletes. Same recipe as scoring-loop chunking. Event loop back under 2 s.

**Numbers after:** `lifecycle: purged N landed/lost flights (tfms=X, stdds=Y,
nearDest=Z, lost=W, rows=R)` lines appear on cycles where aircraft land.
`nearDest` is the dominant signal so far; TFMS `ata` and STDDS `ON` lag
5–10 min behind actual touchdown.

**Gotcha:** `nearDest` stat kept being high (50+) while `purged` was low
(1) — that's the TTL dedup working. Aircraft sit at the gate, still
transmitting grounded=1, keep re-triggering the signal every cycle. The
30-min `purgedCallsigns` TTL correctly swallows the repeats.

---

## 2026-04-18 — Rate limiter dysfunction

**Symptom:** dashboard sporadically showed `rate limit exceeded — try again
shortly`. Curl from outside the app returned HTTP 429. User thought the app
had "crashed again."

**Root causes (plural):**

1. **No `app.set('trust proxy', ...)` on Express.** Fly routes all traffic
   through its edge proxy. Without trust proxy set, `req.ip` reads as the
   Fly-proxy internal IP. Rate limiter was keying on that = one shared
   bucket for everybody + all internal health probes + all SWIM worker
   traffic. Effectively unlimited confusion about who's over quota.
2. `/api/health/*` and `/internal/*` counted against the user's bucket.
   Fly live-probes every 15 s + ready every 30 s = 6 req/min eaten before
   the user touches anything. SWIM worker POSTs did the same.
3. `RATE_MAX=100`/min was sized for an untrusted single-user scenario.
   Actual dashboard cadence: LiveFeed 12/min + NasMap 10/min + flights 3/min
   + ~15 more panels. Sustained 40–80 req/min with bursts.

**What worked:**

- `app.set('trust proxy', 1)` — trust first hop (Fly proxy).
- `skip: (req) => req.originalUrl.startsWith('/api/health') ||
   req.originalUrl.startsWith('/internal/')` in the rate-limit config.
- `RATE_MAX=600` via `fly.toml` env.
- Tightened weather proxy axios timeouts from 10s → 5s so one slow upstream
  can't stretch event-loop work.

**Numbers after:** `ratelimit-policy: 600;w=60` visible in response headers.
`/api/flights` 200 in ~1 s. Health endpoint returns no RateLimit headers
(skip working). Event-loop `max=1682ms` on first post-deploy cycle.

---

## 2026-04-18 — Third-party API fan-out (this one)

**Symptom:** user reported "crashed again." Logs:

```
slow-req 32315ms GET /api/context/aircraft/a1d49e
slow-req 30077ms GET /api/context/aircraft/a02b2d
slow-req 16402ms GET /api/adsbfi/hex/a02b2d
slow-req 10716ms GET /api/hexdb/route/TCF650
circuit-breaker: airplaneslive tripped after 3 failures
⚠ event-loop max=7680ms
```

Machine alive. No restarts. RSS 358/1024 MB. Classic "alive but slow."

**Cause:** `/api/context/aircraft/:icao` calls `buildContext()` in
`correlation.js`, which does `Promise.all([...10 external APIs...])`. Each
fetcher has a 10–15 s timeout. Request latency = max(all 10). When USGS or
OpenAQ or Mapillary is slow that day, every aircraft click costs 30+ s.

Other offenders: `/api/adsbfi/hex/*` and `/api/hexdb/route/*` are thin
passthroughs to flaky third-party APIs with no caching, no coalescing, no
staleness tolerance.

**Plan (implementing now):**

1. Add an `swrGet(key, freshMs, staleMs, fetcher)` helper: returns cached
   value if fresh; returns stale value + kicks off background refresh if
   within grace; else awaits the new fetch. Concurrent callers for the same
   key share one inflight promise.
2. Wrap the worst offenders:
   - `/api/context/aircraft/:icao` — key by icao, 30 s fresh / 5 min stale
   - `/api/adsbfi/hex/:hex` — key by hex, 5 min fresh / 1 h stale
   - `/api/adsbfi/callsign/:cs` — same
   - `/api/hexdb/route/:callsign` — 30 min fresh / 24 h stale (routes change
     slowly)
3. Tighten axios timeouts inside `buildContext`'s sub-fetchers from 10–15 s
   → 4 s. A slow API should trip its own timeout long before the overall
   endpoint gives up.

**Not doing (by user directive):** no infra changes. Fly machine stays
`shared-cpu-1x:1024mb`. No vertical scale.

**What shipped:**

- `swrGet(key, freshMs, staleMs, fetcher)` helper in `index.js` near the
  existing `memoizedAsync`. Entry shape `{ value, fetchedAt, inflight }`.
  Graceful degradation: on fetcher rejection, if we have stale-in-grace we
  serve it instead of bubbling the error. 5000-entry LRU cap.
- `/api/context/aircraft/:icao` wrapped. Key = `ctx:aircraft:{icao}:
  {latBucket}:{lonBucket}` where buckets are `round(x*10)/10` (~11 km).
  Bucketing means a fast-moving aircraft pierces the bucket and gets fresh
  context; a slow or stationary one reuses the bundle. 30 s fresh / 5 min
  stale.
- `/api/adsbfi/hex/:hex` + `/api/adsbfi/callsign/:cs` wrapped. 5 min fresh /
  1 h stale. Per-endpoint axios timeout dropped 10 s → 4 s.
- `/api/hexdb/route/:callsign` wrapped. 30 min fresh / 24 h stale. Per-call
  axios timeouts dropped 8 s → 4 s.
- Every axios timeout in `backend/context/*.js` bulk-dropped 10–15 s → 4 s
  (eonet, firms, mapillary, nps, openaq, openMeteo, owm, sentinel, swpc,
  usgsEvents). `buildContext` now has a hard ~4 s ceiling from any sub-call.

**Numbers after:**

| Endpoint | Before | After (1st call) | After (2nd call, SWR hit) |
|---|---|---|---|
| `/api/health/ready` | 6–9 s | 810 ms | — |
| `/api/adsbfi/hex/*`  | 10–16 s | 299 ms | (cached fresh) |
| `/api/hexdb/route/*` | 4–10 s | 718 ms | (cached fresh) |
| `/api/context/aircraft/*` | 18–32 s | 2.59 s | **224 ms** |

Event-loop `max=1653ms p99=380ms` on the first post-deploy cycle — compare
to pre-deploy `max=9446ms p99=9446ms` (sustained block). p99 dropping below
500 ms means the loop stays responsive between occasional brief blips.

**Gotchas / followups to consider if regressions show up:**

- SWR graceful degradation means a user can see stale data for up to staleMs
  if upstream goes fully dark. Acceptable for this app — weather/fires/
  NOTAMs don't change every second. But a "last-refreshed-at" badge in the
  UI would help users trust it.
- `ctxWrap` error handler is still wired, but the SWR wrapper catches and
  either returns stale or rethrows — `ctxWrap` only sees the rethrown case.
  Kept intentionally so schema/crash errors still get logged via ctxWrap.
- `_swrCache` is in-process. On deploy the cache empties and the first
  hundred requests take the cache-miss path. Not a problem because they
  still benefit from the 4 s timeouts; just something to know.
- LRU eviction is O(1) using Map insertion order but doesn't track
  access-recency. An entry that's frequently read but not refreshed can
  still be evicted first. Fine for this workload; upgrade to true LRU if
  we see cache-miss rates climb for hot keys.

---

## 2026-04-18 — UI status machine

**Problem:** the top banner said "fetching flights…" as a constant string
regardless of actual state. User saw `loading…rate limit exceeded` in the
"Now Showing" header at the same time as the flights table had data — the
components disagreed about whether anything was happening.

**Root cause:** `statusText` was just `'idle' | 'fetching'`. Errors went
only to the log panel. No indication of staleness or 429.

**What shipped:**

- `statusText` state expanded: `'idle' | 'fetching' | 'rate-limited' |
  'error: <kind>' | 'stale'`. Error kind classified in `fetchFlights` from
  the axios exception (status 429 → rate-limited, ECONNABORTED → timeout,
  5xx → server, else → network).
- `lastFetchError` state: `{ kind, message, at } | null`. Cleared on the
  next successful fetch. Available to any child component that cares.
- `fetchFlights` now returns the error kind (or null on success). `boot()`
  reads the return value to put a specific message in `bootMsg` — no more
  "loading flights…" frozen on screen when the initial fetch 429s.
- Bottom status pill in App.jsx: when `statusText` is any error/stale
  variant, it flips to red-on-black. When healthy, it shows "idle · Ns"
  with tabular age since the last fetch so you can eyeball freshness.
- `InterestingFeed.jsx` no longer shows `'loading…'` when an error is
  present; shows `—` plus the red error label instead. Fixes the exact
  screenshot-of-shame the user posted.

**What I deliberately didn't do:**

- Per-endpoint staleness badges. The SWR cache is server-side and returning
  stale is mostly invisible to users (weather/fires don't change per second).
  If this becomes a trust issue I'll add `X-Data-Fetched-At` headers + a
  frontend "data from Ns ago" pill — but that's 3x the code for modest
  marginal value right now.
- Exposing `lastFetchError` as a toast or prominent banner. The status pill
  change is enough signal; a toast would be overkill for transient 429s.

---

## 2026-04-18 — Mobile responsive pass

**Symptom (and a thread that almost wasn't):** user reported "the text,
especially the numbers are enlarged. this is weird." I burned ~30 min in
Playwright proving every text element was at its expected pixel size. The
real issue was attention-grab, not actual size: I had added a `· Ns` age
suffix to the bottom status pill (on top of `idle`/`fetching`), which
duplicated the LiveBadge countdown that's already in the CommandBar. The
extra digit cluster on a previously text-only pill made the whole bottom
right feel "number-heavy."

**Fix:** dropped the age suffix from the bottom pill. State word only.
LiveBadge in CommandBar already shows the countdown — no duplication.

**Lesson worth keeping:** when the user says something "looks bigger,"
don't trust your computed-style measurements alone. Visual density and
contextual contrast (a number where there used to be a word, an isolated
element on whitespace) reads as size even when pixel size hasn't changed.

### Mobile MCP audit (Playwright at 375 / 390 / 1440 px)

**What I found:**

1. CommandBar wrapped to 4 rows on phones because `flex flex-wrap` +
   `ml-auto` on the right cluster meant the clock always pushed to its own
   line. Eats ~120 px of vertical viewport before any flight data.
2. FlightTable mobile rows were a single line of bare numbers
   (`N128BA A5 - 151 79 -138 CLB`). With the column headers stripped via
   `hidden sm:table-cell`, a user without prior context can't tell what
   the numbers are.
3. InterestingFeed primary text used `truncate`, which cuts mid-word
   ("diversion anomaly (critic…").
4. `mobileTab` and `mobileTime` state declared in App.jsx never used —
   leftover from a tab-nav refactor that got abandoned. Not fixed (out of
   scope) but worth a future cleanup.

**What shipped:**

- **CommandBar mobile collapse** ([CommandBar.jsx:138+](frontend/src/components/CommandBar.jsx)).
  On `< sm`, region pills + settings/usage/clear + clock cluster are
  hidden. A single `⋯` button in the top-right toggles a second-row
  expansion containing all of them. Auto-collapses after a region/control
  click. Desktop layout unchanged. Result: phone CommandBar is one row
  ~24 px instead of four rows ~120 px.
- **FlightTable two-line mobile rows** ([FlightTable.jsx:398](frontend/src/components/FlightTable.jsx)).
  Line 1: identity + phase pill (`UAL2002 B738 7142 ... CLB`). Line 2:
  metrics with unit suffixes (`alt -75ft  spd 131kt  v/r -571fpm  a2b001`).
  No more uncontextualized number salad.
- **InterestingFeed text wrap** ([InterestingFeed.jsx:57](frontend/src/components/InterestingFeed.jsx)).
  Primary description uses `-webkit-line-clamp: 2` on mobile, falls back
  to single-line truncate on `sm+` where there's room.

**Verified visually at 375 × 812 and 1440 × 900.** Screenshots in
`.playwright-mcp/` (mobile-with-data.png, desktop-with-data.png).

**Gotchas:**

- The `-webkit-box` line-clamp pattern is widely supported but uses an
  inline `style={}` to set the orient/clamp because Tailwind doesn't have
  built-in classes for those. Acceptable for one component; if more spots
  need it I'd add a Tailwind plugin.
- Mobile expansion doesn't animate (no slide-down). Pure conditional render.
  Cheap and reliable; can add transition later if it feels jarring.
- The disclosure button uses `⋯` / `×` glyphs. Some glyph fonts render
  these at slightly different baselines; I used `leading-none` to keep
  the button height consistent with the bar.

---

## 2026-04-18 — Map quadrants (v5.7.0)

**Why:** the single big map had 16 overlay toggles. To compare two
categories (e.g. "weather near diversions") users had to toggle one off,
look, toggle it back, toggle the other off, look. No side-by-side view.

**Options weighed:** mode presets (cheap), tabbed map (medium), inset
overview maps (medium-high), or full 2×2 quadrant grid (high effort,
highest UX win). User picked A (quadrants) after weighing tradeoffs.

**What shipped:**

- **New `MapQuadrants.jsx`** renders a 2×2 grid on `lg+`:
  `Traffic | Weather` / `Constraints | Geo events`. Falls back to a single
  full-controls NasMap on `< lg` so mobile keeps the existing behaviour.
- **`categoryFilter` prop on `NasMap`** — when set to an array of layer
  keys (`['flights', 'anomalies', ...]`), the toggle UI hides and only
  listed layers render. Implemented by driving the existing `show*` state
  from the filter via useState initializers + a join-keyed useEffect
  sync. Kept the downstream useMemo/useEffect graph untouched — the
  refactor is almost purely additive.
- **Shared pan/zoom via `ViewSync` child component.** Parent owns
  `viewState = { center, zoom }`. Each panel's `ViewSync` uses `useMap()`
  to apply external viewState changes AND broadcast user-driven moves.
  An `applyingExternalRef` flag prevents the ping-pong (external apply
  → moveend → rebroadcast → external apply → …).
- **Category mapping:**
  - Traffic: `flights, ifr, tracon, anomalies, routeDevs`
  - Weather: `sigmets, pireps, wxCells`
  - Constraints: `tfrs, notams, flowPrograms, cascades`
  - Geo events: `fires, events, quakes, volcanoes, webcams`

**What worked:**

- No-op detection in ViewSync (skip `setView` if current center/zoom
  already matches within 0.001 deg + exact zoom match) prevented one
  class of ping-pong bug that showed up during testing.
- Keying the filter-sync useEffect on `categoryFilter?.join('|')`
  instead of the array identity — parent can pass a literal array
  every render without triggering unnecessary re-syncs.
- Verified visually at 1440×900 (2x2 grid renders with each panel
  showing only its category data, confirmed by presence of anomaly
  circles only in Traffic and SIGMET triangles only in Weather) and
  at 390×844 (mobile single-map still works with full toggle strip).

**What didn't fully work / followups:**

- Both the mobile NasMap (`lg:hidden`) and the 4 quadrant NasMaps
  (`hidden lg:grid`) are always mounted — `hidden` is CSS-level, so
  React still mounts all 5 instances. Each runs its own fetch effects
  so we're doing 5× the upstream API calls. Backend SWR cache dedupes
  the heavy ones (context/hexdb/adsbfi), but anomaly/tfr/sigmet/weather
  polls are all in-flight × 5. Fix: wrap in a `useMediaQuery('(min-width:
  1024px)')` and conditionally mount either the mobile or desktop tree.
  Parking for v5.7.1.
- `ViewSync` treats every `moveend` / `zoomend` as user-driven unless
  the applyingExternalRef flag is set. If Leaflet ever fires those
  events spontaneously (e.g. from invalidateSize), we'd broadcast a
  "no change" view back — but the no-op detection in the apply path
  catches this cleanly so no loop forms.
- Desktop fly-over URLs (hash-based deep links to a flight dossier)
  still work from the Traffic panel since it has the flight dots.
  Panels in Weather/Constraints/Geo can't select a flight — they
  wouldn't have the marker anyway. No regression.
- Per-panel hover linking (hover an aircraft in Traffic to dim it
  in others) was in the original plan but skipped for v1. Requires
  lifting hover state and adding per-marker opacity logic across 4
  panels. Probably worth doing as v5.7.1 polish if users miss it.

---

## 2026-04-18 — Pivot from quadrants to focus + context (v5.7.1)

**Why v5.7.0 didn't work:** after shipping the 2×2 quadrant grid, the user
hit both failure modes I'd worried about when weighing options:

1. **"Zooming one zooms all"** — synced zoom meant they couldn't drill into
   a single panel for detail while keeping the others panoramic for context.
2. **"Too much data, can't read any of it"** — CONUS-scale data packed
   into 716×404 px panels was unreadable. The original big map had 5× the
   pixels per square degree of state.

**Root cause:** categorical quadrants assumed users want every category
visible at the same detail level. In practice they want *focus on one
thing* + *overview of the others*. Quadrants solved the "too many toggles"
problem but created a "too-small canvas" problem that was worse.

**What shipped in v5.7.1:**

- **Same file (`MapQuadrants.jsx`) repurposed as focus + context.** One
  big primary NasMap on the left takes `grid-cols-[1fr_18rem]`'s main
  column (~1100 px at 1440 width) with full pan/zoom. Three thumbnail
  NasMaps stacked on the right in the narrow column show the other
  categories at a pinned CONUS view.
- **Thumbnails are non-interactive buttons.** Clicking one promotes it
  to primary via `setCategoryOrder` array swap. Current primary's view
  is preserved (feels like "same area, different category"). The thumbnail
  wrapper has `pointer-events-none` on the map so Leaflet interactions
  stay disabled — every click goes to the promote button.
- **New `staticView` prop on NasMap** disables `dragging`,
  `doubleClickZoom`, `touchZoom`, `boxZoom`, `keyboard`, and hides the
  zoom buttons. Lets the thumbnails render as still pictures.
- **THUMBNAIL_VIEW = `{ center: [38.5, -96], zoom: 3 }`** — pinned CONUS
  frame shared by all three thumbnails. Zoom 3 was too wide at
  thumbnail size in the first draft; adjusted center latitude to 38.5
  so the US fills the frame without Canadian tundra dominating.
- **PRIMARY_DEFAULT_VIEW = `{ center: [39, -96], zoom: 4 }`** — matches
  the original big-map default. Kept separate from THUMBNAIL_VIEW
  because primary needs more detail than thumbnails do.

**What worked:**

- The mental model "promote a thumbnail to look closer, keep the others
  as context" is immediately obvious — no onboarding needed.
- `pointer-events-none` + `onClick` on the wrapping `<button>` gave
  click-to-focus for free without wrestling with Leaflet click handlers.
- Verified visually: Traffic primary → click Weather thumb → Weather
  primary, Traffic moves into top thumbnail slot, the other two slide
  down. Pan state carries over (intentional).

**Known limitations:**

- The thumbnails still mount full NasMap instances, which each run the
  same fetch useEffects on the same endpoints. With 4 maps live at
  any time, we're doing 4× the outbound requests for the heavy map
  data layers (TFRs, SIGMETs, PIREPs, route deviations, etc.). Backend
  server-side caching (90 s memoized weather, 30 min hexdb SWR, etc.)
  dedupes most of the pain. v5.7.2 followup: lift shared fetches into
  MapQuadrants and pass data down as props.
- Both the mobile `lg:hidden` NasMap and the 4 desktop NasMaps are
  always DOM-mounted — same flaw from v5.7.0 still present. Fix needs
  a `useMediaQuery('(min-width: 1024px)')` hook to conditionally mount.
- Thumbnails don't visually indicate "this is the current primary's
  paired context for area X" — when you zoom into the east coast in
  Traffic primary, thumbnails still show CONUS overview. For this app
  that's intentional (national context > regional echo), but some
  users may expect the thumbnails to follow. Easy to add a small
  "sync thumbnails" toggle later if it comes up.

**Files touched:**

- `frontend/src/components/dashboard/MapQuadrants.jsx` — full rewrite
  (the component name is a leftover from v5.7.0; kept the name so
  DashboardPanel didn't need to re-import).
- `frontend/src/components/dashboard/NasMap.jsx` — added `staticView`
  prop that disables every Leaflet interaction flag. ~6 lines change.

---

## 2026-04-18 — Headline summaries (v5.7.2)

**User feedback after v5.7.1:** "It's still not very obvious what I'm
looking at. Just icons and shit on the map." Then "no real feedback"
(stop iterating without me) and finally "figure it out."

**Read:** the focus+context layout solved layout density but a map full
of unlabeled icons is still a visual riddle. A user without aviation
domain knowledge can't decode "red triangle = SIGMET, yellow diamond =
PIREP." The fix isn't more layout; it's plain-language summaries.

**What I considered and rejected:**

- A passive **legend** (icon → name swatches). Tells you what the icon
  means but not what's important. Skipped.
- **Aggressive density culling** (drop 5,000 background dots, keep only
  critical items). Real win but high risk — easy to cull something the
  user wanted. Saving for v5.7.3 if headlines aren't enough.
- A **separate alerts sidebar**. Already exists as the InterestingFeed
  at the top of the page; duplicating it next to the map adds chrome
  without adding signal.

**What shipped:**

- New `onSummaryChange` callback on `NasMap`. Fires whenever any of the
  visible-data arrays (anomalies, sigmets, devLines, etc.) change.
  Reports back `{ counts, headlines }`:
  - `counts` — `{ flights: 3625, anomalies: 100, sigmets: 4, ... }`
    every layer's count.
  - `headlines` — array of top-3 named items per category, computed
    inside NasMap because the data + ranking logic already lives there.
    Each entry: `{ cat, kind, label, detail }`. Examples:
    `{ cat: 'traffic', kind: 'critical', label: 'KOW186', detail: 'hijack' }`,
    `{ cat: 'weather', kind: 'convective', label: 'CONVECTIVE', detail: 'SEV TS FL250+' }`,
    `{ cat: 'constraints', kind: 'critical', label: 'JFK', detail: 'ground stop' }`,
    `{ cat: 'geo', kind: 'critical', label: 'M5.2', detail: 'near LA' }`.
- `MapQuadrants` collects per-category summaries via callback and
  renders a `<HeadlineStrip>` between the panel header and the map.
  Two lines:
  - Line 1 — count chips colored by severity (e.g. red `100 anomalies`,
    yellow `16 off-route`).
  - Line 2 — top-N named items as pill cards, color-tinted by kind
    (critical = red bg, high = yellow, medium = grey).
- Empty state: when a panel has no data AND no headlines, the strip
  renders "no active flights/weather/etc reported" instead of empty
  rows — confirms the panel is alive, just quiet.
- The `compactSize` prop on `<HeadlineStrip>` shows 2 cards instead of
  3 in thumbnails, where horizontal space is tighter.

**Verified visually at 1440×900:** primary panel header now reads
"TRAFFIC · 3,625 flights · 100 anomalies · 16 off-route" with three
DIVERSION pill cards naming the worst offenders. Weather thumb shows
"4 SIGMETs · 257 PIREPs · 24 wx alerts" with two CONVECTIVE pills.
Geo thumb shows "787 fires · 5 quakes · 3 volcanoes · 19 events" with
top quake magnitudes as pills. The map icons now have context — you
read the headlines first, then the icons make sense by association.

**Cheap-equality skip in `setSummaries`:** because each NasMap fires
`onSummaryChange` on every render with a freshly-computed object,
React would re-render MapQuadrants on every NasMap re-render without
any actual change. Used `JSON.stringify` shallow-compare on the new
data before calling `setSummaries` to short-circuit. Not free (stringify
on hot path) but cheap relative to the alternative ping-pong renders.

**Followups (not done):**

- Aggressive density filter on the primary map (only show critical
  anomalies, only severe SIGMETs, etc.) — wait until user says the
  data still feels noisy with headlines in place.
- Lift NasMap's data fetches into MapQuadrants so all 4 instances
  share one fetch per layer. Same v5.7.2 followup carried over from
  v5.7.1; backend SWR cache currently dedupes most of the pain.

---

## 2026-04-18 — Layer toggles + smart defaults (v5.7.3)

**User feedback:** "Certain things should be a filter and toggleable.
There's simply too much showing. Figure out what's important and be on
by default. I'll leave the reasoning to you."

**My reasoning for the per-layer defaults (DEFAULT_ACTIVE in code):**

Each ON-by-default item is something a user would want flagged
unprompted. Each OFF-by-default item is something they'd want to
*summon* when investigating a specific question. Counts stay visible
in the headline strip even when the layer is off — so you know what's
available without it being on screen.

| Category    | ON by default          | OFF by default                       |
|-------------|------------------------|--------------------------------------|
| Traffic     | anomalies, off-route   | flights (3K bg dots), IFR, TRACON    |
| Weather     | SIGMETs, wx alerts     | PIREPs (250+ routine reports)        |
| Constraints | TFRs, flow programs    | NOTAMs (mostly routine), cascades    |
| Geo events  | quakes, volcanoes      | fires (700+ FIRMS hotspots), events, cams |

**What shipped:**

- Lifted per-category active-layer state to MapQuadrants
  (`activeLayers[catKey][layerKey]: bool`).
- Each headline-strip count chip is now a `<ToggleChip>` button. ON =
  colored bg matching the on-map symbology (red anomalies → red chip).
  OFF = dim grey, transparent bg, hover to dial up. Click flips it.
- `categoryFilters[catKey]` derived via `useMemo` from `activeLayers`
  and passed as the existing `categoryFilter` prop to NasMap. The
  filter-sync useEffect inside NasMap (added in v5.7.0) already
  handles toggling layers without re-fetching data.
- Toggle state is session-only (in-memory). A page refresh resets to
  defaults, so a user who turned everything ON one afternoon doesn't
  get burned with the noise next morning. If users complain about
  losing their toggles, swap to localStorage (the original NasMap's
  correlation toggles already use localStorage, so the pattern's there).

**What worked:**

- Tailwind's purge means we can't use string-interpolated color
  classes. Wrote out the on/off chip styles as a literal map
  (COLOR_CLASS_ON) keyed by color slug. Verbose but correct.
- Putting the click handler on the `<button>` chip with an
  `e.stopPropagation()` keeps it from bubbling up to the thumbnail's
  promote-to-primary handler. Thumbnails got refactored to put the
  promote-click on the header + map, leaving the headline strip free
  for chip clicks.
- `JSON.stringify` shallow-equality skip in setSummaries (carried over
  from v5.7.2) was important — every layer toggle re-renders NasMap
  which re-fires onSummaryChange. Without the skip we'd rebuild
  summaries unnecessarily and risk render loops.

**Verified visually at 1440×900:**

Default load: Traffic primary shows just anomalies + diversion lines on
the map, with 100 anomalies / 16 off-route as bright chips and 3,533
flights / 0 IFR / 0 tracon as dim chips. Weather thumb shows just 4
SIGMETs + wx alerts (no PIREP diamond noise). Constraints shows just
flow program markers. Geo shows just quake circles (no FIRMS fire
clutter).

Click "3,533 flights" chip → it brightens, gray dots appear on the
Traffic map. Click again → dots disappear, chip dims back. Other
panels unaffected.

**Followups:**

- Persist toggles to localStorage if users actually want their state
  preserved across reloads. Currently session-only by design.
- The `flights` chip color is `fg3` (muted grey) so even when ON it
  doesn't pop visually — by design, since flight dots themselves are
  background data. May reconsider if users find it confusing.
- Per-layer severity thresholds (e.g. "show anomalies but only HIGH+")
  aren't filterable yet. The toggles are binary on/off. Add a
  modifier dropdown if the binary granularity isn't enough.
