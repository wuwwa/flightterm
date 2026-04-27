import axios from 'axios'
import { fetchRoute as fetchHexdbRoute } from './hexdb'

const BASE = 'https://api.adsbdb.com/v0'

// v5.3.1 — Flight-click enrichment no longer pre-fetches /aircraft.
// The endpoint 404s for ~half of aircraft (non-commercial / military regs)
// and the useful metadata (type/reg/operator) is already in the backend
// poller's aircraft cache. The only thing this call uniquely provides is
// url_photo_thumbnail, which almost nobody looks at. Moved behind an
// explicit user action via fetchAircraftInfo().
export async function enrichFlight(icao, callsign) {
  const cs = (callsign || '').trim().replace(/\s+/g, '')

  let flightroute = null
  if (cs && cs !== '—') {
    try {
      const res = await axios.get(`${BASE}/callsign/${cs}`)
      flightroute = res.data?.response?.flightroute || null
    } catch {}

    // Fallback: try hexdb.io if ADSBdb had no route.
    if (!flightroute) {
      try {
        const hexRoute = await fetchHexdbRoute(cs)
        if (hexRoute) {
          flightroute = {
            origin: hexRoute.origin,
            destination: hexRoute.destination,
            _source: 'hexdb',
          }
        }
      } catch {}
    }
  }

  // aircraft stays null by design; lazy via fetchAircraftInfo().
  return { aircraft: null, flightroute }
}

// On-demand aircraft metadata + photo. Call this only when the user
// explicitly asks for it (e.g. clicking "show photo"). Returns null on
// 404 — adsbdb doesn't know every registration, especially military
// and older private aircraft.
export async function fetchAircraftInfo(icao) {
  try {
    const res = await axios.get(`${BASE}/aircraft/${icao}`)
    return res.data?.response?.aircraft || null
  } catch (err) {
    if (err?.response?.status === 404) return null
    throw err
  }
}

// Lightweight route-only lookup by callsign (skips aircraft enrichment).
// Used by the background enrichment queue — cheaper than full enrichFlight.
export async function fetchRouteOnly(callsign) {
  const cs = callsign.trim().replace(/\s+/g, '')
  if (!cs || cs === '—') return null

  try {
    const res = await axios.get(`${BASE}/callsign/${cs}`)
    const route = res.data?.response?.flightroute
    if (route) return { ...route, _source: 'adsbdb' }
  } catch {}

  // Fallback to hexdb
  try {
    const hexRoute = await fetchHexdbRoute(cs)
    if (hexRoute) return { origin: hexRoute.origin, destination: hexRoute.destination, _source: 'hexdb' }
  } catch {}

  return null
}
