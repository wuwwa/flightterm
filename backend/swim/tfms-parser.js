// ── TFMS (Traffic Flow Management System) Message Parser ────────────────────
// Parses TFMData messages from FAA SWIM SCDS.
// Two message families:
//   1. Flight Data — flight plans, track updates, departure/arrival, amendments
//   2. Flow Information — GDPs, ground stops, AFPs, reroutes, ATCSCC advisories
//
// Format: TFMData XML v3.2 (custom FAA schema)
// Reference: TFMData JMSDD + XSD from NSRR

const { XMLParser } = require('fast-xml-parser')

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
})

// ── Flight Data Parser ──────────────────────────────────────────────────────

/**
 * Parse a TFMS flight data message.
 * A single XML message can batch multiple fltdMessage elements (multiple flights
 * from the same ARTCC in one update). Returns an ARRAY of parsed flights.
 *
 * @param {string} xml - Raw XML message
 * @param {Object} props - JMS message properties
 * @returns {Object[]} Array of parsed flight objects (may be empty)
 */
function parseFlightData(xml, props) {
  // If we have XML, parse all fltdMessage elements in the batch
  if (xml && xml.length > 10) {
    try {
      const doc = parser.parse(xml)
      const results = parseAllFlights(doc, props)
      if (results.length > 0) return results
    } catch {
      // XML parse failed — fall through to property-based result
    }
  }

  // Fallback: try to build a single flight from JMS properties alone
  const fp = buildFromProperties(props)
  return fp.acid ? [fp] : []
}

/**
 * Parse ALL fltdMessage elements from a batched TFMData XML document.
 */
function parseAllFlights(doc, props) {
  const root = doc.tfmDataService || doc.TFMDataService || doc
  const output = root.fltdOutput || findNested(root, 'fltdOutput')
  if (!output) return []

  let msgs = output.fltdMessage
  if (!msgs) return []
  if (!Array.isArray(msgs)) msgs = [msgs]

  const results = []
  for (const msg of msgs) {
    const fp = buildFromProperties(props)
    mergeSingleMessage(fp, msg)
    if (fp.acid) results.push(fp)
  }
  return results
}

/**
 * Build flight data from JMS properties.
 * TFMS properties use prefixed keys like:
 *   us_gov_dot_faa_tfm_* or direct field names
 */
function buildFromProperties(props) {
  if (!props) return {}

  const p = (key) => {
    // Try common TFMS property patterns
    return props[key]
      || props[`us_gov_dot_faa_tfm_${key}`]
      || props[`us_gov_dot_faa_atcscc_tfm_${key}`]
      || null
  }

  return {
    // Message metadata
    msgType: p('msgType') || p('MessageType') || props.msgType || null,
    timestamp: props.m_msg_last_updated || props.JMSTimestamp || null,

    // Flight identification
    acid: p('acid') || p('ACID') || p('aircraftIdentification') || null,
    gufi: p('gufi') || p('GUFI') || null,

    // Airports
    depArpt: p('depArpt') || p('departurePoint') || p('origin') || null,
    arrArpt: p('arrArpt') || p('arrivalPoint') || p('destination') || null,

    // Times
    etd: p('etd') || p('estimatedDepartureTime') || null,
    eta: p('eta') || p('estimatedArrivalTime') || null,
    atd: p('atd') || p('actualDepartureTime') || null,
    ata: p('ata') || p('actualArrivalTime') || null,

    // Flight details
    flightStatus: p('flightStatus') || p('status') || null,
    altitude: p('altitude') || p('requestedAltitude') || null,
    speed: p('speed') || p('filedSpeed') || null,
    route: p('route') || p('filedRoute') || null,
    aircraftType: p('aircraftType') || p('type') || null,
    beaconCode: p('beaconCode') || null,

    // Position (from track updates)
    lat: null,
    lon: null,
    reportedAlt: null,

    source: 'TFMS',
  }
}

/**
 * Merge XML-parsed data into the property-based flight object.
 * TFMData v3.2 XML structure:
 *   <ds:tfmDataService>
 *     <fltdOutput>
 *       <fdm:fltdMessage acid="SWA2998" depArpt="KAUS" arrArpt="KDEN" msgType="trackInformation">
 *         <fdm:trackInformation>
 *           <nxcm:qualifiedAircraftId aircraftCategory="JET">
 *             <nxce:aircraftId>SWA2998</nxce:aircraftId>
 *             <nxce:gufi>KH079461Sx</nxce:gufi>
 *             <nxce:departurePoint><nxce:airport>KAUS</nxce:airport></nxce:departurePoint>
 *             <nxce:arrivalPoint><nxce:airport>KDEN</nxce:airport></nxce:arrivalPoint>
 *           </nxcm:qualifiedAircraftId>
 *           <nxcm:speed>430</nxcm:speed>
 *           <nxcm:reportedAltitude>...<nxce:simpleAltitude>369</nxce:simpleAltitude></nxcm:reportedAltitude>
 *           <nxcm:position><nxce:latitude><nxce:latitudeDMS .../></nxce:latitude>...</nxcm:position>
 *           <nxcm:ncsmTrackData><nxcm:eta etaType="ESTIMATED" timeValue="..."/>...</nxcm:ncsmTrackData>
 */
/**
 * Merge data from a single fltdMessage element into a flight object.
 * Called once per flight in a batched message.
 */
function mergeSingleMessage(fp, msg) {
  if (!msg) return fp

  // Primary fields are XML ATTRIBUTES on fltdMessage
  fp.acid = fp.acid || msg['@_acid'] || findVal(msg, 'aircraftId')
  fp.depArpt = fp.depArpt || msg['@_depArpt']
  fp.arrArpt = fp.arrArpt || msg['@_arrArpt']
  fp.msgType = fp.msgType || msg['@_msgType']
  fp.gufi = fp.gufi || findVal(msg, 'gufi')

  // Airline / operator
  const airline = msg['@_airline'] || msg['@_major']
  if (airline) fp.airline = airline

  // Aircraft category + departure time from qualifiedAircraftId
  const qid = findNested(msg, 'qualifiedAircraftId')
  if (qid) {
    // aircraftCategory (JET/PROP/TURBOPROP) → store as aircraftType (best we have from track msgs)
    fp.aircraftType = fp.aircraftType || qid['@_aircraftCategory'] || findVal(qid, 'aircraftCategory')
    fp.userCategory = qid['@_userCategory'] || findVal(qid, 'userCategory')
    // igtd = Initial Gate Time of Departure → ETD
    fp.etd = fp.etd || findVal(qid, 'igtd')
    // Nested departure/arrival airports
    if (!fp.depArpt) fp.depArpt = findVal(findNested(qid, 'departurePoint'), 'airport')
    if (!fp.arrArpt) fp.arrArpt = findVal(findNested(qid, 'arrivalPoint'), 'airport')
    if (!fp.gufi) fp.gufi = findVal(qid, 'gufi')
  }

  // Speed
  fp.speed = fp.speed || findVal(msg, 'speed')

  // Altitude — can be in reportedAltitude > assignedAltitude > simpleAltitude
  const alt = findVal(msg, 'simpleAltitude') || findVal(msg, 'altitude')
  if (alt != null) fp.altitude = String(alt)

  // Reported altitude for current position
  fp.reportedAlt = fp.reportedAlt || fp.altitude

  // Position — DMS format: latitudeDMS degrees/minutes/seconds/direction
  const pos = findNested(msg, 'position')
  if (pos) {
    const latDMS = findNested(pos, 'latitudeDMS')
    const lonDMS = findNested(pos, 'longitudeDMS')
    if (latDMS) fp.lat = dmsToDecimal(latDMS)
    if (lonDMS) fp.lon = dmsToDecimal(lonDMS)
  }

  // ETA from ncsmTrackData
  const trackData = findNested(msg, 'ncsmTrackData')
  if (trackData) {
    const eta = findNested(trackData, 'eta')
    if (eta) {
      fp.eta = eta['@_timeValue'] || findVal(eta, 'timeValue') || fp.eta
    }
  }

  // Flight status (from flight plan messages, not track)
  fp.flightStatus = fp.flightStatus || findVal(msg, 'flightStatus')
    || msg['@_flightStatus']

  // Source facility and timestamp
  fp.sourceFacility = msg['@_sourceFacility']
  fp.sourceTimestamp = msg['@_sourceTimeStamp']

  // Route (from flight plan information messages)
  fp.route = fp.route || findVal(msg, 'routeOfFlight') || findVal(msg, 'route')

  // Beacon code
  fp.beaconCode = fp.beaconCode || findVal(msg, 'beaconCode') || findVal(msg, 'assignedBeaconCode')

  return fp
}

/**
 * Convert DMS (degrees/minutes/seconds/direction) to decimal degrees.
 * Input: { '@_degrees': '31', '@_minutes': '43', '@_seconds': '20', '@_direction': 'NORTH' }
 */
function dmsToDecimal(dms) {
  if (!dms) return null
  const deg = Number(dms['@_degrees'] || 0)
  const min = Number(dms['@_minutes'] || 0)
  const sec = Number(dms['@_seconds'] || 0)
  const dir = (dms['@_direction'] || '').toUpperCase()
  const decimal = deg + min / 60 + sec / 3600
  return (dir === 'SOUTH' || dir === 'WEST') ? -decimal : decimal
}

// ── Flow Information Parser ─────────────────────────────────────────────────

/**
 * Parse a TFMS flow information message.
 * Handles: GDP, GS, AFP, reroute, ATCSCC advisory, FCA/FEA
 *
 * @param {string} xml - Raw XML message
 * @param {Object} props - JMS message properties
 * @returns {Object|null} Parsed flow event
 */
function parseFlowData(xml, props) {
  const result = {
    msgType: null,
    eventType: null,       // GDP, GS, AFP, REROUTE, ADVISORY, CTOP
    status: null,          // ACTUAL, PROPOSED, PURGED
    airport: null,         // affected airport
    reason: null,          // WEATHER, OTHER, VOLUME, etc.
    text: null,            // advisory text
    startTime: null,
    endTime: null,
    delay: null,           // average delay in minutes
    timestamp: null,
    source: 'TFMS',
  }

  // Extract from properties
  if (props) {
    const p = (key) => props[key] || props[`us_gov_dot_faa_tfm_${key}`]
      || props[`us_gov_dot_faa_atcscc_tfm_${key}`] || null
    result.msgType = p('msgType') || p('MessageType') || props.msgType || null
    result.airport = p('airport') || p('facility') || null
    result.status = p('tmiStatus') || p('status') || null
    result.timestamp = props.m_msg_last_updated || null
  }

  // Parse XML if present
  if (xml && xml.length > 10) {
    try {
      const doc = parser.parse(xml)
      const root = doc.TFMDataService || doc.tfmDataService || doc

      // Detect event type from message structure
      if (findNested(root, 'gdpAdvisory') || findNested(root, 'groundDelayProgram')) {
        result.eventType = 'GDP'
      } else if (findNested(root, 'gsAdvisory') || findNested(root, 'groundStop')) {
        result.eventType = 'GS'
      } else if (findNested(root, 'afpAdvisory') || findNested(root, 'arrivalFlowProgram')) {
        result.eventType = 'AFP'
      } else if (findNested(root, 'reroute') || findNested(root, 'rerouteAdvisory')) {
        result.eventType = 'REROUTE'
      } else if (findNested(root, 'advisory') || findNested(root, 'atcsccAdvisory')) {
        result.eventType = 'ADVISORY'
      } else if (findNested(root, 'ctop')) {
        result.eventType = 'CTOP'
      }

      // Extract common flow fields
      const event = findNested(root, 'gdpAdvisory') || findNested(root, 'gsAdvisory')
        || findNested(root, 'afpAdvisory') || findNested(root, 'advisory')
        || findNested(root, 'reroute') || root

      result.airport = result.airport || findVal(event, 'airport') || findVal(event, 'facility')
      result.reason = findVal(event, 'impactingCondition') || findVal(event, 'reason')
      result.text = findVal(event, 'advisoryText') || findVal(event, 'text')
        || findVal(event, 'remarks')
      result.startTime = findVal(event, 'startTime') || findVal(event, 'beginDate')
      result.endTime = findVal(event, 'endTime') || findVal(event, 'endDate')
      result.delay = findVal(event, 'avgDelay') || findVal(event, 'averageDelay')
      result.status = result.status || findVal(event, 'tmiStatus') || findVal(event, 'status')
    } catch {
      // XML parse failed
    }
  }

  // Infer event type from message type if not detected from XML
  if (!result.eventType && result.msgType) {
    const mt = result.msgType.toLowerCase()
    if (mt.includes('gdp')) result.eventType = 'GDP'
    else if (mt.includes('groundstop') || mt.includes('gs_')) result.eventType = 'GS'
    else if (mt.includes('afp')) result.eventType = 'AFP'
    else if (mt.includes('reroute')) result.eventType = 'REROUTE'
    else if (mt.includes('advisory')) result.eventType = 'ADVISORY'
    else if (mt.includes('ctop')) result.eventType = 'CTOP'
  }

  return (result.eventType || result.msgType) ? result : null
}

/**
 * Determine if a TFMS message is flight data or flow data based on properties.
 */
function classifyMessage(props) {
  if (!props) return 'unknown'

  const msgType = (props.msgType || props.MessageType || props.us_gov_dot_faa_tfm_msgType || '').toLowerCase()

  // Flow types
  if (msgType.includes('gdp') || msgType.includes('groundstop') || msgType.includes('gs_')
    || msgType.includes('afp') || msgType.includes('reroute') || msgType.includes('advisory')
    || msgType.includes('ctop') || msgType.includes('fca') || msgType.includes('fea')
    || msgType.includes('fadt') || msgType.includes('runway_config') || msgType.includes('deicing')) {
    return 'flow'
  }

  // Flight types (default — most TFMS messages are flight data)
  return 'flight'
}

// ── Utilities ───────────────────────────────────────────────────────────────

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

module.exports = { parseFlightData, parseFlowData, classifyMessage }
