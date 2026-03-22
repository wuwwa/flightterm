import axios from 'axios'
import { REGIONS } from './opensky'

const RAPIDAPI_HOST = 'adsbexchange-com1.p.rapidapi.com'

export async function fetchAdsbx(region = 'global', apiKey, radius = 100) {
  const reg = REGIONS[region]
  const url = `https://${RAPIDAPI_HOST}/v2/lat/${reg.lat}/lon/${reg.lon}/dist/${radius}/`

  const response = await axios.get(url, {
    headers: {
      'x-rapidapi-host': RAPIDAPI_HOST,
      'x-rapidapi-key': apiKey,
    }
  })

  const ac = response.data?.ac || []
  const remaining = response.headers?.['x-ratelimit-requests-remaining'] || null

  const flights = ac.map(a => ({
    icao:     (a.hex || '').trim().toLowerCase(),
    callsign: (a.flight || '').trim() || '—',
    country:  a.cou || a.ownOp || '—',
    lon:      a.lon != null ? parseFloat(parseFloat(a.lon).toFixed(4)) : null,
    lat:      a.lat != null ? parseFloat(parseFloat(a.lat).toFixed(4)) : null,
    // adsbx gives altitude in feet, convert to metres
    alt:      a.alt_baro != null && a.alt_baro !== 'ground'
                ? Math.round(a.alt_baro * 0.3048)
                : null,
    grounded: a.alt_baro === 'ground' || a.gnd === true,
    // adsbx gives speed in knots, convert to m/s
    vel:      a.gs != null ? parseFloat((a.gs * 0.514444).toFixed(1)) : null,
    hdg:      a.track != null ? Math.round(a.track) : null,
    mil:      a.mil === true,
    src:      'adsbx',
  }))

  return { flights, remaining }
}

export async function testAdsbxKey(apiKey) {
  const url = `https://${RAPIDAPI_HOST}/v2/lat/51.5/lon/-0.1/dist/10/`
  const response = await axios.get(url, {
    headers: {
      'x-rapidapi-host': RAPIDAPI_HOST,
      'x-rapidapi-key': apiKey,
    }
  })
  return response.status === 200
}
