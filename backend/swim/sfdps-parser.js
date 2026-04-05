// ── SFDPS (SWIM Flight Data Publication Service) Parser ─────────────────────
// En route flight data from ERAM at 20 ARTCCs.
// Messages: flight plans, track updates (~1 min), departures, arrivals,
//           boundary crossings, sector data, beacon codes.
// Formats: Simple Schema XML 1.3.8 or FIXM Core 3.0 with US Extension.
// Higher frequency than TFMS — batched track updates from each ARTCC.

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
 * Parse an SFDPS message. Returns an array of track/flight objects.
 * @param {string} xml - Raw XML
 * @param {Object} props - JMS properties
 * @returns {Object[]} Array of parsed track updates
 */
function parseSfdpsMessage(xml, props) {
  const results = []

  // Extract metadata from properties
  const msgType = props?.FDPS_MessageType || props?.msgType || props?.MessageType || null
  const facility = props?.sourceFacility || props?.ARTCC || null

  if (!xml || xml.length < 20) return results

  let doc
  try { doc = parser.parse(xml) } catch { return results }

  // SFDPS wraps in MessageCollection or direct flight elements
  // Try FIXM structure first, then Simple Schema
  const flights = findAllFlights(doc)

  for (const f of flights) {
    const track = {
      acid: null,
      gufi: null,
      depArpt: null,
      arrArpt: null,
      lat: null,
      lon: null,
      altitude: null,
      speed: null,
      heading: null,
      beaconCode: null,
      sector: null,
      artcc: facility,
      flightStatus: null,
      msgType: msgType,
      timestamp: null,
      source: 'SFDPS',
    }

    // FIXM-style: flight > flightIdentification, departure, arrival, enRoute
    track.acid = f['@_acid'] || findVal(f, 'aircraftIdentification')
      || findVal(f, 'aircraftId') || findVal(f, 'acid')
    track.gufi = f['@_gufi'] || findVal(f, 'gufi')
      || findVal(f, 'globallyUniqueFlightIdentifier')
    track.depArpt = f['@_depArpt'] || findVal(f, 'departureAerodrome')
      || findVal(f, 'departurePoint') || extractAirport(f, 'departure')
    track.arrArpt = f['@_arrArpt'] || findVal(f, 'arrivalAerodrome')
      || findVal(f, 'arrivalPoint') || extractAirport(f, 'arrival')

    // Position
    const pos = findNested(f, 'position') || findNested(f, 'reportedPosition')
      || findNested(f, 'enRoutePoint')
    if (pos) {
      // Try decimal first, then DMS
      let lat = findVal(pos, 'latitude') || findVal(pos, 'lat')
      let lon = findVal(pos, 'longitude') || findVal(pos, 'lon')
      if (lat != null && typeof lat === 'number') { track.lat = lat; track.lon = Number(lon) }
      else {
        // DMS format
        const latDMS = findNested(pos, 'latitudeDMS')
        const lonDMS = findNested(pos, 'longitudeDMS')
        if (latDMS) track.lat = dmsToDecimal(latDMS)
        if (lonDMS) track.lon = dmsToDecimal(lonDMS)
      }
    }

    // Altitude, speed, heading
    track.altitude = findVal(f, 'assignedAltitude') || findVal(f, 'altitude')
      || findVal(f, 'simpleAltitude') || f['@_altitude']
    track.speed = findVal(f, 'speed') || findVal(f, 'groundSpeed') || f['@_speed']
    track.heading = findVal(f, 'heading') || findVal(f, 'trackHeading') || findVal(f, 'course')

    // Beacon code (squawk)
    track.beaconCode = findVal(f, 'beaconCode') || findVal(f, 'assignedBeaconCode')
      || f['@_beaconCode']

    // Sector
    track.sector = findVal(f, 'sector') || findVal(f, 'controlSector')
      || findVal(f, 'sectorId')

    // Status
    track.flightStatus = findVal(f, 'flightStatus') || findVal(f, 'status')
      || f['@_flightStatus']

    // Timestamp
    track.timestamp = findVal(f, 'timeAtPosition') || findVal(f, 'timestamp')
      || findVal(f, 'time') || f['@_sourceTimeStamp']

    if (track.acid) results.push(track)
  }

  return results
}

function findAllFlights(doc) {
  const flights = []

  // Try common SFDPS wrappers
  const root = doc.MessageCollection || doc.messageCollection
    || doc.SFDPSMessage || doc.sfdpsMessage
    || doc.tfmDataService || doc

  // Look for flight/message elements
  const containers = [
    findNested(root, 'fltdOutput'),
    findNested(root, 'flightData'),
    findNested(root, 'hasMember'),
    findNested(root, 'member'),
    root,
  ].filter(Boolean)

  for (const container of containers) {
    // fltdMessage (like TFMS batched format)
    let msgs = container.fltdMessage || container.flight || container.Flight
      || container.trackInformation || container.flightPlanInformation
    if (msgs) {
      if (!Array.isArray(msgs)) msgs = [msgs]
      flights.push(...msgs)
      break
    }
  }

  return flights
}

function extractAirport(obj, prefix) {
  const node = findNested(obj, prefix) || findNested(obj, `${prefix}Point`)
    || findNested(obj, `${prefix}Aerodrome`)
  if (!node) return null
  return findVal(node, 'airport') || findVal(node, 'locationIndicator')
    || findVal(node, 'icao') || (typeof node === 'string' ? node : null)
}

function dmsToDecimal(dms) {
  if (!dms) return null
  const deg = Number(dms['@_degrees'] || 0)
  const min = Number(dms['@_minutes'] || 0)
  const sec = Number(dms['@_seconds'] || 0)
  const dir = (dms['@_direction'] || '').toUpperCase()
  const decimal = deg + min / 60 + sec / 3600
  return (dir === 'SOUTH' || dir === 'WEST') ? -decimal : decimal
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

module.exports = { parseSfdpsMessage }
