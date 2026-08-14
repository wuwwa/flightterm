// ── Phase 1 unit tests ──────────────────────────────────────────────────────
// Covers:
//   1. SFDPS parser (backend/swim/sfdps-parser.js)
//   2. New DB functions (persistFlightPositions, getPositionTrail,
//      getSurfaceFlow, getFlightLifecycleEnhanced)
//   3. Route deviation live (backend/poller.js → getRouteDeviationsLive)
//
// Run with:
//   node backend/test/phase1.test.js
//
// No external test framework — uses Node's built-in `assert` module.
// A fresh SQLite DB is created in the OS temp dir for each run so tests
// don't touch the production database.

const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ── Isolate DB: point DB_DIR at a fresh temp dir BEFORE requiring db.js ─────
const TEST_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flightterm-test-'))
process.env.DB_DIR = TEST_DB_DIR

// Now it's safe to load modules that depend on db.js
const { parseSfdpsMessage } = require('../swim/sfdps-parser')
const db = require('../db')
const poller = require('../poller')

// ── Test runner: works under both vitest and standalone `node` ──────────────
// Detect if vitest globals are present (vitest injects `it`/`describe` globally
// when run via `vitest run`). If so, use them. Otherwise fall back to a minimal
// homemade runner so `node backend/test/phase1.test.js` still works.
const isVitest = typeof globalThis.it === 'function' && typeof globalThis.describe === 'function'

const tests = []
function test(name, fn) {
  if (isVitest) {
    globalThis.it(name, fn)
  } else {
    tests.push({ name, fn })
  }
}

async function runTests() {
  if (isVitest) return // vitest runs the registered `it` blocks itself
  let passed = 0
  let failed = 0
  const failures = []
  for (const t of tests) {
    try {
      await t.fn()
      process.stdout.write(`  PASS  ${t.name}\n`)
      passed++
    } catch (err) {
      process.stdout.write(`  FAIL  ${t.name}\n`)
      failures.push({ name: t.name, err })
      failed++
    }
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed (${tests.length} total)\n`)
  if (failures.length) {
    process.stdout.write('\nFailures:\n')
    for (const f of failures) {
      process.stdout.write(`\n  ${f.name}\n`)
      process.stdout.write(`    ${f.err.stack || f.err.message}\n`)
    }
  }
  // Cleanup: close DB, remove temp dir
  try { db.close?.() } catch {}
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }) } catch {}
  process.exit(failed === 0 ? 0 : 1)
}


// ═══════════════════════════════════════════════════════════════════════════
// 1. SFDPS parser tests
// ═══════════════════════════════════════════════════════════════════════════

// A FIXM-flavoured message that the current parser can fully extract from.
// Uses `fltdMessage` wrapper (SFDPS batched format) with attributes on the
// flight element — `findVal` cannot descend into `@_`-prefixed attributes on
// child elements, but can pull text content from nested elements and reads
// attributes directly on the flight element.
const SFDPS_XML_FULL = `<?xml version="1.0" encoding="UTF-8"?>
<MessageCollection>
  <fltdOutput>
    <fltdMessage
        acid="N6482M"
        depArpt="KBFL"
        arrArpt="VNY"
        centre="ZLA"
        timestamp="2026-04-07T01:38:40.848Z"
        altitude="5500"
        speed="110"
        beaconCode="1200"
        flightStatus="PROPOSED"
        route="KBFL..VNY">
      <aircraftDescription>
        <aircraftType><icaoModelIdentifier>C152</icaoModelIdentifier></aircraftType>
      </aircraftDescription>
      <gufi codeSpace="urn:uuid">a23872ec-42e2-4735-9188-491fa3576ece</gufi>
      <position><latitude>35.3733</latitude><longitude>-118.876</longitude></position>
      <heading>180</heading>
      <sector>32</sector>
    </fltdMessage>
  </fltdOutput>
</MessageCollection>`

// The exact FIXM sample provided in the issue description. It uses nested
// attributes (e.g. `aircraftIdentification` is an XML attribute on
// `<flightIdentification>`) that the current `findVal` implementation cannot
// descend into, so the parser returns no results for it — we assert that
// behaviour explicitly so we notice if the parser is enhanced later.
const FIXM_XML_ATTRS_ONLY = `<?xml version="1.0" encoding="UTF-8"?>
<ns5:MessageCollection xmlns:ns5="http://www.faa.aero/nas/3.0" xmlns:ns2="http://www.fixm.aero/base/3.0" xmlns:ns3="http://www.fixm.aero/flight/3.0">
  <message xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ns5:FlightMessageType">
    <flight xsi:type="ns5:NasFlightType" centre="ZLA" source="FH" system="SLC" timestamp="2026-04-07T01:38:40.848Z">
      <agreed><route xsi:type="ns5:NasRouteType" nasRouteText="KBFL..VNY"/></agreed>
      <aircraftDescription xsi:type="ns5:NasAircraftType"><aircraftType><icaoModelIdentifier>C152</icaoModelIdentifier></aircraftType></aircraftDescription>
      <arrival xsi:type="ns5:NasArrivalType" arrivalPoint="VNY"/>
      <departure xsi:type="ns5:NasDepartureType" departurePoint="KBFL"/>
      <enRoute xsi:type="ns5:NasEnRouteType"><beaconCodeAssignment></beaconCodeAssignment></enRoute>
      <flightIdentification xsi:type="ns5:NasFlightIdentificationType" aircraftIdentification="N6482M"/>
      <flightStatus xsi:type="ns5:NasFlightStatusType" fdpsFlightStatus="PROPOSED"/>
      <gufi codeSpace="urn:uuid">a23872ec-42e2-4735-9188-491fa3576ece</gufi>
      <requestedAirspeed><nasAirspeed uom="KNOTS">110.0</nasAirspeed></requestedAirspeed>
    </flight>
  </message>
</ns5:MessageCollection>`

test('sfdps-parser: returns [] for empty/invalid XML', () => {
  assert.deepStrictEqual(parseSfdpsMessage('', {}), [])
  assert.deepStrictEqual(parseSfdpsMessage(null, {}), [])
  assert.deepStrictEqual(parseSfdpsMessage('<bad', {}), [])
})

test('sfdps-parser: extracts all fields from fltdMessage-wrapped FIXM', () => {
  const props = { FDPS_MessageType: 'TRACK', sourceFacility: 'ZLA' }
  const results = parseSfdpsMessage(SFDPS_XML_FULL, props)

  assert.strictEqual(results.length, 1, 'should return exactly one flight')
  const t = results[0]

  assert.strictEqual(t.acid, 'N6482M', 'acid from @_acid attribute')
  assert.strictEqual(t.depArpt, 'KBFL', 'depArpt from @_depArpt attribute')
  assert.strictEqual(t.arrArpt, 'VNY', 'arrArpt from @_arrArpt attribute')
  assert.strictEqual(
    t.gufi,
    'a23872ec-42e2-4735-9188-491fa3576ece',
    'gufi from element text content',
  )

  assert.strictEqual(t.lat, 35.3733, 'latitude from nested <position>')
  assert.strictEqual(t.lon, -118.876, 'longitude from nested <position>')

  assert.strictEqual(t.altitude, 5500, 'altitude from @_altitude attribute')
  assert.strictEqual(t.speed, 110, 'speed from @_speed attribute')
  assert.strictEqual(t.heading, 180, 'heading from <heading> element')
  assert.strictEqual(t.beaconCode, 1200, 'beaconCode from @_beaconCode attribute')
  assert.strictEqual(t.sector, 32, 'sector from <sector> element')

  // artcc comes from @_centre attribute on the flight element
  assert.strictEqual(t.artcc, 'ZLA', 'artcc from centre attribute')

  // aircraftType descends into <aircraftType><icaoModelIdentifier>
  assert.strictEqual(
    t.aircraftType,
    'C152',
    'aircraftType from nested <icaoModelIdentifier>',
  )

  assert.strictEqual(t.route, 'KBFL..VNY', 'route from @_route attribute')
  assert.strictEqual(
    t.flightStatus,
    'PROPOSED',
    'flightStatus from @_flightStatus attribute',
  )
  assert.strictEqual(
    t.timestamp,
    '2026-04-07T01:38:40.848Z',
    'timestamp from @_timestamp attribute',
  )
  assert.strictEqual(t.source, 'SFDPS', 'source is hard-coded to SFDPS')
  assert.strictEqual(t.msgType, 'TRACK', 'msgType from props.FDPS_MessageType')
})

test('sfdps-parser: falls back to facility prop when centre attribute missing', () => {
  const xml = `<?xml version="1.0"?>
<MessageCollection>
  <fltdOutput>
    <fltdMessage acid="UAL123" depArpt="KSFO" arrArpt="KJFK">
      <gufi>test-gufi-123</gufi>
    </fltdMessage>
  </fltdOutput>
</MessageCollection>`
  const results = parseSfdpsMessage(xml, { sourceFacility: 'ZNY' })
  assert.strictEqual(results.length, 1)
  assert.strictEqual(results[0].artcc, 'ZNY', 'falls back to props.sourceFacility')
})

test('sfdps-parser: skips flights with no acid', () => {
  // FIXM sample from issue: aircraftIdentification is an attribute on a child
  // element, which current findVal cannot descend into — so acid is null and
  // the flight is dropped (line 122: `if (track.acid) results.push(track)`).
  const results = parseSfdpsMessage(FIXM_XML_ATTRS_ONLY, {
    FDPS_MessageType: 'TRACK',
    sourceFacility: 'ZLA',
  })
  assert.deepStrictEqual(
    results,
    [],
    'flights without an extractable acid are skipped',
  )
})

test('sfdps-parser: handles multiple flights in one message', () => {
  const xml = `<?xml version="1.0"?>
<MessageCollection>
  <fltdOutput>
    <fltdMessage acid="AAL100" depArpt="KJFK" arrArpt="KLAX" centre="ZOB"/>
    <fltdMessage acid="DAL200" depArpt="KATL" arrArpt="KSEA" centre="ZTL"/>
  </fltdOutput>
</MessageCollection>`
  const results = parseSfdpsMessage(xml, {})
  assert.strictEqual(results.length, 2, 'returns two flights')
  const acids = results.map(r => r.acid).sort()
  assert.deepStrictEqual(acids, ['AAL100', 'DAL200'])
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. DB function tests
// ═══════════════════════════════════════════════════════════════════════════

// Helper: clean the tables we care about before each DB test
function cleanDbState() {
  db.db.exec(`
    DELETE FROM flight_positions;
    DELETE FROM flight_plans;
    DELETE FROM surface_events;
  `)
}

// Helper: insert a flight position with a specific timestamp (bypasses
// persistFlightPositions so we can control recorded_at for trail ordering).
function insertPositionRaw(row) {
  db.db.prepare(`
    INSERT INTO flight_positions
      (callsign, lat, lon, altitude, speed, heading, sector, artcc, recorded_at)
    VALUES
      (@callsign, @lat, @lon, @altitude, @speed, @heading, @sector, @artcc, @recorded_at)
  `).run(row)
}

test('db.persistFlightPositions: no-op on empty/null input', () => {
  cleanDbState()
  assert.strictEqual(db.persistFlightPositions([]), 0)
  assert.strictEqual(db.persistFlightPositions(null), 0)
  assert.strictEqual(db.persistFlightPositions(undefined), 0)
})

test('db.persistFlightPositions: only inserts for flights with matching flight_plan', () => {
  cleanDbState()

  // Seed: one known flight plan (updated_at defaults to now)
  db.upsertFlightPlan({
    acid: 'UAL123',
    depArpt: 'KSFO',
    arrArpt: 'KJFK',
    aircraftType: 'B738',
  })

  const snapshot = [
    // Matching flight plan → should be persisted
    {
      acid: 'UAL123',
      lat: 37.7749,
      lon: -122.4194,
      altitude: 35000,
      speed: 450,
      heading: 90,
      sector: '42',
      artcc: 'ZOA',
    },
    // No matching flight plan → should be skipped
    {
      acid: 'XXX999',
      lat: 40.0,
      lon: -100.0,
      altitude: 30000,
      speed: 400,
      heading: 180,
    },
    // Matching plan but missing coordinates → should be skipped
    {
      acid: 'UAL123',
      lat: null,
      lon: null,
      altitude: 36000,
    },
  ]

  const inserted = db.persistFlightPositions(snapshot)
  assert.strictEqual(inserted, 1, 'only one row persisted')

  const trail = db.getPositionTrail('UAL123')
  assert.strictEqual(trail.length, 1)
  assert.strictEqual(trail[0].lat, 37.7749)
  assert.strictEqual(trail[0].lon, -122.4194)
  assert.strictEqual(trail[0].artcc, 'ZOA')
  assert.strictEqual(trail[0].sector, '42')

  // Unknown callsign never made it in
  assert.strictEqual(db.getPositionTrail('XXX999').length, 0)
})

test('db.persistFlightPositions: deduplicates multiple snapshots per callsign', () => {
  cleanDbState()
  db.upsertFlightPlan({ acid: 'DAL500', depArpt: 'KATL', arrArpt: 'KSEA' })

  // Three snapshots for the same flight in one batch → keeps only the last one
  const inserted = db.persistFlightPositions([
    { acid: 'DAL500', lat: 33.0, lon: -84.0, altitude: 10000, speed: 300 },
    { acid: 'DAL500', lat: 34.0, lon: -85.0, altitude: 20000, speed: 350 },
    { acid: 'DAL500', lat: 35.0, lon: -86.0, altitude: 30000, speed: 400 },
  ])
  assert.strictEqual(inserted, 1, 'deduped to 1 row per callsign per batch')

  const trail = db.getPositionTrail('DAL500')
  assert.strictEqual(trail.length, 1)
  assert.strictEqual(trail[0].lat, 35.0, 'keeps the latest position in snapshot')
  assert.strictEqual(trail[0].altitude, 30000)
})

test('db.getPositionTrail: returns positions ordered by recorded_at ASC', () => {
  cleanDbState()

  const t1 = new Date(Date.now() - 50 * 60 * 1000).toISOString()
  const t2 = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const t3 = new Date(Date.now() - 10 * 60 * 1000).toISOString()

  // Insert out of chronological order
  insertPositionRaw({
    callsign: 'SWA999',
    lat: 32.0, lon: -96.0, altitude: 30000, speed: 420, heading: 270,
    sector: 'A', artcc: 'ZFW',
    recorded_at: t2,
  })
  insertPositionRaw({
    callsign: 'SWA999',
    lat: 31.0, lon: -95.0, altitude: 25000, speed: 380, heading: 260,
    sector: 'B', artcc: 'ZFW',
    recorded_at: t1,
  })
  insertPositionRaw({
    callsign: 'SWA999',
    lat: 33.0, lon: -97.0, altitude: 35000, speed: 450, heading: 280,
    sector: 'C', artcc: 'ZAB',
    recorded_at: t3,
  })

  const trail = db.getPositionTrail('SWA999')
  assert.strictEqual(trail.length, 3)
  assert.strictEqual(trail[0].recorded_at, t1, 'first is earliest')
  assert.strictEqual(trail[1].recorded_at, t2, 'middle')
  assert.strictEqual(trail[2].recorded_at, t3, 'last is latest')

  // Shape check
  const row = trail[0]
  assert.ok('callsign' in row)
  assert.ok('lat' in row)
  assert.ok('lon' in row)
  assert.ok('altitude' in row)
  assert.ok('speed' in row)
  assert.ok('heading' in row)
  assert.ok('sector' in row)
  assert.ok('artcc' in row)
  assert.ok('recorded_at' in row)
})

test('db.getPositionTrail: excludes positions older than 2 hours', () => {
  cleanDbState()
  // Very old timestamp
  insertPositionRaw({
    callsign: 'OLD001',
    lat: 1, lon: 1, altitude: 1000, speed: 100, heading: 0,
    sector: null, artcc: null,
    recorded_at: '2020-01-01T00:00:00.000Z',
  })
  // Use SQLite's "now" so it's definitely within the 6-hour window
  db.db.prepare(`
    INSERT INTO flight_positions (callsign, lat, lon, altitude, recorded_at)
    VALUES ('OLD001', 2, 2, 2000, datetime('now'))
  `).run()

  const trail = db.getPositionTrail('OLD001')
  assert.strictEqual(trail.length, 1, 'old row filtered out')
  assert.strictEqual(trail[0].lat, 2)
})

test('db.getSurfaceFlow: returns the documented shape even when empty', () => {
  cleanDbState()
  const flow = db.getSurfaceFlow('KJFK')
  assert.strictEqual(typeof flow, 'object')
  assert.strictEqual(flow.airport, 'KJFK')

  // depQueue: { count, flights: [] }
  assert.ok(flow.depQueue, 'has depQueue')
  assert.strictEqual(flow.depQueue.count, 0)
  assert.ok(Array.isArray(flow.depQueue.flights))
  assert.strictEqual(flow.depQueue.flights.length, 0)

  // throughput: array of { bin, departures, arrivals }
  assert.ok(Array.isArray(flow.throughput), 'throughput is an array')

  // activeGroundMovements: number
  assert.strictEqual(typeof flow.activeGroundMovements, 'number')
  assert.strictEqual(flow.activeGroundMovements, 0)

  // runways: array of { runway, event_type, ops }
  assert.ok(Array.isArray(flow.runways), 'runways is an array')
})

test('db.getSurfaceFlow: populated data flows through each section', () => {
  cleanDbState()
  const now = new Date().toISOString()

  // A pushback without a corresponding OFF → should appear in depQueue
  db.db.prepare(`
    INSERT INTO surface_events (service, event_type, airport, callsign, received_at)
    VALUES ('TFDM', 'SPOT_OUT', 'KJFK', 'DAL100', datetime('now', '-5 minutes'))
  `).run()

  // A matched OFF/ON pair on runway 04L → throughput + runway counts
  db.db.prepare(`
    INSERT INTO surface_events (service, event_type, airport, callsign, runway, received_at)
    VALUES ('TFDM', 'OFF', 'KJFK', 'AAL200', '04L', datetime('now', '-30 minutes'))
  `).run()
  db.db.prepare(`
    INSERT INTO surface_events (service, event_type, airport, callsign, runway, received_at)
    VALUES ('TFDM', 'ON', 'KJFK', 'AAL200', '04L', datetime('now', '-10 minutes'))
  `).run()

  // An active ground movement (SMES position in the last 5 minutes)
  db.db.prepare(`
    INSERT INTO surface_events (service, event_type, airport, callsign, lat, lon, received_at)
    VALUES ('SMES', 'POSITION', 'KJFK', 'UAL300', 40.64, -73.78, datetime('now', '-2 minutes'))
  `).run()

  const flow = db.getSurfaceFlow('KJFK')
  assert.strictEqual(flow.airport, 'KJFK')
  assert.strictEqual(flow.depQueue.count, 1, 'pushback without OFF appears in queue')
  assert.strictEqual(flow.depQueue.flights[0].callsign, 'DAL100')

  assert.ok(flow.throughput.length >= 1, 'throughput has at least one bin')
  const totalDepartures = flow.throughput.reduce((s, r) => s + (r.departures || 0), 0)
  const totalArrivals = flow.throughput.reduce((s, r) => s + (r.arrivals || 0), 0)
  assert.strictEqual(totalDepartures, 1, 'one OFF counted as departure')
  assert.strictEqual(totalArrivals, 1, 'one ON counted as arrival')

  assert.strictEqual(flow.activeGroundMovements, 1, 'one active SMES flight')

  const runway04L = flow.runways.find(r => r.runway === '04L')
  assert.ok(runway04L, 'runway 04L has activity')
  // Sum across OFF/ON rows
  const runwayOps = flow.runways
    .filter(r => r.runway === '04L')
    .reduce((s, r) => s + r.ops, 0)
  assert.strictEqual(runwayOps, 2, 'two ops total on 04L (OFF + ON)')
})

test('db.getFlightLifecycleEnhanced: extends base lifecycle with trail, phases, artccProgression', () => {
  cleanDbState()

  // Seed a flight plan so the base lifecycle has a `plan` field
  db.upsertFlightPlan({
    acid: 'TEST123',
    depArpt: 'KSFO',
    arrArpt: 'KJFK',
    aircraftType: 'B738',
  })

  // Seed a position trail showing CLIMB → CRUISE → DESCENT across two ARTCCs.
  // Spacing ensures each phase lasts more than 30 seconds.
  const base = new Date()
  const t = (minAgoFromNow) =>
    new Date(base.getTime() - minAgoFromNow * 60000).toISOString()

  const points = [
    { minAgo: 50, alt: 10000, artcc: 'ZOA', sector: 'A1' },
    { minAgo: 48, alt: 15000, artcc: 'ZOA', sector: 'A1' }, // +5000 → CLIMB
    { minAgo: 46, alt: 20000, artcc: 'ZOA', sector: 'A2' }, // +5000 → CLIMB
    { minAgo: 44, alt: 25000, artcc: 'ZLC', sector: 'B1' }, // +5000 → CLIMB, new ARTCC
    { minAgo: 40, alt: 35000, artcc: 'ZLC', sector: 'B2' }, // +10000 → CLIMB
    { minAgo: 30, alt: 35000, artcc: 'ZLC', sector: 'B2' }, // 0 → CRUISE
    { minAgo: 20, alt: 35000, artcc: 'ZDV', sector: 'C1' }, // 0 → CRUISE, new ARTCC
    { minAgo: 10, alt: 20000, artcc: 'ZDV', sector: 'C2' }, // -15000 → DESCENT
    { minAgo: 2,  alt: 5000,  artcc: 'ZDV', sector: 'C3' }, // -15000 → DESCENT
  ]

  for (const p of points) {
    insertPositionRaw({
      callsign: 'TEST123',
      lat: 37 + p.minAgo * 0.01,
      lon: -122 + p.minAgo * 0.05,
      altitude: p.alt,
      speed: 450,
      heading: 90,
      sector: p.sector,
      artcc: p.artcc,
      recorded_at: t(p.minAgo),
    })
  }

  const result = db.getFlightLifecycleEnhanced('TEST123')

  // Base lifecycle fields
  assert.strictEqual(result.callsign, 'TEST123', 'callsign from base')
  assert.ok(result.plan, 'base plan included')
  assert.strictEqual(result.plan.dep_arpt, 'KSFO')
  assert.strictEqual(result.plan.arr_arpt, 'KJFK')
  assert.ok('milestones' in result, 'milestones from base')
  assert.ok('times' in result, 'times from base')
  assert.ok('delays' in result, 'delays from base')

  // Enhanced additions
  assert.ok(Array.isArray(result.trail), 'trail is an array')
  assert.strictEqual(result.trail.length, points.length, 'trail includes every point')
  // Trail uses short-key shape { lat, lon, alt, spd, hdg, sector, artcc, t }
  const p0 = result.trail[0]
  assert.ok('lat' in p0 && 'lon' in p0 && 'alt' in p0 && 'spd' in p0
    && 'hdg' in p0 && 'sector' in p0 && 'artcc' in p0 && 't' in p0,
    'trail entry has expected short keys')

  // Phases should include at least a CLIMB, CRUISE, and DESCENT segment
  assert.ok(Array.isArray(result.phases), 'phases is an array')
  const phaseNames = result.phases.map(p => p.phase)
  assert.ok(phaseNames.includes('CLIMB'), 'has CLIMB phase')
  assert.ok(phaseNames.includes('CRUISE'), 'has CRUISE phase')
  assert.ok(phaseNames.includes('DESCENT'), 'has DESCENT phase')
  // Phase records have the documented shape
  for (const ph of result.phases) {
    assert.ok('phase' in ph && 'startTime' in ph && 'endTime' in ph
      && 'durationMin' in ph && 'startAlt' in ph && 'endAlt' in ph
      && 'startSector' in ph && 'startArtcc' in ph,
      'phase entry shape')
  }

  // ARTCC progression: unique, in chronological order
  assert.ok(Array.isArray(result.artccProgression), 'artccProgression is an array')
  const artccs = result.artccProgression.map(a => a.artcc)
  assert.deepStrictEqual(artccs, ['ZOA', 'ZLC', 'ZDV'],
    'ARTCCs listed in order visited, deduplicated')
  for (const a of result.artccProgression) {
    assert.ok('artcc' in a && 'sector' in a && 'time' in a,
      'artccProgression entry shape')
  }
})

test('db.getFlightLifecycleEnhanced: works when no trail exists', () => {
  cleanDbState()
  db.upsertFlightPlan({ acid: 'NOTRAIL', depArpt: 'KORD', arrArpt: 'KBOS' })

  const result = db.getFlightLifecycleEnhanced('NOTRAIL')
  assert.strictEqual(result.callsign, 'NOTRAIL')
  assert.deepStrictEqual(result.trail, [], 'empty trail')
  assert.deepStrictEqual(result.phases, [], 'no phases computed')
  assert.deepStrictEqual(result.artccProgression, [], 'no ARTCC progression')
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. poller.getRouteDeviationsLive tests
// ═══════════════════════════════════════════════════════════════════════════

test('poller.getRouteDeviationsLive: returns empty array when nothing is cached', () => {
  poller._internals.resetFlights()
  poller._internals.enrichCache.clear()
  const out = poller.getRouteDeviationsLive()
  assert.ok(Array.isArray(out), 'returns an array')
  assert.strictEqual(out.length, 0)
})

test('poller.getRouteDeviationsLive: aggregates and sorts deviations by avg_km', () => {
  poller._internals.enrichCache.clear()

  const flights = [
    { icao: 'a00001' },
    { icao: 'a00002' },
    { icao: 'a00003' },
    { icao: 'a00004' }, // below threshold
    { icao: 'a00005' }, // no enrichment
  ]
  poller._internals._setTestFlights(flights)

  // Two flights on KJFK→KLAX with big deviations
  poller._internals.enrichCache.set('a00001', {
    routeDeviation: 40,
    flightroute: {
      origin: { icao_code: 'KJFK' },
      destination: { icao_code: 'KLAX' },
    },
  })
  poller._internals.enrichCache.set('a00002', {
    routeDeviation: 60,
    flightroute: {
      origin: { icao_code: 'KJFK' },
      destination: { icao_code: 'KLAX' },
    },
  })
  // One flight on KATL→KSEA with a smaller (but above threshold) deviation
  poller._internals.enrichCache.set('a00003', {
    routeDeviation: 25,
    flightroute: {
      origin: { icao_code: 'KATL' },
      destination: { icao_code: 'KSEA' },
    },
  })
  // Below 20 km threshold — ignored
  poller._internals.enrichCache.set('a00004', {
    routeDeviation: 5,
    flightroute: {
      origin: { icao_code: 'KBOS' },
      destination: { icao_code: 'KMIA' },
    },
  })
  // No enrichment at all (icao a00005 intentionally missing)

  const out = poller.getRouteDeviationsLive(20, 25)
  assert.ok(Array.isArray(out))
  assert.strictEqual(out.length, 2, 'two route pairs above threshold')

  // Sorted by avg_km descending
  assert.strictEqual(out[0].dep_arpt, 'KJFK')
  assert.strictEqual(out[0].arr_arpt, 'KLAX')
  assert.strictEqual(out[0].flights, 2)
  assert.strictEqual(out[0].max_km, 60)
  assert.strictEqual(out[0].avg_km, 50, '(40+60)/2 = 50')

  assert.strictEqual(out[1].dep_arpt, 'KATL')
  assert.strictEqual(out[1].arr_arpt, 'KSEA')
  assert.strictEqual(out[1].flights, 1)
  assert.strictEqual(out[1].max_km, 25)
  assert.strictEqual(out[1].avg_km, 25)

  // totalDev is stripped from output
  for (const r of out) {
    assert.strictEqual(r.totalDev, undefined, 'totalDev not present in output')
    // Required shape keys
    assert.ok('dep_arpt' in r)
    assert.ok('arr_arpt' in r)
    assert.ok('flights' in r)
    assert.ok('max_km' in r)
    assert.ok('avg_km' in r)
  }
})

test('poller.getRouteDeviationsLive: respects minDevKm and limit arguments', () => {
  poller._internals.enrichCache.clear()
  poller._internals._setTestFlights([
    { icao: 'b00001' },
    { icao: 'b00002' },
    { icao: 'b00003' },
  ])

  poller._internals.enrichCache.set('b00001', {
    routeDeviation: 30,
    flightroute: { origin: { icao_code: 'A' }, destination: { icao_code: 'B' } },
  })
  poller._internals.enrichCache.set('b00002', {
    routeDeviation: 80,
    flightroute: { origin: { icao_code: 'C' }, destination: { icao_code: 'D' } },
  })
  poller._internals.enrichCache.set('b00003', {
    routeDeviation: 50,
    flightroute: { origin: { icao_code: 'E' }, destination: { icao_code: 'F' } },
  })

  // minDevKm = 40 → filters out b00001 (30 km)
  const filtered = poller.getRouteDeviationsLive(40, 25)
  assert.strictEqual(filtered.length, 2)
  assert.ok(filtered.every(r => r.avg_km >= 40))

  // limit = 1 → only the top entry
  const limited = poller.getRouteDeviationsLive(20, 1)
  assert.strictEqual(limited.length, 1)
  assert.strictEqual(limited[0].max_km, 80, 'top entry is the biggest deviation')
})

test('poller.getRouteDeviationsLive: falls back to tfms fields when flightroute is missing', () => {
  poller._internals.enrichCache.clear()
  poller._internals._setTestFlights([{ icao: 'c00001' }])

  poller._internals.enrichCache.set('c00001', {
    routeDeviation: 35,
    // No flightroute — should fall back to tfms
    tfms: { dep_arpt: 'KDEN', arr_arpt: 'KPHX' },
  })

  const out = poller.getRouteDeviationsLive(20, 25)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].dep_arpt, 'KDEN')
  assert.strictEqual(out[0].arr_arpt, 'KPHX')
  assert.strictEqual(out[0].avg_km, 35)
})

// ═══════════════════════════════════════════════════════════════════════════
runTests().catch(err => {
  console.error(err)
  process.exit(1)
})

if (isVitest) {
  globalThis.afterAll(() => {
    try { db.close?.() } catch {}
    try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }) } catch {}
  })
}
