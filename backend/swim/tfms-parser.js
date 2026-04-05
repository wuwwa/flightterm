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
    eventType: null,       // GDP, GS, AFP, REROUTE, ADVISORY, CTOP, RSTR, GADV, FXA, APTC
    status: null,
    airport: null,
    facility: null,        // ARTCC (ZNY, ZDC, etc.)
    reason: null,
    text: null,
    startTime: null,
    endTime: null,
    delay: null,
    timestamp: null,
    // RSTR-specific
    restrictionType: null, // MIT, DEPARTURE, etc.
    restrictionValue: null,// e.g. "15" (miles in trail)
    // FXA-specific
    geometry: null,        // array of [lat, lon] points
    ceiling: null,         // FL
    floor: null,           // FL
    fcaName: null,
    // APTC-specific (returned separately via parseAirportConfig)
    source: 'TFMS',
  }

  // Extract from properties
  if (props) {
    const p = (key) => props[key] || props[`us_gov_dot_faa_tfm_${key}`]
      || props[`us_gov_dot_faa_atcscc_tfm_${key}`] || null
    result.msgType = p('msgType') || p('MessageType') || props.msgType || null
    result.airport = p('airport') || p('facility') || null
    result.status = p('tmiStatus') || p('status') || null
    result.timestamp = props.m_msg_last_updated || props.TimeStamp || null
  }

  if (!xml || xml.length < 10) {
    // Infer type from msgType property
    inferEventType(result)
    return (result.eventType || result.msgType) ? result : null
  }

  let doc
  try { doc = parser.parse(xml) } catch { return result.msgType ? result : null }
  const root = doc.tfmDataService || doc.TFMDataService || doc
  const output = root.fiOutput || findNested(root, 'fiOutput') || root
  const fi = output.fiMessage || findNested(output, 'fiMessage') || output

  // ── APTC: Airport Configuration ─────────────────────────────────────
  const aptc = findNested(fi, 'airportConfigMessage')
  if (aptc) {
    result.eventType = 'APTC'
    result.airport = findVal(aptc, 'airport')
    result.facility = findVal(aptc, 'facility')
    result.text = [
      `rwy arr:${findVal(aptc, 'arrRunwayConf')} dep:${findVal(aptc, 'depRunwayConf')}`,
      `rate arr:${findVal(aptc, 'arrRate')}/hr dep:${findVal(aptc, 'depRate')}/hr`,
      findVal(aptc, 'weather') || '',
    ].filter(Boolean).join(' · ')
    result.arrRunwayConf = findVal(aptc, 'arrRunwayConf')
    result.depRunwayConf = findVal(aptc, 'depRunwayConf')
    result.arrRate = Number(findVal(aptc, 'arrRate')) || null
    result.depRate = Number(findVal(aptc, 'depRate')) || null
    result.weather = findVal(aptc, 'weather') // VMC/IMC
    result.timestamp = findVal(aptc, 'eventTime') || result.timestamp
    return result
  }

  // ── GADV: General Advisory ──────────────────────────────────────────
  const gadv = findNested(fi, 'generalAdvisory')
  if (gadv) {
    result.eventType = 'GADV'
    result.text = findVal(gadv, 'advisoryText') || findVal(gadv, 'advisoryTitle')
    result.facility = findVal(gadv, 'origin') || findVal(gadv, 'facilities')
    result.reason = findVal(gadv, 'advisoryTitle')
    const period = findNested(gadv, 'effectivePeriod')
    result.startTime = findVal(period || gadv, 'startTime')
    result.endTime = findVal(period || gadv, 'endTime')
    result.timestamp = findVal(gadv, 'dateSent') || result.timestamp
    return result
  }

  // ── RSTR: Restriction (MIT, departure holds) ────────────────────────
  const rstr = findNested(fi, 'restrictionMessage')
  if (rstr) {
    result.eventType = 'RSTR'
    result.facility = findVal(rstr, 'facility')
    result.airport = findVal(rstr, 'airports')
    result.restrictionType = findVal(rstr, 'restrictionType') // MIT, DEPARTURE
    result.restrictionValue = findVal(rstr, 'mitValue')
    result.reason = findVal(rstr, 'reasonText')
    result.text = `${findVal(rstr, 'restrictionCategory') || ''} ${findVal(rstr, 'restrictedNasElements') || ''}: ${findVal(rstr, 'reasonText') || ''}`.trim()
    result.startTime = findVal(rstr, 'startTime')
    result.endTime = findVal(rstr, 'stopTime')
    result.timestamp = findVal(rstr, 'eventTime') || result.timestamp
    return result
  }

  // ── FXA: Flow Evaluation/Constrained Area ───────────────────────────
  const fxa = findNested(fi, 'feaFca')
  if (fxa) {
    result.eventType = 'FXA'
    result.fcaName = findVal(fxa, 'fcaName')
    result.reason = findVal(fxa, 'fcaReason')
    result.status = findVal(fxa, 'tmiStatus')
    result.startTime = findVal(fxa, 'startTime')
    result.endTime = findVal(fxa, 'endTime')
    result.ceiling = findVal(fxa, 'ceiling')
    result.floor = findVal(fxa, 'floor')
    result.text = `${result.fcaName || ''}: ${result.reason || ''} FL${result.floor || '?'}-FL${result.ceiling || '?'}`.trim()
    // Extract geometry points
    const line = findNested(fxa, 'line')
    if (line) {
      let points = findNested(line, 'points')
      if (points) {
        let ptList = points.point || points
        if (!Array.isArray(ptList)) ptList = [ptList]
        const coords = ptList.map(pt => {
          const lat = Number(findVal(pt, 'latitude'))
          const lon = Number(findVal(pt, 'longitude'))
          return (!isNaN(lat) && !isNaN(lon)) ? [lat, lon] : null
        }).filter(Boolean)
        if (coords.length > 0) result.geometry = coords
      }
    }
    return result
  }

  // ── GDP, GS, AFP, REROUTE, CTOP, TMI_FLIGHT_LIST ───────────────────
  if (findNested(fi, 'gdpAdvisory') || findNested(fi, 'groundDelayProgram')) result.eventType = 'GDP'
  else if (findNested(fi, 'gsAdvisory') || findNested(fi, 'groundStop')) result.eventType = 'GS'
  else if (findNested(fi, 'afpAdvisory')) result.eventType = 'AFP'
  else if (findNested(fi, 'rerouteAdvisory') || findNested(fi, 'reroute')) result.eventType = 'REROUTE'
  else if (findNested(fi, 'ctop')) result.eventType = 'CTOP'
  else if (findNested(fi, 'tmiFlightDataList')) result.eventType = 'TMI_LIST'

  const event = findNested(fi, 'gdpAdvisory') || findNested(fi, 'gsAdvisory')
    || findNested(fi, 'afpAdvisory') || findNested(fi, 'rerouteAdvisory')
    || findNested(fi, 'reroute') || fi

  result.airport = result.airport || findVal(event, 'airport') || findVal(event, 'facility')
  result.reason = result.reason || findVal(event, 'impactingCondition') || findVal(event, 'reason')
  result.text = result.text || findVal(event, 'advisoryText') || findVal(event, 'text') || findVal(event, 'remarks')
  result.startTime = result.startTime || findVal(event, 'startTime') || findVal(event, 'beginDate')
  result.endTime = result.endTime || findVal(event, 'endTime') || findVal(event, 'endDate')
  result.delay = findVal(event, 'avgDelay') || findVal(event, 'averageDelay')
  result.status = result.status || findVal(event, 'tmiStatus') || findVal(event, 'status')

  inferEventType(result)
  return (result.eventType || result.msgType) ? result : null
}

function inferEventType(result) {
  if (result.eventType) return
  if (!result.msgType) return
  const mt = result.msgType.toLowerCase()
  if (mt === 'aptc') result.eventType = 'APTC'
  else if (mt === 'gadv') result.eventType = 'GADV'
  else if (mt === 'rstr') result.eventType = 'RSTR'
  else if (mt === 'fxa' || mt === 'fca') result.eventType = 'FXA'
  else if (mt.includes('gdp')) result.eventType = 'GDP'
  else if (mt.includes('groundstop') || mt === 'gs_advisory') result.eventType = 'GS'
  else if (mt.includes('afp')) result.eventType = 'AFP'
  else if (mt.includes('reroute')) result.eventType = 'REROUTE'
  else if (mt.includes('advisory') || mt === 'gadv') result.eventType = 'GADV'
  else if (mt.includes('ctop')) result.eventType = 'CTOP'
  else if (mt.includes('tmi_flight')) result.eventType = 'TMI_LIST'
  else result.eventType = mt.toUpperCase()
}

/**
 * Determine if a TFMS message is flight data or flow data based on properties.
 */
function classifyMessage(props) {
  if (!props) return 'unknown'

  const msgType = (props.msgType || props.MessageType || props.us_gov_dot_faa_tfm_msgType || '').toLowerCase()
  const dataClass = (props.TFMDataClass || props.TFMS_CATEGORY || '').toLowerCase()

  // Flow types — check both msgType and TFMDataClass
  if (dataClass.includes('flow')) return 'flow'
  if (msgType.includes('gdp') || msgType.includes('groundstop') || msgType.includes('gs_')
    || msgType.includes('afp') || msgType.includes('reroute') || msgType.includes('advisory')
    || msgType.includes('ctop') || msgType.includes('fca') || msgType.includes('fea')
    || msgType.includes('fadt') || msgType.includes('runway_config') || msgType.includes('deicing')
    || msgType === 'aptc' || msgType === 'gadv' || msgType === 'rstr' || msgType === 'fxa'
    || msgType.includes('tmi_flight')) {
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
