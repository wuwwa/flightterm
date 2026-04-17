// ── Flight Dossier aggregator client (v5.3.0) ─────────────────────────────
// Single-icao deep-dive fetcher. Parallel-fetches every source we have for
// a given aircraft so the Dossier page can render sections as they resolve.
//
// Each fetch resolves to a `{ section, data }` or `{ section, error }` so the
// UI renders partial results gracefully — one source failing doesn't block
// anything else.

import axios from 'axios'

const T_SHORT = 8_000
const T_MED = 15_000
const T_LONG = 25_000

function wrap(section, promise) {
  return promise
    .then(data => ({ section, data }))
    .catch(err => ({ section, error: err.response?.data?.error || err.message }))
}

export async function fetchLive(icao) {
  const res = await axios.get(`/api/flights/${icao}`, { timeout: T_SHORT })
  return res.data
}

export async function fetchTrack(icao, limit = 200) {
  const res = await axios.get(`/api/sightings/track/${icao}`, { params: { limit }, timeout: T_MED })
  return res.data
}

export async function fetchHistorySummary(icao) {
  const res = await axios.get(`/api/flight/${icao}/history`, { timeout: T_MED })
  return res.data
}

export async function fetchAnomalyHistory(icao, limit = 20) {
  const res = await axios.get(`/api/anomalies/aircraft/${icao}`, { params: { limit }, timeout: T_MED })
  return res.data
}

export async function fetchAplHex(icao) {
  const res = await axios.get(`/api/apl/hex`, { params: { hex: icao }, timeout: T_MED })
  return res.data
}

export async function fetchAdsbfiHex(icao) {
  const res = await axios.get(`/api/adsbfi/hex/${icao}`, { timeout: T_MED })
  return res.data
}

export async function fetchHexdbRoute(callsign) {
  const res = await axios.get(`/api/hexdb/route/${callsign}`, { timeout: T_MED })
  return res.data
}

export async function fetchAircraftContext(icao, params = {}) {
  const res = await axios.get(`/api/context/aircraft/${icao}`, { params, timeout: T_LONG })
  return res.data
}

export async function fetchMetar(icaoId) {
  const res = await axios.get(`/api/weather/metar`, { params: { ids: icaoId }, timeout: T_MED })
  return res.data
}

export async function fetchSigmets(hazard) {
  const params = {}
  if (hazard) params.hazard = hazard
  const res = await axios.get(`/api/weather/sigmet`, { params, timeout: T_MED })
  return res.data
}

// ── Dossier aggregator ─────────────────────────────────────────────────────
// Returns a Promise that resolves progressively via onSection callback.
// Final resolve fires once all sections finished (successfully or not).
//
// `icao` is canonical (lowercase hex). `callsign` is optional — when present,
// unlocks the hexdb route + destination-airport weather fetches.
export async function fetchDossier(icao, { callsign = null, onSection = () => {} } = {}) {
  // Kick off every fetch immediately so they race.
  const hexLower = (icao || '').toLowerCase()

  const jobs = [
    wrap('live',       fetchLive(hexLower)),
    wrap('track',      fetchTrack(hexLower, 200)),
    wrap('history',    fetchHistorySummary(hexLower)),
    wrap('anomalies',  fetchAnomalyHistory(hexLower, 20)),
    wrap('apl',        fetchAplHex(hexLower)),
    wrap('adsbfi',     fetchAdsbfiHex(hexLower)),
    wrap('sigmets',    fetchSigmets()),
  ]
  if (callsign && callsign !== '—') {
    jobs.push(wrap('route', fetchHexdbRoute(callsign)))
  }

  // Emit sections as they land.
  const out = {}
  await Promise.all(jobs.map(p => p.then(r => {
    out[r.section] = r
    onSection(r.section, r)
  })))

  // Correlation needs the live position as fallback params, so run it once
  // we know where the aircraft is (or give up if we couldn't locate it).
  const liveRec = out.live?.data?.flight
  if (liveRec && liveRec.lat != null && liveRec.lon != null) {
    const ctxParams = {
      lat: liveRec.lat,
      lon: liveRec.lon,
      altitude: liveRec.alt != null ? Math.round(liveRec.alt * 3.281) : undefined,
      velocity: liveRec.vel,
      heading: liveRec.hdg,
      callsign: liveRec.callsign,
      squawk: liveRec.squawk,
    }
    const ctxResult = await wrap('context', fetchAircraftContext(hexLower, ctxParams))
    out.context = ctxResult
    onSection('context', ctxResult)

    // Weather at position needs the correlation's OpenMeteo already; separate
    // METAR fetches for dep/arr airports are handled by the UI once it has
    // TFMS or route info (triggered inside the component to avoid 404 spam).
  }

  return out
}
