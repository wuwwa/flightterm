import axios from 'axios'

/**
 * Look up a flight route by callsign via hexdb.io (proxied through backend to avoid CORS).
 * Returns origin/destination ICAO codes + airport details.
 */
export async function fetchRoute(callsign) {
  const cs = callsign.trim().replace(/\s+/g, '')
  if (!cs || cs === '—') return null

  const res = await axios.get(`/api/hexdb/route/${cs}`, { timeout: 10000 })
  return res.data?.route || null
}
