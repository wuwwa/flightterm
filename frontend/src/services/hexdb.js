import axios from 'axios'

const BASE = 'https://hexdb.io/api/v1'

/**
 * Look up a flight route by callsign via hexdb.io.
 * Returns origin/destination ICAO codes + airport details.
 * Free, no auth required.
 */
export async function fetchRoute(callsign) {
  const cs = callsign.trim().replace(/\s+/g, '')
  if (!cs || cs === '—') return null

  const routeRes = await axios.get(`${BASE}/route/icao/${cs}`, { timeout: 8000 })
  const routeStr = routeRes.data // e.g. "KJFK-KLAX"
  if (!routeStr || typeof routeStr !== 'string' || !routeStr.includes('-')) return null

  const [originIcao, destIcao] = routeStr.split('-').map(s => s.trim())
  if (!originIcao || !destIcao) return null

  // Fetch airport details in parallel
  const [originRes, destRes] = await Promise.allSettled([
    axios.get(`${BASE}/airport/icao/${originIcao}`, { timeout: 8000 }),
    axios.get(`${BASE}/airport/icao/${destIcao}`, { timeout: 8000 }),
  ])

  const parseAirport = (res, icao) => {
    if (res.status !== 'fulfilled' || !res.value?.data) return { icao }
    const d = res.value.data
    return {
      icao,
      iata: d.iata || null,
      name: d.airport || null,
      lat: d.latitude != null ? parseFloat(d.latitude) : null,
      lon: d.longitude != null ? parseFloat(d.longitude) : null,
      municipality: d.municipality || null,
      country: d.country || null,
    }
  }

  return {
    origin: parseAirport(originRes, originIcao),
    destination: parseAirport(destRes, destIcao),
    source: 'hexdb',
  }
}
