// Airline classifier: ADS-B callsign → commercial operator.
// Loads ICAO 3-letter designators from backend/data/airlines.json (OpenFlights
// + supplement for major carriers OpenFlights marked inactive).

const airlines = require('../data/airlines.json')

// Index by uppercase 3-letter ICAO. Runtime lookup is O(1).
const byIcao = new Map()
for (const a of airlines) {
  byIcao.set(a.icao.toUpperCase(), a)
}

// Index by lowercased acOperator string for fallback matching. We seed it with
// a handful of well-known aliases so adsbdb's noisy operator strings still
// resolve when the callsign doesn't.
const OPERATOR_ALIASES = {
  'united airlines':          'UAL',
  'united airlines inc':      'UAL',
  'delta air lines':          'DAL',
  'delta air lines inc':      'DAL',
  'american airlines':        'AAL',
  'american airlines inc':    'AAL',
  'southwest airlines':       'SWA',
  'southwest airlines co':    'SWA',
  'jetblue airways':          'JBU',
  'jetblue':                  'JBU',
  'alaska airlines':          'ASA',
  'spirit airlines':          'NKS',
  'frontier airlines':        'FFT',
  'hawaiian airlines':        'HAL',
  'allegiant air':            'AAY',
  'skywest airlines':         'SKW',
  'republic airways':         'RPA',
  'envoy air':                'ENY',
  'horizon air':              'QXE',
  'fedex':                    'FDX',
  'fedex express':            'FDX',
  'federal express':          'FDX',
  'ups airlines':             'UPS',
  'united parcel service':    'UPS',
  'atlas air':                'GTI',
  'kalitta air':              'CKS',
  'abx air':                  'ABX',
  'air canada':               'ACA',
  'netjets aviation':         'EJA',
  'netjets':                  'EJA',
}
const byOperatorAlias = new Map()
for (const [alias, icao] of Object.entries(OPERATOR_ALIASES)) {
  const hit = byIcao.get(icao)
  if (hit) byOperatorAlias.set(alias, hit)
}

// Commercial callsigns: strict three-letter ICAO prefix followed by a digit and
// up to four more digits/letters (e.g. "UAL123", "DAL456H", "SWA9"). Rejects
// tactical callsigns, registration-as-callsign (N1234Z), and ICAO hex strings.
const CALLSIGN_PREFIX_RE = /^([A-Z]{3})(\d[A-Z0-9]{0,4})$/

/**
 * Classify a flight by its operating airline.
 * Returns { icao, iata, name, country, source } | null.
 * source === 'callsign_prefix' | 'operator_alias'.
 */
function classifyAirline(flight) {
  const cs = (flight.callsign || '').trim().toUpperCase()
  const m = cs.match(CALLSIGN_PREFIX_RE)
  if (m) {
    const hit = byIcao.get(m[1])
    if (hit) {
      return { icao: hit.icao, iata: hit.iata, name: hit.name, country: hit.country, source: 'callsign_prefix' }
    }
  }

  const op = (flight.acOperator || '').trim().toLowerCase()
  if (op) {
    const hit = byOperatorAlias.get(op)
    if (hit) {
      return { icao: hit.icao, iata: hit.iata, name: hit.name, country: hit.country, source: 'operator_alias' }
    }
  }

  return null
}

function lookupAirlineByIcao(icao) {
  if (!icao) return null
  return byIcao.get(String(icao).toUpperCase()) || null
}

module.exports = { classifyAirline, lookupAirlineByIcao }
