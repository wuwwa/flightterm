// ── STDDS (SWIM Terminal Data Distribution System) Parser ───────────────────
// Actual message types observed from live SCDS feed:
//
// FP (1278/3000): TATrackAndFlightPlan — TRACON radar tracks (lat/lon, velocity, callsign, beacon)
// AT (579):       asdexMsg positionReport — ASDE-X surface positions (lat/lon, track ID)
// AD (69):        asdexMsg adsbReport — Surface ADS-B with GUFI
// SE (3):         SurfaceMovementEventMessage — OOOI events! (callsign, type, event, runway, position)
// RR (18):        RVRDataUpdateMessage — Runway Visual Range (touchdown/midpoint/rollout)
// DD (11):        DATISData — Digital ATIS
// SH (15):        SafetyLogicHoldBar — Hold bar status
// ST (998):       TAStatus — STARS system heartbeats
// SS/IS/AS/TS/AY/HB/DS: Infrastructure status — skip

const { XMLParser } = require('fast-xml-parser')

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
})

/**
 * Parse an STDDS message.
 * @param {string} xml - Raw XML
 * @param {Object} props - JMS properties (msgType, airport, tracon, srcTracon)
 * @returns {Object|null}
 */
function parseStddsMessage(xml, props) {
  const msgType = props?.msgType || null
  const airport = props?.airport || null
  const tracon = props?.tracon || props?.srcTracon || null

  // Skip infrastructure/status heartbeats — high volume, no operational value
  if (['ST', 'SS', 'IS', 'AS', 'TS', 'HB', 'DS', 'AY'].includes(msgType)) return null

  if (!xml || xml.length < 50) return null

  let doc
  try { doc = parser.parse(xml) } catch { return null }

  // Route to the right parser based on msgType
  switch (msgType) {
    case 'SE': return parseSurfaceEvent(doc, airport, tracon)
    case 'FP': return parseTraconTrack(doc, airport, tracon)
    case 'AT': return parseAsdexPosition(doc, airport, tracon)
    case 'AD': return parseAsdexAdsb(doc, airport, tracon)
    case 'RR': return parseRvr(doc, airport, tracon)
    case 'DD': return parseDatis(doc, airport, tracon)
    case 'SH': return parseHoldBar(doc, airport, tracon)
    default: return null
  }
}

// ── SE: Surface Movement Event (OOOI) ──────────────────────────────────────
// The most valuable STDDS message: gate out, takeoff, landing, gate in
function parseSurfaceEvent(doc, airport, tracon) {
  const msg = doc.SurfaceMovementEventMessage || doc.surfaceMovementEventMessage || doc
  const event = findVal(msg, 'event')
  const events = findNested(msg, 'events')

  // Map raw event names to standard OOOI
  let surfaceEvent = null
  const e = (event || '').toLowerCase()
  if (e.includes('spotout') || e.includes('spot_out') || e.includes('pushback')) surfaceEvent = 'SPOT_OUT'
  else if (e.includes('runwayout') || e.includes('runway_out') || e.includes('takeoff') || e === 'off') surfaceEvent = 'OFF'
  else if (e.includes('runwayin') || e.includes('runway_in') || e.includes('landing') || e === 'on') surfaceEvent = 'ON'
  else if (e.includes('spotin') || e.includes('spot_in') || e.includes('gate_in')) surfaceEvent = 'SPOT_IN'
  else surfaceEvent = event || null

  const pos = findNested(msg, 'position') || {}

  return {
    service: 'SMES',
    eventType: surfaceEvent || 'SURFACE_EVENT',
    airport: findVal(msg, 'airport') || airport,
    tracon,
    callsign: findVal(msg, 'callsign'),
    lat: toNum(findVal(pos, 'latitude')),
    lon: toNum(findVal(pos, 'longitude')),
    altitude: toNum(findVal(msg, 'altitude')),
    speed: null,
    heading: null,
    surfaceEvent,
    runway: findVal(msg, 'runway'),
    gate: findVal(msg, 'gate'),
    taxiway: null,
    rvr: null, rvrTrend: null,
    alertType: null,
    text: `${surfaceEvent || event || '?'} ${findVal(msg, 'callsign') || '?'} ${findVal(msg, 'aircraftType') || ''} rwy ${findVal(msg, 'runway') || '?'} at ${findVal(msg, 'airport') || airport || '?'}`.trim(),
    source: 'STDDS',
    // Extra fields for OOOI
    aircraftType: findVal(msg, 'aircraftType'),
    beaconCode: findVal(msg, 'mode3ACode'),
    acAddress: findVal(msg, 'acAddress'),
    status: findVal(msg, 'status'), // onsurface, airborne
  }
}

// ── FP: TRACON Radar Track ─────────────────────────────────────────────────
function parseTraconTrack(doc, airport, tracon) {
  const root = doc.TATrackAndFlightPlan || doc
  const src = findVal(root, 'src')
  const record = findNested(root, 'record')
  if (!record) return null

  const track = findNested(record, 'track')
  const fp = findNested(record, 'flightPlan')

  const lat = toNum(findVal(track, 'lat'))
  const lon = toNum(findVal(track, 'lon'))
  if (lat == null && lon == null) return null // skip tracks without position

  return {
    service: 'TAIS',
    eventType: 'TRACON_TRACK',
    airport: airport || null,
    tracon: src || tracon,
    callsign: findVal(fp, 'acid') || findVal(track, 'acid'),
    lat,
    lon,
    altitude: toNum(findVal(track, 'alt')) || toNum(findVal(track, 'reportedAltitude')),
    speed: toNum(findVal(track, 'speed')) || toNum(findVal(track, 'groundSpeed')),
    heading: toNum(findVal(track, 'heading')),
    surfaceEvent: null,
    runway: null,
    gate: null,
    taxiway: null,
    rvr: null, rvrTrend: null,
    alertType: null,
    text: `track ${findVal(fp, 'acid') || findVal(track, 'acid') || '?'} at ${src || tracon || '?'}`,
    source: 'STDDS',
  }
}

// ── AT: ASDE-X Surface Position ────────────────────────────────────────────
function parseAsdexPosition(doc, airport, tracon) {
  const msg = doc.asdexMsg || doc
  const arpt = findVal(msg, 'airport') || airport
  const report = findNested(msg, 'positionReport')
  if (!report) return null

  const pos = findNested(report, 'position') || {}
  const lat = toNum(findVal(pos, 'latitude'))
  const lon = toNum(findVal(pos, 'longitude'))

  return {
    service: 'SMES',
    eventType: 'SURFACE_POSITION',
    airport: arpt,
    tracon,
    callsign: findVal(report, 'callsign') || findVal(report, 'acid'),
    lat, lon,
    altitude: null,
    speed: null,
    heading: null,
    surfaceEvent: null,
    runway: null, gate: null, taxiway: null,
    rvr: null, rvrTrend: null,
    alertType: null,
    text: `surface position at ${arpt || '?'}`,
    source: 'STDDS',
  }
}

// ── AD: Surface ADS-B ──────────────────────────────────────────────────────
function parseAsdexAdsb(doc, airport, tracon) {
  const msg = doc.asdexMsg || doc
  const arpt = findVal(msg, 'airport') || airport
  const report = findNested(msg, 'adsbReport') || findNested(msg, 'report')
  if (!report) return null

  const basic = findNested(report, 'basicReport') || report
  const pos = findNested(basic, 'position') || {}
  const enhanced = findNested(report, 'enhancedData') || findNested(msg, 'enhancedData') || {}

  return {
    service: 'SMES',
    eventType: 'SURFACE_ADSB',
    airport: arpt,
    tracon,
    callsign: findVal(enhanced, 'callsign') || findVal(basic, 'callsign'),
    lat: toNum(findVal(pos, 'lat') || findVal(pos, 'latitude')),
    lon: toNum(findVal(pos, 'lon') || findVal(pos, 'longitude')),
    altitude: null,
    speed: null, heading: null,
    surfaceEvent: null,
    runway: null, gate: null, taxiway: null,
    rvr: null, rvrTrend: null,
    alertType: null,
    text: `surface ADS-B at ${arpt || '?'}`,
    source: 'STDDS',
    gufi: findVal(enhanced, 'eramGufi'),
  }
}

// ── RR: Runway Visual Range ────────────────────────────────────────────────
function parseRvr(doc, airport, tracon) {
  const msg = doc.RVRDataUpdateMessage || doc
  const arpt = findVal(msg, 'airport') || airport
  const rwyData = findNested(msg, 'runwayData')
  if (!rwyData) return null

  const rwyId = findNested(rwyData, 'runwayID')
  const rwy = rwyId ? `${findVal(rwyId, 'numericRunwayID') || ''}${findVal(rwyId, 'runwaySubID') || ''}` : null
  const touchdown = toNum(findVal(rwyData, 'touchdownVisualRange'))
  const trend = findVal(rwyData, 'touchdownTrend')
  const midpoint = toNum(findVal(rwyData, 'midpointVisualRange'))
  const rollout = toNum(findVal(rwyData, 'rolloutVisualRange'))

  // RVR is in hundreds of feet
  const tdrFt = touchdown != null ? touchdown * 100 : null
  const midFt = midpoint != null ? midpoint * 100 : null
  const rolFt = rollout != null ? rollout * 100 : null

  const trendLabel = trend === '+' ? 'UP' : trend === '-' ? 'DOWN' : trend === 'S' ? 'STEADY' : trend || null

  return {
    service: 'APDS',
    eventType: 'RVR',
    airport: arpt,
    tracon,
    callsign: null,
    lat: null, lon: null,
    altitude: null, speed: null, heading: null,
    surfaceEvent: null,
    runway: rwy,
    gate: null, taxiway: null,
    rvr: tdrFt,
    rvrTrend: trendLabel,
    alertType: null,
    text: `RVR ${arpt} ${rwy || '?'}: TD ${tdrFt || '?'}ft${trendLabel ? ' ' + trendLabel : ''} MP ${midFt || '?'}ft RO ${rolFt || '?'}ft`,
    source: 'STDDS',
  }
}

// ── DD: D-ATIS ─────────────────────────────────────────────────────────────
function parseDatis(doc, airport, tracon) {
  // D-ATIS messages — extract what we can
  const root = doc.DATISData || doc
  return {
    service: 'TDES',
    eventType: 'DATIS',
    airport: airport || findVal(root, 'airport'),
    tracon,
    callsign: null,
    lat: null, lon: null, altitude: null, speed: null, heading: null,
    surfaceEvent: null, runway: null, gate: null, taxiway: null,
    rvr: null, rvrTrend: null, alertType: null,
    text: `D-ATIS update at ${airport || '?'}`,
    source: 'STDDS',
  }
}

// ── SH: Safety Hold Bar ────────────────────────────────────────────────────
function parseHoldBar(doc, airport, tracon) {
  const msg = doc.SafetyLogicHoldBar || doc
  return {
    service: 'SMES',
    eventType: 'HOLD_BAR',
    airport: findVal(msg, 'airport') || airport,
    tracon,
    callsign: null,
    lat: null, lon: null, altitude: null, speed: null, heading: null,
    surfaceEvent: null, runway: null, gate: null, taxiway: null,
    rvr: null, rvrTrend: null, alertType: null,
    text: `hold bar status at ${findVal(msg, 'airport') || airport || '?'}`,
    source: 'STDDS',
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function toNum(v) {
  if (v == null) return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

function findVal(obj, key) {
  if (!obj || typeof obj !== 'object') return null
  if (obj[key] != null && typeof obj[key] !== 'object') return obj[key]
  if (obj[key]?.['#text'] != null) return obj[key]['#text']
  for (const k of Object.keys(obj)) {
    if (k.startsWith('@_')) continue
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      const found = findVal(obj[k], key)
      if (found != null) return found
    }
  }
  return null
}

function findNested(obj, key) {
  if (!obj || typeof obj !== 'object') return null
  if (obj[key] != null) return obj[key]
  for (const k of Object.keys(obj)) {
    if (k.startsWith('@_')) continue
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      const found = findNested(obj[k], key)
      if (found != null) return found
    }
  }
  return null
}

module.exports = { parseStddsMessage }
