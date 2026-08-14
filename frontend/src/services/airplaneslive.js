import axios from 'axios'

// ── ICAO hex prefix → country (top aviation nations) ─────────────────────────
// ICAO allocates hex blocks to nations. First 1-2 hex digits identify country.
// This covers ~95% of commercial traffic; returns null for unknown prefixes.
const HEX_COUNTRY = [
  [0xa00000, 0xafffff, 'United States'], [0x300000, 0x3fffff, 'Italy'],
  [0x400000, 0x43ffff, 'United Kingdom'], [0x440000, 0x47ffff, 'Austria'],
  [0x480000, 0x4bffff, 'Belgium'], [0x500000, 0x53ffff, 'Denmark'],
  [0x540000, 0x57ffff, 'Finland'], [0x380000, 0x3bffff, 'France'],
  [0x3c0000, 0x3fffff, 'Germany'], [0x460000, 0x467fff, 'Greece'],
  [0x4a0000, 0x4affff, 'Ireland'], [0x340000, 0x37ffff, 'Spain'],
  [0x4c0000, 0x4cffff, 'Netherlands'], [0x4d0000, 0x4dffff, 'Norway'],
  [0x4e0000, 0x4effff, 'Poland'], [0x490000, 0x49ffff, 'Portugal'],
  [0x4b0000, 0x4bffff, 'Sweden'], [0x4b8000, 0x4bffff, 'Switzerland'],
  [0x700000, 0x70ffff, 'Australia'], [0x710000, 0x71ffff, 'New Zealand'],
  [0x780000, 0x7bffff, 'China'], [0x840000, 0x87ffff, 'Japan'],
  [0x680000, 0x6fffff, 'South Korea'], [0x880000, 0x887fff, 'India'],
  [0xc00000, 0xc3ffff, 'Canada'], [0xe40000, 0xe41fff, 'Brazil'],
  [0x060000, 0x06ffff, 'Mexico'], [0x710100, 0x71ffff, 'Singapore'],
  [0x750000, 0x75ffff, 'Malaysia'], [0x898000, 0x898fff, 'Thailand'],
  [0x0c0000, 0x0fffff, 'Turkey'], [0x740000, 0x747fff, 'Indonesia'],
  [0x760000, 0x767fff, 'Taiwan'], [0x800000, 0x83ffff, 'UAE'],
  [0x8a0000, 0x8affff, 'Saudi Arabia'], [0x600000, 0x6003ff, 'Qatar'],
  [0x010000, 0x01ffff, 'Russia'], [0x508000, 0x50ffff, 'Israel'],
]

function hexToCountry(hex) {
  const n = parseInt(hex, 16)
  if (isNaN(n)) return null
  for (const [lo, hi, country] of HEX_COUNTRY) {
    if (n >= lo && n <= hi) return country
  }
  return null
}

// ── Unit conversions (community readsb feeds use feet/knots/ft-per-min) ──────
const FT_TO_M = 0.3048
const KT_TO_MS = 0.514444
const FPM_TO_MS = 0.00508

function parseAircraft(a) {
  const altBaro = a.alt_baro
  const grounded = altBaro === 'ground'

  return {
    icao:     (a.hex || '').trim().toLowerCase(),
    callsign: (a.flight || '').trim() || '—',
    country:  hexToCountry(a.hex) || null,
    lon:      a.lon != null ? parseFloat(parseFloat(a.lon).toFixed(4)) : null,
    lat:      a.lat != null ? parseFloat(parseFloat(a.lat).toFixed(4)) : null,
    alt:      !grounded && altBaro != null ? Math.round(altBaro * FT_TO_M) : null,
    grounded,
    vel:      a.gs != null ? parseFloat((a.gs * KT_TO_MS).toFixed(1)) : null,
    hdg:      a.track != null ? Math.round(a.track) : null,
    vertRate: a.baro_rate != null ? parseFloat((a.baro_rate * FPM_TO_MS).toFixed(1)) : null,
    geoAlt:   a.alt_geom != null ? Math.round(a.alt_geom * FT_TO_M) : null,
    squawk:   a.squawk || null,
    posSrc:   a.type === 'mlat' || (a.mlat && a.mlat.length > 0) ? 2
            : a.type === 'tisb' || (a.tisb && a.tisb.length > 0) ? 1
            : 0,  // default ADS-B
    ndb:      null,  // not directly available, but rssi hints at coverage
    mil:      !!(a.dbFlags & 1),  // bit 0 = military
    category: a.category || null,
    src:      'apl',

    // ── rich fields (not available from OpenSky) ─────────────────────────
    ias:         a.ias ?? null,           // indicated airspeed (knots)
    tas:         a.tas ?? null,           // true airspeed (knots)
    mach:        a.mach ?? null,          // mach number
    roll:        a.roll ?? null,          // roll angle (degrees)
    magHeading:  a.mag_heading ?? null,   // magnetic heading
    trueHeading: a.true_heading ?? null,  // true heading
    trackRate:   a.track_rate ?? null,    // degrees/sec
    navAltMcp:   a.nav_altitude_mcp ?? null,  // MCP selected altitude (ft)
    navAltFms:   a.nav_altitude_fms ?? null,  // FMS selected altitude (ft)
    navHeading:  a.nav_heading ?? null,       // selected heading
    navModes:    a.nav_modes ?? null,         // ['autopilot', 'vnav', 'lnav', ...]
    windDir:     a.wd ?? null,            // wind direction (degrees)
    windSpeed:   a.ws ?? null,            // wind speed (knots)
    oat:         a.oat ?? null,           // outside air temp (°C)
    tat:         a.tat ?? null,           // total air temp (°C)
    emergency:   a.emergency ?? null,     // emergency string
    alert:       a.alert ?? null,
    spi:         a.spi ?? null,
    reg:         a.r || null,             // registration
    type:        a.t || null,             // ICAO type code
    rssi:        a.rssi ?? null,          // signal strength
    messages:    a.messages ?? null,
    seen:        a.seen ?? null,          // seconds since last message
    seenPos:     a.seen_pos ?? null,      // seconds since last position
  }
}

/**
 * Fetch rich data for a single aircraft by hex.
 * Used to enrich anomaly detections with 50+ fields from the community feed.
 */
export async function fetchAplByHex(hex) {
  const res = await axios.get('/api/apl/hex', {
    params: { hex },
    timeout: 10000,
  })
  const ac = res.data?.ac || []
  if (ac.length === 0) return null
  return parseAircraft(ac[0])
}
