import axios from 'axios'

const BASE = 'https://api.adsbdb.com/v0'

// Fetch aircraft info and flight route in parallel
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

  const flightroute = csResult.status === 'fulfilled' && csResult.value?.data?.response?.flightroute
    ? csResult.value.data.response.flightroute
    : null

  return { aircraft, flightroute }
}
