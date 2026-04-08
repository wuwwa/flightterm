// ── SWIM Worker Service ─────────────────────────────────────────────────────
// Standalone Express app that connects to FAA SWIM SCDS feeds, parses messages,
// and either POSTs durable data (FNS/TFMS) to the main app via HTTP or keeps
// ephemeral data (SFDPS/ITWS/STDDS) in memory ring buffers served via HTTP GET.
//
// Runs as a separate Fly.io app with its own CPU — solclientjs can block this
// event loop all it wants without affecting the main HTTP server.

require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const express = require('express')
const axios = require('axios')

const ScdsConsumer = require('./swim/scds-consumer')
const { parseNotam } = require('./swim/fns-parser')
const { parseFlightData, parseFlowData, classifyMessage } = require('./swim/tfms-parser')
const { parseSfdpsMessage } = require('./swim/sfdps-parser')
const { parseItwsMessage } = require('./swim/itws-parser')
const { parseStddsMessage } = require('./swim/stdds-parser')
const { AIRPORTS } = require('./anomaly')

const PORT = process.env.SWIM_PORT || process.env.PORT || 3002
const MAIN_APP_URL = process.env.MAIN_APP_URL || 'http://flightterm.internal:3001'
const INTERNAL_SECRET = process.env.SWIM_INTERNAL_SECRET || ''

const AIRPORT_COORDS = {}
for (const ap of AIRPORTS) AIRPORT_COORDS[ap.icao] = { lat: ap.lat, lon: ap.lon }

// ── Ring buffer for ephemeral feeds ────────────────────────────────────────
const RING_CAP = 2000
const SNAPSHOT_CAP = 500 // max items sent per snapshot

function toSnake(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/[A-Z]/g, m => '_' + m.toLowerCase())] = v
  }
  return out
}

// ── State ──────────────────────────────────────────────────────────────────
const sfdpsRing = []
const itwsRing = []
const stddsRing = []
const fnsBuffer = []
const tfmsFlightBuffer = []
const tfmsFlowBuffer = []
const routeBuffer = []
const consumers = {}

const FLUSH_BATCH = 50
const FLUSH_INTERVAL = 5000

const feedStats = {
  fns: { received: 0, processed: 0 },
  tfms: { received: 0, processed: 0 },
  sfdps: { received: 0, processed: 0 },
  itws: { received: 0, processed: 0 },
  stdds: { received: 0, processed: 0 },
}

// ── HTTP client for posting to main app ────────────────────────────────────
const mainApi = axios.create({
  baseURL: MAIN_APP_URL,
  timeout: 10000,
  headers: INTERNAL_SECRET ? { Authorization: `Bearer ${INTERNAL_SECRET}` } : {},
})

async function postToMain(path, data) {
  try {
    await mainApi.post(path, data)
  } catch (err) {
    console.error(`swim-service: POST ${path} failed:`, err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FNS (NOTAMs) — flush to main app via HTTP
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

async function flushFns() {
  if (fnsBuffer.length === 0) return
  const batch = fnsBuffer.splice(0, FLUSH_BATCH)
  await postToMain('/internal/swim/notams', {
    notams: batch.map(b => b.notam),
    rawXmls: batch.map(b => b.xml),
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// TFMS (Flight Plans + Flow) — flush to main app via HTTP
// ═══════════════════════════════════════════════════════════════════════════

function handleTfmsMessage(xml, props) {
  feedStats.tfms.received++
  const msgClass = classifyMessage(props)

  if (msgClass === 'flow') {
    const event = parseFlowData(xml, props)
    if (event) tfmsFlowBuffer.push(event)
  } else {
    const flights = parseFlightData(xml, props)
    for (const fp of flights) {
      tfmsFlightBuffer.push(fp)
      // Build route entry
      if (fp.acid && fp.depArpt && fp.arrArpt) {
        const orig = AIRPORT_COORDS[fp.depArpt]
        const dest = AIRPORT_COORDS[fp.arrArpt]
        routeBuffer.push({
          callsign: fp.acid, origin_icao: fp.depArpt,
          origin_lat: orig?.lat ?? null, origin_lon: orig?.lon ?? null,
          destination_icao: fp.arrArpt, destination_lat: dest?.lat ?? null, destination_lon: dest?.lon ?? null,
          source: 'tfms',
        })
      }
    }
  }
  feedStats.tfms.processed++
}

async function flushTfms() {
  if (tfmsFlightBuffer.length > 0) {
    const batch = tfmsFlightBuffer.splice(0, FLUSH_BATCH)
    await postToMain('/internal/swim/flights', { plans: batch })
  }
  if (tfmsFlowBuffer.length > 0) {
    const batch = tfmsFlowBuffer.splice(0, FLUSH_BATCH)
    await postToMain('/internal/swim/flow', { events: batch })
  }
  if (routeBuffer.length > 0) {
    const batch = routeBuffer.splice(0, FLUSH_BATCH)
    await postToMain('/internal/swim/routes', { routes: batch })
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
// Stats helpers
// ═══════════════════════════════════════════════════════════════════════════

function buildWeatherStats() {
  const stats = { total: itwsRing.length, tornado: 0, windshear: 0, microburst: 0, gust_front: 0, precip: 0, hazard_text: 0, storm_motion: 0, critical: 0, sites: 0 }
  const siteSet = new Set()
  for (const e of itwsRing) {
    const t = e.event_type || ''
    if (t === 'TORNADO') stats.tornado++
    else if (t === 'WINDSHEAR') stats.windshear++
    else if (t === 'MICROBURST') stats.microburst++
    else if (t === 'GUST_FRONT') stats.gust_front++
    else if (t === 'PRECIP') stats.precip++
    else if (t === 'HAZARD_TEXT') stats.hazard_text++
    else if (t === 'STORM_MOTION') stats.storm_motion++
    if (e.severity === 'CRITICAL') stats.critical++
    if (e.airport) siteSet.add(e.airport)
    else if (e.site) siteSet.add(e.site)
  }
  stats.sites = siteSet.size
  return stats
}

function buildSurfaceStats() {
  const stats = { total: stddsRing.length, surface: 0, departures: 0, tracon: 0, rvr: 0, oooi: 0, airports: 0 }
  const apSet = new Set()
  const ooois = ['SPOT_OUT', 'OFF', 'ON', 'SPOT_IN']
  for (const e of stddsRing) {
    if (e.service === 'SMES') stats.surface++
    else if (e.service === 'TDES') stats.departures++
    else if (e.service === 'TAIS') stats.tracon++
    else if (e.service === 'APDS') stats.rvr++
    if (ooois.includes(e.event_type)) stats.oooi++
    if (e.airport) apSet.add(e.airport)
  }
  stats.airports = apSet.size
  return stats
}

// ═══════════════════════════════════════════════════════════════════════════
// SWIM lifecycle
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
    if (!process.env.SWIM_USERNAME || !process.env.SWIM_PASSWORD || !queue) continue

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
      console.log(`swim-service/${fc.name}: started`)
    } catch (err) {
      console.error(`swim-service/${fc.name}: failed:`, err.message)
    }

    await delay(2000)
  }

  if (active.length > 0) {
    console.log(`swim-service: ${active.length} feed(s) active: ${active.join(', ')}`)
  }

  // Flush durable data to main app every 5s
  setInterval(async () => {
    await flushFns()
    await flushTfms()
  }, FLUSH_INTERVAL)
}

// ═══════════════════════════════════════════════════════════════════════════
// Express server — serves ephemeral data + snapshot endpoint
// ═══════════════════════════════════════════════════════════════════════════

const app = express()

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// Full snapshot (polled by main app every 2s)
app.get('/api/snapshot', (_req, res) => {
  const consumerStats = {}
  for (const [name, consumer] of Object.entries(consumers)) {
    consumerStats[name] = consumer.getStats()
  }

  res.json({
    consumerStats,
    feedStats,
    sfdps: sfdpsRing.slice(-SNAPSHOT_CAP),
    itws: itwsRing.slice(-SNAPSHOT_CAP),
    stdds: stddsRing.slice(-SNAPSHOT_CAP),
    surfaceStats: buildSurfaceStats(),
    weatherStats: buildWeatherStats(),
  })
})

// Individual query endpoints (for direct access if needed)
app.get('/api/positions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 500, 2000)
  const result = []
  for (let i = sfdpsRing.length - 1; i >= 0 && result.length < limit; i--) {
    if (sfdpsRing[i].lat != null && sfdpsRing[i].lon != null) result.push(sfdpsRing[i])
  }
  res.json(result)
})

app.get('/api/weather', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  res.json(itwsRing.slice(-limit).reverse())
})

app.get('/api/weather/:airport', (req, res) => {
  const airport = req.params.airport.toUpperCase()
  const limit = Math.min(Number(req.query.limit) || 10, 50)
  const result = []
  for (let i = itwsRing.length - 1; i >= 0 && result.length < limit; i--) {
    if (itwsRing[i].airport === airport || itwsRing[i].site === airport) result.push(itwsRing[i])
  }
  res.json(result)
})

app.get('/api/surface', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100)
  res.json(stddsRing.slice(-limit).reverse())
})

app.get('/api/surface/positions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 300, 1000)
  const result = []
  for (let i = stddsRing.length - 1; i >= 0 && result.length < limit; i--) {
    const e = stddsRing[i]
    if (e.lat != null && e.lon != null && (e.service === 'TAIS' || e.service === 'SMES')) result.push(e)
  }
  res.json(result)
})

app.get('/api/surface/:airport', (req, res) => {
  const airport = req.params.airport.toUpperCase()
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  const result = []
  for (let i = stddsRing.length - 1; i >= 0 && result.length < limit; i--) {
    if (stddsRing[i].airport === airport) result.push(stddsRing[i])
  }
  res.json(result)
})

app.get('/api/oooi', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100)
  const oooi = ['SPOT_OUT', 'OFF', 'ON', 'SPOT_IN', 'DEPARTURE']
  const result = []
  for (let i = stddsRing.length - 1; i >= 0 && result.length < limit; i--) {
    if (oooi.includes(stddsRing[i].event_type)) result.push(stddsRing[i])
  }
  res.json(result)
})

app.get('/api/stats', (_req, res) => {
  res.json({ surface: buildSurfaceStats(), weather: buildWeatherStats() })
})

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`swim-service: listening on port ${PORT}`)
  console.log(`swim-service: main app at ${MAIN_APP_URL}`)
  startAll().catch(err => {
    console.error('swim-service: fatal error:', err)
    process.exit(1)
  })
})

process.on('SIGTERM', () => {
  console.log('swim-service: shutting down...')
  for (const consumer of Object.values(consumers)) {
    try { consumer.disconnect() } catch {}
  }
  process.exit(0)
})
