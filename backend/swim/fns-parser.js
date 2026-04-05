// ── AIXM 5.1 NOTAM Parser ───────────────────────────────────────────────────
// Parses FAA FNS (Federal NOTAM System) messages delivered via SWIM SCDS.
// Messages are AIXM 5.1 XML wrapped in a SWIM envelope. We extract:
//   - NOTAM ID, series, number
//   - Location (airport ICAO, state, coordinates)
//   - Classification (TFR, runway, airspace, obstruction, etc.)
//   - Effective/expiration times
//   - NOTAM text (traditional ICAO format)
//   - TFR geometry (lat/lon polygon for airspace restrictions)
//
// Reference: AIXM 5.1 schema, FAA FNS JMSDD, NOTAM ICAO Annex 15

const { XMLParser } = require('fast-xml-parser')

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,            // strip namespace prefixes (aixm:, gml:, etc.)
  isArray: (name) => {
    // Force these to always be arrays even with single element
    const arrayTags = ['Event', 'TextNOTAM', 'posList', 'pos', 'member',
      'AirspaceVolume', 'theAirspaceVolume', 'horizontalProjection',
      'Surface', 'Polygon', 'exterior', 'LinearRing', 'coordinates']
    return arrayTags.includes(name)
  },
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
})

/**
 * Parse an AIXM 5.1 NOTAM message from FNS.
 * Returns a structured NOTAM object, or null if unparseable.
 *
 * @param {string} xml - Raw XML message text
 * @returns {Object|null} Parsed NOTAM
 */
function parseNotam(xml) {
  if (!xml || typeof xml !== 'string') return null

  let doc
  try {
    doc = parser.parse(xml)
  } catch (err) {
    return null
  }

  // Navigate the AIXM wrapper — structure varies, try common paths
  // FNS wraps NOTAMs in MessageCollection > hasMember > Event or direct Event
  const event = findEvent(doc)
  if (!event) return null

  const result = {
    // NOTAM identification
    id: null,
    series: null,
    number: null,
    type: null,          // NEW, REPLACE, CANCEL
    function: null,       // same as type in most cases

    // Location
    location: null,       // airport ICAO (e.g. 'KJFK')
    state: null,
    lat: null,
    lon: null,

    // Classification
    classification: null, // FDC, NOTAM, TFR, etc.
    keyword: null,        // RWY, TWY, OBST, AIRSPACE, SVC, etc.
    scenario: null,       // subject area

    // Timing
    effective: null,      // ISO datetime — when NOTAM takes effect
    expiration: null,     // ISO datetime — when NOTAM expires
    permanent: false,     // true if no expiration (PERM)

    // Content
    text: null,           // Traditional NOTAM text (E) field
    fullText: null,       // Complete NOTAM message

    // TFR-specific
    isTfr: false,
    altitudeLower: null,  // feet
    altitudeUpper: null,  // feet
    geometry: null,       // array of [lat, lon] pairs defining the TFR boundary

    // Metadata
    source: 'FNS',
    receivedAt: new Date().toISOString(),
  }

  // Extract NOTAM identification from the Event or TextNOTAM
  const textNotam = findNested(event, 'TextNOTAM') || findNested(event, 'textNOTAM')
  const notamObj = textNotam?.[0] || textNotam || {}

  result.id = findValue(notamObj, 'id') || findAttr(event, 'id') || findValue(event, 'identifier')
  result.series = findValue(notamObj, 'series')
  result.number = findValue(notamObj, 'number')
  result.type = findValue(notamObj, 'type') || findValue(event, 'type')

  // Location
  result.location = findValue(event, 'location')
    || findValue(notamObj, 'location')
    || findValue(event, 'locationDesignator')
    || findValue(event, 'designator')

  // Classification and keyword
  result.classification = findValue(event, 'classification')
    || findValue(notamObj, 'classification')
  result.keyword = findValue(event, 'keyword')
    || findValue(notamObj, 'keyword')
  result.scenario = findValue(event, 'scenario')
    || findValue(notamObj, 'scenario')

  // Timing
  const timeslice = findNested(event, 'EventTimeSlice')
    || findNested(event, 'timeSlice')
    || findNested(event, 'validTime')
  const validTime = findNested(timeslice || event, 'validTime')
    || findNested(event, 'TimePeriod')

  result.effective = findValue(validTime || event, 'beginPosition')
    || findValue(event, 'effectiveStart')
    || findValue(notamObj, 'effectiveStart')
    || findValue(event, 'startDate')

  result.expiration = findValue(validTime || event, 'endPosition')
    || findValue(event, 'effectiveEnd')
    || findValue(notamObj, 'effectiveEnd')
    || findValue(event, 'endDate')

  if (result.expiration === 'PERM' || result.expiration === 'UFN') {
    result.permanent = true
    result.expiration = null
  }

  // NOTAM text
  result.text = findValue(notamObj, 'text')
    || findValue(event, 'text')
    || findValue(notamObj, '#text')
  result.fullText = findValue(notamObj, 'simpleText')
    || findValue(notamObj, 'traditionalMessage')
    || findValue(event, 'translation')
    || result.text

  // Detect TFR
  const textLower = (result.fullText || result.text || '').toLowerCase()
  result.isTfr = result.keyword === 'AIRSPACE'
    || textLower.includes('temporary flight restriction')
    || textLower.includes('tfr')
    || (result.classification || '').toUpperCase() === 'FDC'

  // Extract TFR geometry if present
  const geometry = extractGeometry(event)
  if (geometry) {
    result.geometry = geometry.coords
    result.lat = geometry.center?.[0] || null
    result.lon = geometry.center?.[1] || null
    result.altitudeLower = geometry.lower
    result.altitudeUpper = geometry.upper
  }

  // If no lat/lon from geometry, try to extract from the event directly
  if (result.lat == null) {
    const pos = findValue(event, 'pos') || findValue(event, 'position')
    if (typeof pos === 'string' && pos.includes(' ')) {
      const [lat, lon] = pos.split(/\s+/).map(Number)
      if (!isNaN(lat) && !isNaN(lon)) {
        result.lat = lat
        result.lon = lon
      }
    }
  }

  return result
}

/**
 * Navigate into the AIXM document to find the Event element.
 * FNS messages can be wrapped in various envelopes.
 */
function findEvent(doc) {
  if (!doc) return null

  // Direct Event
  if (doc.Event) return unwrap(doc.Event)

  // MessageCollection wrapper
  const mc = doc.MessageCollection || doc.messageCollection
  if (mc) {
    const member = mc.hasMember || mc.member
    if (Array.isArray(member)) return unwrap(member[0]?.Event || member[0])
    if (member?.Event) return unwrap(member.Event)
    return unwrap(member)
  }

  // AIXMBasicMessage wrapper
  const basic = doc.AIXMBasicMessage || doc.BasicMessage
  if (basic) {
    const member = basic.hasMember || basic.member
    if (Array.isArray(member)) return unwrap(member[0]?.Event || member[0])
    return unwrap(member?.Event || member)
  }

  // Try to find Event anywhere in the tree (one level deep)
  for (const key of Object.keys(doc)) {
    const val = doc[key]
    if (val?.Event) return unwrap(val.Event)
    if (val?.hasMember?.Event) return unwrap(val.hasMember.Event)
    if (typeof val === 'object' && val !== null && !key.startsWith('@_')) {
      const inner = findEvent(val)
      if (inner) return inner
    }
  }

  return null
}

function unwrap(v) {
  return Array.isArray(v) ? v[0] : v
}

/**
 * Extract airspace geometry (TFR boundaries) from AIXM Event.
 */
function extractGeometry(event) {
  if (!event) return null

  // Look for AirspaceVolume containing horizontal projection
  const volume = findNested(event, 'AirspaceVolume')
    || findNested(event, 'theAirspaceVolume')
    || findNested(event, 'airspaceVolume')

  const vol = Array.isArray(volume) ? volume[0] : volume
  if (!vol) return null

  // Altitude bounds
  const lower = parseAltitude(findValue(vol, 'lowerLimit') || findValue(vol, 'minimumLimit'))
  const upper = parseAltitude(findValue(vol, 'upperLimit') || findValue(vol, 'maximumLimit'))

  // Horizontal projection — contains GML geometry
  const hProj = findNested(vol, 'horizontalProjection')
    || findNested(vol, 'Surface')
    || findNested(vol, 'Polygon')

  const coords = extractCoords(Array.isArray(hProj) ? hProj[0] : hProj)

  if (!coords || coords.length === 0) return null

  // Compute centroid
  const sumLat = coords.reduce((s, c) => s + c[0], 0)
  const sumLon = coords.reduce((s, c) => s + c[1], 0)
  const center = [sumLat / coords.length, sumLon / coords.length]

  return { coords, center, lower, upper }
}

/**
 * Extract coordinate pairs from GML geometry (Polygon, LinearRing, posList, etc.)
 */
function extractCoords(geom) {
  if (!geom) return null

  // Try posList first (space-separated lat lon pairs)
  const posList = findValue(geom, 'posList')
  if (typeof posList === 'string') {
    const nums = posList.trim().split(/\s+/).map(Number)
    const coords = []
    for (let i = 0; i + 1 < nums.length; i += 2) {
      if (!isNaN(nums[i]) && !isNaN(nums[i + 1])) {
        coords.push([nums[i], nums[i + 1]])
      }
    }
    if (coords.length > 0) return coords
  }

  // Try coordinates element (comma-separated lat,lon pairs)
  const coordsText = findValue(geom, 'coordinates')
  if (typeof coordsText === 'string') {
    return coordsText.trim().split(/\s+/).map(pair => {
      const [lat, lon] = pair.split(',').map(Number)
      return (!isNaN(lat) && !isNaN(lon)) ? [lat, lon] : null
    }).filter(Boolean)
  }

  // Recurse into nested geometry elements
  for (const key of Object.keys(geom)) {
    if (key.startsWith('@_')) continue
    const val = geom[key]
    if (typeof val === 'object' && val !== null) {
      const result = extractCoords(Array.isArray(val) ? val[0] : val)
      if (result && result.length > 0) return result
    }
  }

  return null
}

/**
 * Parse altitude value to feet.
 */
function parseAltitude(val) {
  if (val == null) return null
  if (typeof val === 'number') return val
  const str = String(val).toUpperCase()
  if (str === 'SFC' || str === 'GND') return 0
  if (str.startsWith('FL')) return parseInt(str.slice(2), 10) * 100
  const num = parseInt(str, 10)
  return isNaN(num) ? null : num
}

// ── Utility: deep search helpers ───────────────────────────────────────────

function findValue(obj, key) {
  if (!obj || typeof obj !== 'object') return null
  if (obj[key] != null && typeof obj[key] !== 'object') return obj[key]
  if (obj[key]?.['#text'] != null) return obj[key]['#text']
  for (const k of Object.keys(obj)) {
    if (k.startsWith('@_')) continue
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      const found = findValue(obj[k], key)
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

function findAttr(obj, attrName) {
  if (!obj) return null
  return obj[`@_${attrName}`] || obj[`@_gml:${attrName}`] || null
}

module.exports = { parseNotam }
