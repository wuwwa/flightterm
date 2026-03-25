import axios from 'axios'
import { fetchRoute as fetchHexdbRoute } from './hexdb'

const BASE = 'https://api.adsbdb.com/v0'

// Fetch aircraft info and flight route in parallel.
// If ADSBdb has no route, falls back to hexdb.io.
export async function enrichFlight(icao, callsign) {
  const cs = callsign.trim().replace(/\s+/g, '')

  const [acResult, csResult] = await Promise.allSettled([
    axios.get(`${BASE}/aircraft/${icao}`),
    cs && cs !== '—'
      ? axios.get(`${BASE}/callsign/${cs}`)
      : Promise.resolve(null),
  ])

  const aircraft = acResult.status === 'fulfilled' && acResult.value?.data?.response?.aircraft
    ? acResult.value.data.response.aircraft
    : null

  let flightroute = csResult.status === 'fulfilled' && csResult.value?.data?.response?.flightroute
    ? csResult.value.data.response.flightroute
    : null

  // Fallback: try hexdb.io if ADSBdb had no route
  if (!flightroute && cs && cs !== '—') {
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

  return { aircraft, flightroute }
}
