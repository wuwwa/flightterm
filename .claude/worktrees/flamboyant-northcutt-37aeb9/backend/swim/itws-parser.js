// ── ITWS (Integrated Terminal Weather System) Parser ────────────────────────
// Terminal weather data from 30+ TRACON sites.
// Message format: <itws_msg> with <packet_header> + <product_header> + product data
// Key data is in JMS properties (ITWSsite, airport, DEX_SOURCE_TYPE, productID)
// and the <product_msg_name> element inside the XML.
//
// Product types observed:
//   ITWS_Alert: Tornado Alert, Wind Shear ATIS, Microburst ATIS, Tornado Detections,
//               Gust Front ETI, Gust Front TRACON Map, Configured Alerts, Hazard Text
//   ITWS:       Precipitation (AP, TRACON, Long Range), SM SEP, AP Status,
//               Terminal Weather Graphics, Forecast Image

const { XMLParser } = require('fast-xml-parser')

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
  parseAttributeValue: false,  // keep as strings for weather data
  trimValues: true,
})

// Map product names to event types
const PRODUCT_TYPE_MAP = {
  'tornado alert': 'TORNADO',
  'tornado detection': 'TORNADO',
  'wind shear': 'WINDSHEAR',
  'microburst': 'MICROBURST',
  'gust front': 'GUST_FRONT',
  'hazard text': 'HAZARD_TEXT',
  'precipitation': 'PRECIP',
  'configured alert': 'ALERT_CONFIG',
  'ap status': 'STATUS',
  'sm sep': 'STORM_MOTION',
  'terminal weather': 'TERMINAL_WX',
  'forecast': 'FORECAST',
}

function classifyProduct(name) {
  if (!name) return 'UNKNOWN'
  const lower = name.toLowerCase()
  for (const [key, type] of Object.entries(PRODUCT_TYPE_MAP)) {
    if (lower.includes(key)) return type
  }
  return 'OTHER'
}

// Severity for display
const SEVERITY_MAP = {
  TORNADO: 'CRITICAL',
  MICROBURST: 'CRITICAL',
  WINDSHEAR: 'HIGH',
  GUST_FRONT: 'HIGH',
  HAZARD_TEXT: 'MEDIUM',
  PRECIP: 'LOW',
  STORM_MOTION: 'LOW',
}

/**
 * Parse an ITWS message.
 * @param {string} xml - Raw XML (<itws_msg>)
 * @param {Object} props - JMS properties (ITWSsite, airport, productID, DEX_SOURCE_TYPE)
 * @returns {Object|null} Parsed weather event
 */
function parseItwsMessage(xml, props) {
  const result = {
    msgType: null,
    eventType: null,
    productName: null,
    productId: null,
    site: null,
    airport: null,
    severity: null,
    isAlert: false,
    lat: null,
    lon: null,
    text: null,
    validTime: null,
    timestamp: new Date().toISOString(),
    source: 'ITWS',
  }

  // Extract from JMS properties — these are always present
  if (props) {
    result.site = props.ITWSsite || null
    result.airport = props.airport && props.airport !== '000' ? props.airport : result.site
    result.productId = props.productID || null
    result.isAlert = (props.DEX_SOURCE_TYPE || '').includes('Alert') || (props.AlertQueue === 'Alert')
    result.msgType = props.DEX_SOURCE_TYPE || null
  }

  // Parse XML for product name and any embedded data
  if (xml && xml.length > 20) {
    try {
      const doc = parser.parse(xml)
      const msg = doc.itws_msg || doc

      // Product header — always present, rich with timing and source data
      const ph = findNested(msg, 'product_header')
      if (ph) {
        const msgId = findNested(ph, 'product_header_msg_id') || ph
        result.productName = findVal(msgId, 'product_msg_name') || findVal(ph, 'product_msg_name')
        result.productId = result.productId || findVal(msgId, 'product_msg_id')
        result.site = result.site || findVal(ph, 'product_header_itws_sites')
        result.airport = (result.airport && result.airport !== '000')
          ? result.airport
          : findVal(ph, 'product_header_airports') || result.site
        // Radar source (e.g. KILN, KLOT)
        result.radarSource = findVal(ph, 'product_header_source_id')
        // Timing — gregorian attribute has human-readable time
        const genEl = findNested(ph, 'product_header_generation_time_seconds')
        const expEl = findNested(ph, 'product_header_expiration_time_seconds')
        if (genEl) result.validTime = genEl['@_gregorian'] || null
        if (expEl) result.expiryTime = expEl['@_gregorian'] || null
      }

      // Try to extract hazard text content
      const hazText = findVal(msg, 'hazard_text') || findVal(msg, 'alert_text')
        || findVal(msg, 'text_message') || findVal(msg, 'atis_text')
      if (hazText && typeof hazText === 'string' && hazText.length > 2) {
        result.text = hazText.substring(0, 500)
      }

      // Try to extract geographic data
      const lat = findVal(msg, 'latitude') || findVal(msg, 'lat')
      const lon = findVal(msg, 'longitude') || findVal(msg, 'lon')
      if (lat != null && lon != null) {
        result.lat = Number(lat)
        result.lon = Number(lon)
        if (isNaN(result.lat)) result.lat = null
        if (isNaN(result.lon)) result.lon = null
      }
    } catch {
      // XML parse failed — continue with property-based data
    }
  }

  // Classify the product
  result.eventType = classifyProduct(result.productName)
  result.severity = SEVERITY_MAP[result.eventType] || 'LOW'

  // Build display text with detail
  if (!result.text) {
    const parts = [result.productName || result.eventType]
    if (result.airport) parts.push(`at ${result.airport}`)
    if (result.radarSource && result.radarSource !== result.airport) parts.push(`(${result.radarSource})`)
    if (result.expiryTime) parts.push(`valid til ${result.expiryTime.substring(11, 16)}z`)
    result.text = parts.filter(Boolean).join(' ')
  }

  // Only store events with meaningful data
  if (!result.site && !result.airport) return null
  return result
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

module.exports = { parseItwsMessage }
