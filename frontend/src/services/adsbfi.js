import axios from 'axios'

/**
 * Parse a single adsb.fi aircraft object into our enrichment format.
 * Returns the extra fields that OpenSky/ADSBx don't provide.
 */
function parseAircraft(a) {
  return {
    reg:       a.r || null,
    type:      a.t || null,
    typeDesc:  a.desc || null,
    operator:  a.ownOp || null,
    year:      a.year || null,
    baroRate:  a.baro_rate != null ? Math.round(a.baro_rate) : null,
    geomRate:  a.geom_rate != null ? Math.round(a.geom_rate) : null,
    navAlt:    a.nav_altitude_mcp ?? null,
    navHdg:    a.nav_heading != null ? Math.round(a.nav_heading) : null,
    emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
    mil:       a.mil === true,
    category:  a.category || null,
    rssi:      a.rssi ?? null,
    lat:       a.lat ?? null,
    lon:       a.lon ?? null,
    altBaro:   a.alt_baro != null && a.alt_baro !== 'ground' ? Math.round(a.alt_baro) : null,
    gs:        a.gs ?? null,
    track:     a.track != null ? Math.round(a.track) : null,
    squawk:    a.squawk || null,
  }
}

/**
 * Enrich a single aircraft by ICAO hex via backend proxy → adsb.fi.
 * Rate limit: 1 req/sec — use for on-demand enrichment, not bulk polling.
 */
export async function enrichByHex(hex) {
  const res = await axios.get(`/api/adsbfi/hex/${hex.trim().toLowerCase()}`, { timeout: 12000 })
  const ac = res.data?.ac
  if (!ac || !ac.length) return null
  return parseAircraft(ac[0])
}

/**
 * Enrich a single aircraft by callsign via backend proxy → adsb.fi.
 */
export async function enrichByCallsign(callsign) {
  const cs = callsign.trim().replace(/\s+/g, '')
  if (!cs || cs === '—') return null
  const res = await axios.get(`/api/adsbfi/callsign/${cs}`, { timeout: 12000 })
  const ac = res.data?.ac
  if (!ac || !ac.length) return null
  return parseAircraft(ac[0])
}

/**
 * Quick connectivity test via backend proxy.
 */
export async function testAdsbfi() {
  const res = await axios.get('/api/adsbfi/hex/a00001', { timeout: 10000 })
  return res.status === 200
}
