// ── SWIM Worker Service ─────────────────────────────────────────────────────
// Standalone Express app that connects to FAA SWIM SCDS feeds, parses messages,
// and either POSTs durable data (FNS/TFMS) to the main app via HTTP or keeps
// ephemeral data (SFDPS/ITWS/STDDS) in memory ring buffers served via HTTP GET.
//
// Runs as a separate Fly.io app with its own CPU — solclientjs can block this
// event loop all it wants without affecting the main HTTP server.

const path = require('path')
require('dotenv').config({
  path: [path.join(__dirname, '.env'), path.join(__dirname, 'env')],
  quiet: true,
})
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
const WORKER_API_SECRET = process.env.SWIM_WORKER_API_SECRET || INTERNAL_SECRET
const MAIN_POST_TIMEOUT_MS = Number(process.env.MAIN_POST_TIMEOUT_MS) || 10000
const MAIN_SLOW_MS = Number(process.env.MAIN_SLOW_MS) || 8000
const MAX_DURABLE_BUFFER = Number(process.env.SWIM_MAX_DURABLE_BUFFER) || 5000
const MAX_BACKOFF_TICKS = Number(process.env.SWIM_BACKOFF_MAX_TICKS) || 6
const SEND_NOTAM_RAW_XML = process.env.SEND_NOTAM_RAW_XML === 'true'

const AIRPORT_COORDS = {}
for (const ap of AIRPORTS) AIRPORT_COORDS[ap.icao] = { lat: ap.lat, lon: ap.lon }

// ── Ring buffer for ephemeral feeds ────────────────────────────────────────
const RING_CAP = Number(process.env.SWIM_EPHEMERAL_RING_CAP) || 500
const SNAPSHOT_CAP = Number(process.env.SWIM_SNAPSHOT_CAP) || 150 // max items sent per snapshot

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

const FLUSH_BATCH = Number(process.env.SWIM_FLUSH_BATCH) || 50
const FLUSH_INTERVAL = Number(process.env.SWIM_FLUSH_INTERVAL_MS) || 5000
let mainBackoffTicks = 0
let durableTrimTicker = 0
let lastDropLogAt = 0

const feedStats = {
  fns: { received: 0, processed: 0 },
  tfms: { received: 0, processed: 0 },
  sfdps: { received: 0, processed: 0 },
  itws: { received: 0, processed: 0 },
  stdds: { received: 0, processed: 0 },
}

const FNS_FLUSH_INTERVAL = Number(process.env.SWIM_FNS_FLUSH_INTERVAL_MS) || 30 * 60_000

// ── HTTP client for posting to main app ────────────────────────────────────
const mainApi = axios.create({
  baseURL: MAIN_APP_URL,
  timeout: MAIN_POST_TIMEOUT_MS,
  headers: INTERNAL_SECRET ? { Authorization: `Bearer ${INTERNAL_SECRET}` } : {},
})

async function postToMain(path, data) {
  const t0 = Date.now()
  try {
    await mainApi.post(path, data)
    const ms = Date.now() - t0
    if (ms > MAIN_SLOW_MS) {
      mainBackoffTicks = Math.min(MAX_BACKOFF_TICKS, mainBackoffTicks + 1)
      console.warn(`swim-service: POST ${path} slow (${ms}ms), backing off durable flushes`)
    } else if (mainBackoffTicks > 0) {
      mainBackoffTicks--
    }
    return true
  } catch (err) {
    console.error(`swim-service: POST ${path} failed:`, err.message)
    mainBackoffTicks = Math.min(MAX_BACKOFF_TICKS, mainBackoffTicks + 2)
    return false
  }
}

function compactLatest(buffer, keyFn) {
  const keyed = new Map()
  const unkeyed = []
  for (const item of buffer) {
    const key = keyFn(item)
    if (key) keyed.set(key, item)
    else unkeyed.push(item)
  }
  buffer.splice(0, buffer.length, ...unkeyed, ...keyed.values())
}

function dropOldest(buffer, max, label) {
  if (buffer.length <= max) return 0
  const dropped = buffer.splice(0, buffer.length - max).length
  const now = Date.now()
  if (now - lastDropLogAt > 10000) {
    lastDropLogAt = now
    console.warn(`swim-service: dropped ${dropped} old ${label} records under backpressure`)
  }
  return dropped
}

function trimDurableBuffers(force = false) {
  if (!force && ++durableTrimTicker % 50 !== 0) return
  compactLatest(fnsBuffer, b => b?.notam?.id)
  compactLatest(tfmsFlightBuffer, fp => fp?.acid)
  compactLatest(routeBuffer, r => r?.callsign && r?.origin_icao && r?.destination_icao
    ? `${r.callsign}|${r.origin_icao}|${r.destination_icao}`
    : null)

  const routeMax = mainBackoffTicks > 0 ? Math.max(FLUSH_BATCH, Math.floor(MAX_DURABLE_BUFFER / 4)) : MAX_DURABLE_BUFFER
  const flowMax = mainBackoffTicks > 0 ? Math.max(FLUSH_BATCH, Math.floor(MAX_DURABLE_BUFFER / 2)) : MAX_DURABLE_BUFFER
  dropOldest(routeBuffer, routeMax, 'route')
  dropOldest(tfmsFlowBuffer, flowMax, 'flow')
  dropOldest(tfmsFlightBuffer, MAX_DURABLE_BUFFER, 'flight-plan')
  dropOldest(fnsBuffer, MAX_DURABLE_BUFFER, 'NOTAM')
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
  trimDurableBuffers()
  feedStats.fns.processed++
}

async function flushFns() {
  if (fnsBuffer.length === 0) return
  compactLatest(fnsBuffer, b => b?.notam?.id)
  const batch = fnsBuffer.splice(0, FLUSH_BATCH)
  const ok = await postToMain('/internal/swim/notams', {
    notams: batch.map(b => b.notam),
    rawXmls: SEND_NOTAM_RAW_XML ? batch.map(b => b.xml) : undefined,
  })
  if (!ok) {
    fnsBuffer.unshift(...batch)
    trimDurableBuffers(true)
  }
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
  trimDurableBuffers()
  feedStats.tfms.processed++
}

async function flushTfms() {
  if (tfmsFlightBuffer.length > 0) {
    compactLatest(tfmsFlightBuffer, fp => fp?.acid)
    const batch = tfmsFlightBuffer.splice(0, FLUSH_BATCH)
    const ok = await postToMain('/internal/swim/flights', { plans: batch })
    if (!ok) {
      tfmsFlightBuffer.unshift(...batch)
      trimDurableBuffers(true)
    }
  }
  if (tfmsFlowBuffer.length > 0) {
    if (mainBackoffTicks > 0 && tfmsFlowBuffer.length > FLUSH_BATCH) {
      dropOldest(tfmsFlowBuffer, FLUSH_BATCH, 'flow')
    }
    const batch = tfmsFlowBuffer.splice(0, FLUSH_BATCH)
    await postToMain('/internal/swim/flow', { events: batch })
  }
  if (routeBuffer.length > 0) {
    compactLatest(routeBuffer, r => r?.callsign && r?.origin_icao && r?.destination_icao
      ? `${r.callsign}|${r.origin_icao}|${r.destination_icao}`
      : null)
    if (mainBackoffTicks > 0 && routeBuffer.length > FLUSH_BATCH) {
      dropOldest(routeBuffer, FLUSH_BATCH, 'route')
    }
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

function feedOptions(name) {
  const key = name.toUpperCase()
  return {
    sampleRate: Number(process.env[`SWIM_${key}_SAMPLE_RATE`]) || 1,
    maxQueueSize: Number(process.env[`SWIM_${key}_MAX_QUEUE`]) || undefined,
    processBatch: Number(process.env[`SWIM_${key}_PROCESS_BATCH`]) || undefined,
    processIntervalMs: Number(process.env[`SWIM_${key}_PROCESS_INTERVAL_MS`]) || undefined,
    windowSize: Number(process.env[`SWIM_${key}_WINDOW_SIZE`]) || undefined,
  }
}

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
      ...feedOptions(fc.name),
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

  // TFMS stays near-real-time; FNS/NOTAMs are lower urgency and can be batched.
  setInterval(async () => {
    await flushTfms()
  }, FLUSH_INTERVAL)
  setInterval(async () => {
    await flushFns()
  }, FNS_FLUSH_INTERVAL)

  // Send any startup burst promptly, then settle into the slower NOTAM cadence.
  setTimeout(() => { flushFns().catch(() => {}) }, FLUSH_INTERVAL)
}

// ═══════════════════════════════════════════════════════════════════════════
// Express server — serves ephemeral data + snapshot endpoint
// ═══════════════════════════════════════════════════════════════════════════

const app = express()

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

function requireWorkerAuth(req, res, next) {
  if (!WORKER_API_SECRET) return res.status(503).json({ error: 'worker api secret not configured' })
  const auth = req.headers.authorization || ''
  const token = auth.replace(/^Bearer\s+/i, '')
  if (token !== WORKER_API_SECRET) return res.status(401).json({ error: 'unauthorized' })
  next()
}

app.use('/api', requireWorkerAuth)

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
    durableBuffers: {
      notams: fnsBuffer.length,
      flightPlans: tfmsFlightBuffer.length,
      flow: tfmsFlowBuffer.length,
      routes: routeBuffer.length,
      backoffTicks: mainBackoffTicks,
    },
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
