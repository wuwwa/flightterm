// ── SWIM Worker Process ─────────────────────────────────────────────────────
// Runs in a forked child process with its own event loop, completely isolated
// from the Express HTTP server. Connects to all SWIM SCDS feeds, parses
// messages, writes durable data (FNS/TFMS) to SQLite, and sends ephemeral
// data (SFDPS/ITWS/STDDS) snapshots to the parent process via IPC.
//
// This solves the fundamental problem: solclientjs delivers messages
// synchronously on the event loop, blocking everything. In a separate process,
// it can block all it wants — the HTTP server is unaffected.

require('dotenv').config()

const ScdsConsumer = require('./swim/scds-consumer')
const { parseNotam } = require('./swim/fns-parser')
const { parseFlightData, parseFlowData, classifyMessage } = require('./swim/tfms-parser')
const { parseSfdpsMessage } = require('./swim/sfdps-parser')
const { parseItwsMessage } = require('./swim/itws-parser')
const { parseStddsMessage } = require('./swim/stdds-parser')
const { AIRPORTS } = require('./anomaly')
const db = require('./db')

const AIRPORT_COORDS = {}
for (const ap of AIRPORTS) AIRPORT_COORDS[ap.icao] = { lat: ap.lat, lon: ap.lon }

// ── Ring buffer for ephemeral feeds ────────────────────────────────────────
const RING_CAP = 2000

function toSnake(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/[A-Z]/g, m => '_' + m.toLowerCase())] = v
  }
  return out
}

// ── Per-feed state ─────────────────────────────────────────────────────────
const sfdpsRing = []
const itwsRing = []
const stddsRing = []

const fnsBuffer = []
const tfmsFlightBuffer = []
const tfmsFlowBuffer = []

const consumers = {}

const FLUSH_BATCH = 50
const FLUSH_INTERVAL = 5000

// ── Feed stats ─────────────────────────────────────────────────────────────
const feedStats = {
  fns: { received: 0, processed: 0 },
  tfms: { received: 0, processed: 0 },
  sfdps: { received: 0, processed: 0 },
  itws: { received: 0, processed: 0 },
  stdds: { received: 0, processed: 0 },
}

// ═══════════════════════════════════════════════════════════════════════════
// FNS (NOTAMs) — writes to SQLite
// ═══════════════════════════════════════════════════════════════════════════

function handleFnsMessage(xml, props) {
  feedStats.fns.received++
  let notam = null

  if (xml && xml.length > 10) notam = parseNotam(xml)

  if (!notam && props) {
    const p = (key) => props[`us_gov_dot_faa_aim_fns_nds_${key}`] || null
    const id = p('NOTAMNumber')
    if (id) {
      notam = {
        id: `${p('ICAOId') || 'UNK'}_${id}`,
        location: p('LocationDesignator') || p('ICAOId')?.replace(/^K/, '') || null,
        classification: p('SourceType') || null,
        keyword: p('NOTAMKeyword') || null,
        type: p('NOTAMFunction') || null,
        isTfr: (p('NOTAMKeyword') || '').toUpperCase() === 'AIRSPACE',
        effective: props.m_msg_last_updated || null,
        expiration: null, permanent: false,
        text: `${p('NOTAMStatus') || ''}: ${p('NOTAMKeyword') || ''} at ${p('ICAOId') || p('LocationDesignator') || '?'}`.trim(),
        fullText: null, lat: null, lon: null,
        altitudeLower: null, altitudeUpper: null, geometry: null,
        source: 'FNS', receivedAt: new Date().toISOString(),
      }
    }
  }

  if (!notam) return
  fnsBuffer.push({ notam, xml: xml || null })
  feedStats.fns.processed++
}

function flushFns() {
  if (fnsBuffer.length === 0) return
  const batch = fnsBuffer.splice(0, FLUSH_BATCH)
  try {
    db.upsertNotamBatch(batch.map(b => b.notam), batch.map(b => b.xml))
  } catch (err) {
    console.error('swim-worker/FNS: batch error:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TFMS (Flight Plans + Flow) — writes to SQLite
// ═══════════════════════════════════════════════════════════════════════════

function handleTfmsMessage(xml, props) {
  feedStats.tfms.received++
  const msgClass = classifyMessage(props)

  if (msgClass === 'flow') {
    const event = parseFlowData(xml, props)
    if (event) tfmsFlowBuffer.push(event)
  } else {
    const flights = parseFlightData(xml, props)
    for (const fp of flights) tfmsFlightBuffer.push(fp)
  }
  feedStats.tfms.processed++
}

function flushTfms() {
  if (tfmsFlightBuffer.length > 0) {
    const batch = tfmsFlightBuffer.splice(0, FLUSH_BATCH)
    try {
      db.upsertFlightPlanBatch(batch)
      const routes = []
      for (const fp of batch) {
        if (!fp.acid || !fp.depArpt || !fp.arrArpt) continue
        const orig = AIRPORT_COORDS[fp.depArpt]
        const dest = AIRPORT_COORDS[fp.arrArpt]
        routes.push({
          callsign: fp.acid, origin_icao: fp.depArpt,
          origin_lat: orig?.lat ?? null, origin_lon: orig?.lon ?? null,
          destination_icao: fp.arrArpt, destination_lat: dest?.lat ?? null, destination_lon: dest?.lon ?? null,
          source: 'tfms',
        })
      }
      if (routes.length > 0) db.upsertRoutesBatch(routes)
    } catch (err) {
      console.error('swim-worker/TFMS: flight batch error:', err.message)
    }
  }

  if (tfmsFlowBuffer.length > 0) {
    const batch = tfmsFlowBuffer.splice(0, FLUSH_BATCH)
    try {
      const insertBatch = db.db.transaction((events) => {
        for (const event of events) db.insertFlowEvent(event)
      })
      insertBatch(batch)
    } catch (err) {
      console.error('swim-worker/TFMS: flow batch error:', err.message)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SFDPS — in-memory ring buffer only
// ═══════════════════════════════════════════════════════════════════════════

function handleSfdpsMessage(xml, props) {
  feedStats.sfdps.received++
  const tracks = parseSfdpsMessage(xml, props)
  const now = new Date().toISOString()
  for (const t of tracks) {
    const row = toSnake(t)
    row.received_at = now
    sfdpsRing.push(row)
    if (sfdpsRing.length > RING_CAP) sfdpsRing.shift()
  }
  feedStats.sfdps.processed++
}

// ═══════════════════════════════════════════════════════════════════════════
// ITWS — in-memory ring buffer only
// ═══════════════════════════════════════════════════════════════════════════

function handleItwsMessage(xml, props) {
  feedStats.itws.received++
  const event = parseItwsMessage(xml, props)
  if (event) {
    const row = toSnake(event)
    row.received_at = new Date().toISOString()
    itwsRing.push(row)
    if (itwsRing.length > RING_CAP) itwsRing.shift()
    feedStats.itws.processed++
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STDDS — in-memory ring buffer only
// ═══════════════════════════════════════════════════════════════════════════

function handleStddsMessage(xml, props) {
  feedStats.stdds.received++
  const event = parseStddsMessage(xml, props)
  if (event) {
    const row = toSnake(event)
    row.received_at = new Date().toISOString()
    stddsRing.push(row)
    if (stddsRing.length > RING_CAP) stddsRing.shift()
    feedStats.stdds.processed++
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

const delay = (ms) => new Promise(r => setTimeout(r, ms))

async function startAll() {
  const feedConfigs = [
    { name: 'FNS', handler: handleFnsMessage, vpnDefault: 'AIM_FNS', queueEnv: 'SWIM_FNS_QUEUE', vpnEnv: 'SWIM_FNS_VPN' },
    { name: 'TFMS', handler: handleTfmsMessage, vpnDefault: 'TFMS', queueEnv: 'SWIM_TFMS_QUEUE', vpnEnv: 'SWIM_TFMS_VPN' },
    { name: 'SFDPS', handler: handleSfdpsMessage, vpnDefault: 'SFDPS', queueEnv: 'SWIM_SFDPS_QUEUE', vpnEnv: 'SWIM_SFDPS_VPN' },
    { name: 'ITWS', handler: handleItwsMessage, vpnDefault: 'ITWS', queueEnv: 'SWIM_ITWS_QUEUE', vpnEnv: 'SWIM_ITWS_VPN' },
    { name: 'STDDS', handler: handleStddsMessage, vpnDefault: 'STDDS', queueEnv: 'SWIM_STDDS_QUEUE', vpnEnv: 'SWIM_STDDS_VPN' },
  ]

  const active = []

  for (const fc of feedConfigs) {
    const queue = process.env[fc.queueEnv]
    if (!process.env.SWIM_USERNAME || !process.env.SWIM_PASSWORD || !queue) {
      console.log(`swim-worker/${fc.name}: disabled`)
      continue
    }

    const config = {
      name: fc.name,
      url: process.env[`SWIM_${fc.name}_URL`] || 'tcps://ems2.swim.faa.gov:55443',
      vpn: process.env[fc.vpnEnv] || fc.vpnDefault,
      username: process.env.SWIM_USERNAME,
      password: process.env.SWIM_PASSWORD,
      queue,
    }

    try {
      const consumer = new ScdsConsumer(config, fc.handler)
      await consumer.connect()
      consumers[fc.name.toLowerCase()] = consumer
      active.push(fc.name.toLowerCase())
      console.log(`swim-worker/${fc.name}: started`)
    } catch (err) {
      console.error(`swim-worker/${fc.name}: failed:`, err.message)
    }

    await delay(2000) // stagger connections
  }

  if (active.length > 0) {
    console.log(`swim-worker: ${active.length} feed(s) active: ${active.join(', ')}`)
  }

  // Start flush timer for DB-bound feeds (FNS + TFMS only)
  setInterval(() => {
    flushFns()
    flushTfms()
  }, FLUSH_INTERVAL)

  // Send snapshots to parent process every 2 seconds
  if (process.send) {
    setInterval(() => sendSnapshot(), 2000)
  }
}

function sendSnapshot() {
  if (!process.send) return

  // Build stats for each consumer
  const consumerStats = {}
  for (const [name, consumer] of Object.entries(consumers)) {
    consumerStats[name] = consumer.getStats()
  }

  // Build surface/weather stats
  const ooois = ['SPOT_OUT', 'OFF', 'ON', 'SPOT_IN']
  const apSet = new Set()
  let surfaceCnt = 0, depCnt = 0, traconCnt = 0, rvrCnt = 0, oooiCnt = 0
  for (const e of stddsRing) {
    if (e.service === 'SMES') surfaceCnt++
    else if (e.service === 'TDES') depCnt++
    else if (e.service === 'TAIS') traconCnt++
    else if (e.service === 'APDS') rvrCnt++
    if (ooois.includes(e.event_type)) oooiCnt++
    if (e.airport) apSet.add(e.airport)
  }

  const wxSiteSet = new Set()
  const wxStats = { total: itwsRing.length, tornado: 0, windshear: 0, microburst: 0, gust_front: 0, precip: 0, hazard_text: 0, storm_motion: 0, critical: 0, sites: 0 }
  for (const e of itwsRing) {
    const t = e.event_type || ''
    if (t === 'TORNADO') wxStats.tornado++
    else if (t === 'WINDSHEAR') wxStats.windshear++
    else if (t === 'MICROBURST') wxStats.microburst++
    else if (t === 'GUST_FRONT') wxStats.gust_front++
    else if (t === 'PRECIP') wxStats.precip++
    else if (t === 'HAZARD_TEXT') wxStats.hazard_text++
    else if (t === 'STORM_MOTION') wxStats.storm_motion++
    if (e.severity === 'CRITICAL') wxStats.critical++
    if (e.airport) wxSiteSet.add(e.airport)
    else if (e.site) wxSiteSet.add(e.site)
  }
  wxStats.sites = wxSiteSet.size

  try {
    process.send({
      type: 'snapshot',
      consumerStats,
      feedStats,
      sfdps: sfdpsRing.slice(-500), // send last 500 of each
      itws: itwsRing.slice(-500),
      stdds: stddsRing.slice(-500),
      surfaceStats: { total: stddsRing.length, surface: surfaceCnt, departures: depCnt, tracon: traconCnt, rvr: rvrCnt, oooi: oooiCnt, airports: apSet.size },
      weatherStats: wxStats,
    })
  } catch (err) {
    // Parent might have died
  }
}

// ── Start ──────────────────────────────────────────────────────────────────
console.log('swim-worker: starting...')
startAll().catch(err => {
  console.error('swim-worker: fatal error:', err)
  process.exit(1)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('swim-worker: shutting down...')
  flushFns()
  flushTfms()
  for (const consumer of Object.values(consumers)) {
    try { consumer.disconnect() } catch {}
  }
  process.exit(0)
})

process.on('message', (msg) => {
  if (msg === 'shutdown') {
    process.emit('SIGTERM')
  }
})
