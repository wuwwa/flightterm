// ── Interesting-flights feed (v5.2.0) ──────────────────────────────────────
// Returns a ranked slice of the current flight cache — "what's worth your
// attention right now."
//
// Pipeline:
//   1. Pull all poller flights (~5k live in CONUS mode).
//   2. Cheap pre-filter via `isCandidate` — squawk, callsign prior, route
//      deviation, military flag, or slow+low (possible orbit).
//   3. For each candidate, pull its recent sighting track and look up any
//      active anomaly keyed on ICAO.
//   4. Score each candidate, filter below a min-score threshold, sort, cap.
//
// Cost: step 2 trims ~5k to typically 50–300 candidates. Step 3 is N DB
// queries for those candidates. Cached 20 s to absorb repeated polling.

// v5.7.5+ — must require poller-host (the main-thread facade) instead of
// the raw poller module. The real poller now runs in a worker thread; the
// raw module in main thread is a zombie with empty latestFlights, which
// caused /api/feed/interesting to return `totalFlights: 0` after the
// worker_thread refactor.
const poller = require('../poller-host')
const { getAircraftTrack, getActiveAnomalies } = require('../db')
const { scoreFlight, isCandidate } = require('./score')
const milCache = require('./milCache')

let _cache = null  // { t, v }
const TTL_MS = 20_000
const DEFAULT_LIMIT = 20
const MIN_SCORE = 20

function getInterestingFlights({ limit = DEFAULT_LIMIT } = {}) {
  if (_cache && Date.now() - _cache.t < TTL_MS) {
    return { ...(_cache.v), cached: true, items: _cache.v.items.slice(0, limit) }
  }

  const flightBundle = poller.getFlights?.() || { flights: [] }
  const all = flightBundle.flights || []

  // v5.2.1 — enrich each flight with the military flag from APL /mil cache
  // before scoring, since OpenSky state vectors don't carry it and the
  // poller stores `mil: false` for everything.
  for (const f of all) {
    if (!f.mil && f.icao && milCache.isMil(f.icao)) f.mil = true
  }

  const candidates = all.filter(isCandidate)

  // Index active anomalies by icao for O(1) lookup.
  let anomalyByIcao = new Map()
  try {
    for (const a of getActiveAnomalies()) {
      if (a?.icao) anomalyByIcao.set(a.icao.toLowerCase(), a)
    }
  } catch { /* DB unavailable — anomaly signal just drops out */ }

  const scored = []
  for (const f of candidates) {
    let track = null
    // Only fetch track for flights that might benefit from orbit detection —
    // i.e. the "slow + low + airborne" subset. Flights already earning points
    // from squawk / callsign / route / mil don't need it unless we want to
    // boost them further. For simplicity + cost, gate track-fetch on speed.
    const velKt = f.vel != null ? f.vel * 1.944 : null
    const altFt = f.alt != null ? f.alt * 3.281 : null
    const mightOrbit = !f.grounded && velKt != null && velKt < 250 && altFt != null && altFt < 18000
    if (mightOrbit) {
      try { track = getAircraftTrack(f.icao, 60) } catch { /* ignore */ }
    }
    const anomaly = anomalyByIcao.get((f.icao || '').toLowerCase()) || null
    const { score, primary, tags } = scoreFlight({ flight: f, track, anomaly })
    if (score >= MIN_SCORE) {
      // Hoist the size/use category out of the tags array. classifyAircraft
      // attaches it as `{ source: 'category', weight: 0, label: <category> }`
      // so the frontend can chip-filter by category cleanly.
      const catTag = (tags || []).find(t => t.source === 'category')
      // Also surface a flat list of plain tag labels (not the weighted form),
      // for chip-based filtering. Excludes the category pseudo-tag.
      const labels = (tags || [])
        .filter(t => t.source !== 'category')
        .map(t => t.label)
      scored.push({
        icao: f.icao,
        callsign: f.callsign,
        acType: f.acType,
        acReg: f.acReg,
        acOperator: f.acOperator,
        lat: f.lat, lon: f.lon,
        altFt: altFt != null ? Math.round(altFt) : null,
        velKt: velKt != null ? Math.round(velKt) : null,
        hdg: f.hdg,
        squawk: f.squawk,
        mil: !!f.mil,
        grounded: !!f.grounded,
        routeDeviation: f.routeDeviation || 0,
        category: catTag?.label || null,
        labels,
        score,
        primary,
        tags,
      })
    }
  }

  scored.sort((a, b) => b.score - a.score)

  const out = {
    generatedAt: new Date().toISOString(),
    totalFlights: all.length,
    candidatePool: candidates.length,
    ranked: scored.length,
    items: scored.slice(0, Math.max(limit, 50)),  // keep a few extra in cache
  }
  _cache = { t: Date.now(), v: out }
  return { ...out, cached: false, items: out.items.slice(0, limit) }
}

module.exports = { getInterestingFlights }
