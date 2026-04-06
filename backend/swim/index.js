// ── SWIM Service Manager ────────────────────────────────────────────────────
// Manages connections to FAA SWIM SCDS data feeds.
//   - AIM FNS: Federal NOTAM System (NOTAMs + TFRs)
//   - TFMS: Traffic Flow Management (flight plans + flow events)
//   - SFDPS: En route flight data from 20 ARTCCs
//   - ITWS: Terminal weather (windshear, microbursts, storm cells, lightning)
//   - STDDS: Surface movement, departures, terminal radar
//
// Flow control: each feed has a write buffer. When a buffer exceeds
// PAUSE_THRESHOLD, the Solace consumer is paused (messages stay in the broker
// queue). When the buffer drains below RESUME_THRESHOLD, the consumer resumes.
// Flushes are capped at FLUSH_BATCH items per tick to keep SQLite transactions
// short and avoid starving the event loop.

const ScdsConsumer = require('./scds-consumer')
const { parseNotam } = require('./fns-parser')
const { parseFlightData, parseFlowData, classifyMessage } = require('./tfms-parser')
const { parseSfdpsMessage } = require('./sfdps-parser')
const { parseItwsMessage } = require('./itws-parser')
const { parseStddsMessage } = require('./stdds-parser')
const { AIRPORTS } = require('../anomaly')
const db = require('../db')

// Build airport coordinate lookup from the AIRPORTS list (top 50 US airports)
const AIRPORT_COORDS = {}
for (const ap of AIRPORTS) AIRPORT_COORDS[ap.icao] = { lat: ap.lat, lon: ap.lon }

// ── Tuning constants ───────────────────────────────────────────────────────
const FLUSH_INTERVAL = 5000   // ms between coordinated flush cycles
const FLUSH_BATCH = 50        // max items per synchronous DB transaction (~100-200ms)
const PAUSE_THRESHOLD = 500   // pause consumer when buffer exceeds this
const RESUME_THRESHOLD = 100  // resume consumer when buffer drains below this

// ── Per-feed state ─────────────────────────────────────────────────────────
const feeds = {
  fns:   { consumer: null, buffer: [] },
  tfms:  { consumer: null, flightBuffer: [], flowBuffer: [] },
  sfdps: { consumer: null, buffer: [] },
  itws:  { consumer: null, buffer: [] },
  stdds: { consumer: null, buffer: [] },
}
let _flushTimer = null // single coordinated flush timer

// ── Buffer management ──────────────────────────────────────────────────────
// Check if a feed's consumer should be paused/resumed based on buffer depth.

function checkBackpressure(feedName, bufferLen) {
  const feed = feeds[feedName]
  if (!feed.consumer) return
  if (bufferLen >= PAUSE_THRESHOLD) {
    feed.consumer.pause()
  } else if (bufferLen <= RESUME_THRESHOLD) {
    feed.consumer.resume()
  }
}

// Helper: get total buffer depth for a feed (TFMS has two buffers)
function bufferDepth(feedName) {
  const feed = feeds[feedName]
  if (feedName === 'tfms') return feed.flightBuffer.length + feed.flowBuffer.length
  return feed.buffer.length
}

// ── Coordinated flush loop ─────────────────────────────────────────────────
// Single timer flushes one feed at a time with setImmediate yields between
// each feed, preventing all 5 feeds from blocking the event loop together.

const _flushFns = [] // registered by each startXxx() function

function startFlushLoop() {
  if (_flushTimer) return
  _flushTimer = setInterval(runFlushCycle, FLUSH_INTERVAL)
}

function stopFlushLoop() {
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null }
}

function runFlushCycle() {
  // Process flush functions one at a time, yielding between each
  let i = 0
  function next() {
    if (i >= _flushFns.length) return
    const fn = _flushFns[i++]
    fn()
    // Yield to event loop before next feed's flush
    if (i < _flushFns.length) setImmediate(next)
  }
  next()
}

// ═══════════════════════════════════════════════════════════════════════════
// FNS (NOTAMs)
// ═══════════════════════════════════════════════════════════════════════════

function handleFnsMessage(xml, props) {
  let notam = null

  if (xml && xml.length > 10) {
    notam = parseNotam(xml)
  }

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
        expiration: null,
        permanent: false,
        text: `${p('NOTAMStatus') || ''}: ${p('NOTAMKeyword') || ''} at ${p('ICAOId') || p('LocationDesignator') || '?'}`.trim(),
        fullText: null, lat: null, lon: null,
        altitudeLower: null, altitudeUpper: null, geometry: null,
        source: 'FNS', receivedAt: new Date().toISOString(),
      }
    }
  }

  if (!notam) return
  feeds.fns.buffer.push({ notam, xml: xml || null })
  checkBackpressure('fns', feeds.fns.buffer.length)
}

function flushFns() {
  const buf = feeds.fns.buffer
  if (buf.length === 0) return
  const batch = buf.splice(0, FLUSH_BATCH)
  try {
    const count = db.upsertNotamBatch(batch.map(b => b.notam), batch.map(b => b.xml))
    const tfrs = batch.filter(b => b.notam.isTfr).length
    if (tfrs > 0) console.log(`swim/FNS: stored ${count} NOTAMs (${tfrs} TFRs)`)
  } catch (err) {
    console.error('swim/FNS: batch store error:', err.message)
  }
  checkBackpressure('fns', buf.length)
  // If buffer still has items, schedule another flush on next tick
  if (buf.length > 0) setImmediate(flushFns)
}

async function startFns() {
  const config = {
    name: 'FNS',
    url: process.env.SWIM_FNS_URL || 'tcps://ems2.swim.faa.gov:55443',
    vpn: process.env.SWIM_FNS_VPN || 'AIM_FNS',
    username: process.env.SWIM_USERNAME,
    password: process.env.SWIM_PASSWORD,
    queue: process.env.SWIM_FNS_QUEUE,
  }
  if (!config.username || !config.password || !config.queue) {
    console.log('swim/FNS: disabled (set SWIM_FNS_QUEUE in .env)')
    return false
  }
  feeds.fns.consumer = new ScdsConsumer(config, handleFnsMessage)
  try {
    await feeds.fns.consumer.connect()
    _flushFns.push(flushFns)
    console.log('swim/FNS: consumer started — receiving NOTAMs')
    return true
  } catch (err) {
    console.error('swim/FNS: failed to start:', err.message)
    feeds.fns.consumer = null
    return false
  }
}

function stopFns() {
  flushFns()
  if (feeds.fns.consumer) { feeds.fns.consumer.disconnect(); feeds.fns.consumer = null }
}

// ═══════════════════════════════════════════════════════════════════════════
// TFMS (Flight Plans + Flow Management)
// ═══════════════════════════════════════════════════════════════════════════

function handleTfmsMessage(xml, props) {
  const msgClass = classifyMessage(props)

  if (msgClass === 'flow') {
    const event = parseFlowData(xml, props)
    if (event) feeds.tfms.flowBuffer.push(event)
  } else {
    const flights = parseFlightData(xml, props)
    for (const fp of flights) feeds.tfms.flightBuffer.push(fp)
  }
  checkBackpressure('tfms', bufferDepth('tfms'))
}

function flushTfmsFlights() {
  const buf = feeds.tfms.flightBuffer
  if (buf.length === 0) return
  const batch = buf.splice(0, FLUSH_BATCH)
  try {
    db.upsertFlightPlanBatch(batch)
  } catch (err) {
    console.error('swim/TFMS: flight plan batch error:', err.message)
  }
  // Yield, then do routes on next tick
  setImmediate(() => {
    try {
      const routes = []
      for (const fp of batch) {
        if (!fp.acid || !fp.depArpt || !fp.arrArpt) continue
        const orig = AIRPORT_COORDS[fp.depArpt]
        const dest = AIRPORT_COORDS[fp.arrArpt]
        routes.push({
          callsign: fp.acid,
          origin_icao: fp.depArpt,
          origin_lat: orig?.lat ?? null,
          origin_lon: orig?.lon ?? null,
          destination_icao: fp.arrArpt,
          destination_lat: dest?.lat ?? null,
          destination_lon: dest?.lon ?? null,
          source: 'tfms',
        })
      }
      if (routes.length > 0) db.upsertRoutesBatch(routes)
    } catch (err) {
      console.error('swim/TFMS: route batch error:', err.message)
    }
    checkBackpressure('tfms', bufferDepth('tfms'))
    if (buf.length > 0) setImmediate(flushTfmsFlights)
  })
}

function flushTfmsFlow() {
  const buf = feeds.tfms.flowBuffer
  if (buf.length === 0) return
  const batch = buf.splice(0, FLUSH_BATCH)
  try {
    const insertBatch = db.db.transaction((events) => {
      for (const event of events) db.insertFlowEvent(event)
    })
    insertBatch(batch)
  } catch (err) {
    console.error('swim/TFMS: flow event batch error:', err.message)
  }
  checkBackpressure('tfms', bufferDepth('tfms'))
  if (buf.length > 0) setImmediate(flushTfmsFlow)
}

function flushTfms() {
  flushTfmsFlights()
  // Yield between flight plans and flow events
  setImmediate(flushTfmsFlow)
}

async function startTfms() {
  const config = {
    name: 'TFMS',
    url: process.env.SWIM_TFMS_URL || 'tcps://ems2.swim.faa.gov:55443',
    vpn: process.env.SWIM_TFMS_VPN || 'TFMS',
    username: process.env.SWIM_USERNAME,
    password: process.env.SWIM_PASSWORD,
    queue: process.env.SWIM_TFMS_QUEUE,
  }
  if (!config.username || !config.password || !config.queue) {
    console.log('swim/TFMS: disabled (set SWIM_TFMS_QUEUE in .env)')
    return false
  }
  feeds.tfms.consumer = new ScdsConsumer(config, handleTfmsMessage)
  try {
    await feeds.tfms.consumer.connect()
    _flushFns.push(flushTfms)
    console.log('swim/TFMS: consumer started — receiving flight plans + flow data')
    return true
  } catch (err) {
    console.error('swim/TFMS: failed to start:', err.message)
    feeds.tfms.consumer = null
    return false
  }
}

function stopTfms() {
  flushTfms()
  if (feeds.tfms.consumer) { feeds.tfms.consumer.disconnect(); feeds.tfms.consumer = null }
}

// ═══════════════════════════════════════════════════════════════════════════
// SFDPS (En Route Track Data from 20 ARTCCs) — IN-MEMORY ONLY
// ═══════════════════════════════════════════════════════════════════════════
// SFDPS data is ephemeral position updates. Kept in a capped ring buffer
// and served directly from memory. No SQLite writes.

const RING_CAP = 2000 // max items per ring buffer

function ringPush(arr, item) {
  arr.push(item)
  if (arr.length > RING_CAP) arr.splice(0, arr.length - RING_CAP)
}

// Convert camelCase parser output to snake_case (matches DB column names that frontend expects)
function toSnake(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/[A-Z]/g, m => '_' + m.toLowerCase())] = v
  }
  return out
}

function handleSfdpsMessage(xml, props) {
  const tracks = parseSfdpsMessage(xml, props)
  const now = new Date().toISOString()
  for (const t of tracks) {
    const row = toSnake(t)
    row.received_at = now
    ringPush(feeds.sfdps.buffer, row)
  }
}

async function startSfdps() {
  const config = {
    name: 'SFDPS',
    url: process.env.SWIM_SFDPS_URL || 'tcps://ems2.swim.faa.gov:55443',
    vpn: process.env.SWIM_SFDPS_VPN || 'SFDPS',
    username: process.env.SWIM_USERNAME,
    password: process.env.SWIM_PASSWORD,
    queue: process.env.SWIM_SFDPS_QUEUE,
  }
  if (!config.username || !config.password || !config.queue) {
    console.log('swim/SFDPS: disabled (set SWIM_SFDPS_QUEUE in .env)')
    return false
  }
  feeds.sfdps.consumer = new ScdsConsumer(config, handleSfdpsMessage)
  try {
    await feeds.sfdps.consumer.connect()
    // No flush registration — data stays in memory
    console.log('swim/SFDPS: consumer started — receiving en route tracks')
    return true
  } catch (err) {
    console.error('swim/SFDPS: failed to start:', err.message)
    feeds.sfdps.consumer = null
    return false
  }
}

function stopSfdps() {
  if (feeds.sfdps.consumer) { feeds.sfdps.consumer.disconnect(); feeds.sfdps.consumer = null }
}

// ═══════════════════════════════════════════════════════════════════════════
// ITWS (Terminal Weather) — IN-MEMORY ONLY
// ═══════════════════════════════════════════════════════════════════════════

function handleItwsMessage(xml, props) {
  const event = parseItwsMessage(xml, props)
  if (event) {
    const row = toSnake(event)
    row.received_at = new Date().toISOString()
    ringPush(feeds.itws.buffer, row)
  }
}

async function startItws() {
  const config = {
    name: 'ITWS',
    url: process.env.SWIM_ITWS_URL || 'tcps://ems2.swim.faa.gov:55443',
    vpn: process.env.SWIM_ITWS_VPN || 'ITWS',
    username: process.env.SWIM_USERNAME,
    password: process.env.SWIM_PASSWORD,
    queue: process.env.SWIM_ITWS_QUEUE,
  }
  if (!config.username || !config.password || !config.queue) {
    console.log('swim/ITWS: disabled (set SWIM_ITWS_QUEUE in .env)')
    return false
  }
  feeds.itws.consumer = new ScdsConsumer(config, handleItwsMessage)
  try {
    await feeds.itws.consumer.connect()
    console.log('swim/ITWS: consumer started — receiving terminal weather')
    return true
  } catch (err) {
    console.error('swim/ITWS: failed to start:', err.message)
    feeds.itws.consumer = null
    return false
  }
}

function stopItws() {
  if (feeds.itws.consumer) { feeds.itws.consumer.disconnect(); feeds.itws.consumer = null }
}

// ═══════════════════════════════════════════════════════════════════════════
// STDDS (Surface Movement, Departures, Terminal Radar, RVR) — IN-MEMORY ONLY
// ═══════════════════════════════════════════════════════════════════════════

function handleStddsMessage(xml, props) {
  const event = parseStddsMessage(xml, props)
  if (event) {
    const row = toSnake(event)
    row.received_at = new Date().toISOString()
    ringPush(feeds.stdds.buffer, row)
  }
}

async function startStdds() {
  const config = {
    name: 'STDDS',
    url: process.env.SWIM_STDDS_URL || 'tcps://ems2.swim.faa.gov:55443',
    vpn: process.env.SWIM_STDDS_VPN || 'STDDS',
    username: process.env.SWIM_USERNAME,
    password: process.env.SWIM_PASSWORD,
    queue: process.env.SWIM_STDDS_QUEUE,
  }
  if (!config.username || !config.password || !config.queue) {
    console.log('swim/STDDS: disabled (set SWIM_STDDS_QUEUE in .env)')
    return false
  }
  feeds.stdds.consumer = new ScdsConsumer(config, handleStddsMessage)
  try {
    await feeds.stdds.consumer.connect()
    console.log('swim/STDDS: consumer started — receiving surface/terminal data')
    return true
  } catch (err) {
    console.error('swim/STDDS: failed to start:', err.message)
    feeds.stdds.consumer = null
    return false
  }
}

function stopStdds() {
  flushStdds()
  if (feeds.stdds.consumer) { feeds.stdds.consumer.disconnect(); feeds.stdds.consumer = null }
}

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

const delay = (ms) => new Promise(r => setTimeout(r, ms))

async function startAll() {
  const results = {}

  results.fns = await startFns().catch(err => {
    console.error('swim: FNS startup error:', err.message)
    return false
  })

  await delay(2000)

  results.tfms = await startTfms().catch(err => {
    console.error('swim: TFMS startup error:', err.message)
    return false
  })

  await delay(2000)

  results.sfdps = await startSfdps().catch(err => {
    console.error('swim: SFDPS startup error:', err.message)
    return false
  })

  await delay(2000)

  results.itws = await startItws().catch(err => {
    console.error('swim: ITWS startup error:', err.message)
    return false
  })

  await delay(2000)

  results.stdds = await startStdds().catch(err => {
    console.error('swim: STDDS startup error:', err.message)
    return false
  })

  const active = Object.entries(results).filter(([, v]) => v).map(([k]) => k)
  if (active.length > 0) {
    startFlushLoop()
    console.log(`swim: ${active.length} feed(s) active: ${active.join(', ')}`)
  } else {
    console.log('swim: no feeds configured (set SWIM_* env vars to enable)')
  }
  return results
}

function stopAll() {
  stopFlushLoop()
  stopFns()
  stopTfms()
  stopSfdps()
  stopItws()
  stopStdds()
  console.log('swim: all feeds stopped')
}

function getStatus() {
  const status = { feeds: {} }

  for (const [name, feed] of Object.entries(feeds)) {
    if (feed.consumer) {
      status.feeds[name] = {
        ...feed.consumer.getStats(),
        bufferDepth: bufferDepth(name),
      }
    } else {
      const queueEnv = `SWIM_${name.toUpperCase()}_QUEUE`
      status.feeds[name] = { connected: false, enabled: !!(process.env.SWIM_USERNAME && process.env[queueEnv]) }
    }
  }

  try { status.notams = db.getNotamStats() } catch { status.notams = null }
  try { status.tfms = db.getTfmsStats() } catch { status.tfms = null }
  status.terminalWeather = getTerminalWeatherStats()
  status.surface = getSurfaceStats()

  return status
}

// ═══════════════════════════════════════════════════════════════════════════
// In-memory query functions (replace DB queries for ephemeral feeds)
// ═══════════════════════════════════════════════════════════════════════════

// SFDPS — flight positions with lat/lon (for map)
function getFlightPositions(limit = 500) {
  const buf = feeds.sfdps.buffer
  const result = []
  for (let i = buf.length - 1; i >= 0 && result.length < limit; i--) {
    const t = buf[i]
    if (t.lat != null && t.lon != null) result.push(t)
  }
  return result
}

// ITWS — recent terminal weather
function getRecentTerminalWeather(limit = 20) {
  return feeds.itws.buffer.slice(-limit).reverse()
}

// ITWS — weather by airport
function getTerminalWeatherByAirport(airport, limit = 10) {
  const result = []
  const buf = feeds.itws.buffer
  for (let i = buf.length - 1; i >= 0 && result.length < limit; i--) {
    if (buf[i].airport === airport || buf[i].site === airport) result.push(buf[i])
  }
  return result
}

function getTerminalWeatherStats() {
  const buf = feeds.itws.buffer
  const stats = { total: buf.length, tornado: 0, windshear: 0, microburst: 0, gust_front: 0, precip: 0, hazard_text: 0, storm_motion: 0, critical: 0, sites: 0 }
  const siteSet = new Set()
  for (const e of buf) {
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

// STDDS — recent surface events
function getRecentSurfaceEvents(limit = 30) {
  return feeds.stdds.buffer.slice(-limit).reverse()
}

// STDDS — surface events by airport
function getSurfaceEventsByAirport(airport, limit = 20) {
  const result = []
  const buf = feeds.stdds.buffer
  for (let i = buf.length - 1; i >= 0 && result.length < limit; i--) {
    if (buf[i].airport === airport) result.push(buf[i])
  }
  return result
}

// STDDS — surface positions with lat/lon (for map)
function getSurfacePositions(limit = 300) {
  const result = []
  const buf = feeds.stdds.buffer
  for (let i = buf.length - 1; i >= 0 && result.length < limit; i--) {
    const e = buf[i]
    if (e.lat != null && e.lon != null && (e.service === 'TAIS' || e.service === 'SMES')) result.push(e)
  }
  return result
}

// STDDS — OOOI events
function getOooi(limit = 30) {
  const oooi = ['SPOT_OUT', 'OFF', 'ON', 'SPOT_IN', 'DEPARTURE']
  const result = []
  const buf = feeds.stdds.buffer
  for (let i = buf.length - 1; i >= 0 && result.length < limit; i--) {
    if (oooi.includes(buf[i].event_type)) result.push(buf[i])
  }
  return result
}

function getSurfaceStats() {
  const buf = feeds.stdds.buffer
  const stats = { total: buf.length, surface: 0, departures: 0, tracon: 0, rvr: 0, oooi: 0, airports: 0 }
  const apSet = new Set()
  const ooois = ['SPOT_OUT', 'OFF', 'ON', 'SPOT_IN']
  for (const e of buf) {
    const svc = e.service || ''
    if (svc === 'SMES') stats.surface++
    else if (svc === 'TDES') stats.departures++
    else if (svc === 'TAIS') stats.tracon++
    else if (svc === 'APDS') stats.rvr++
    if (ooois.includes(e.event_type)) stats.oooi++
    if (e.airport) apSet.add(e.airport)
  }
  stats.airports = apSet.size
  return stats
}

module.exports = {
  startAll,
  stopAll,
  startFns, stopFns,
  startTfms, stopTfms,
  startSfdps, stopSfdps,
  startItws, stopItws,
  startStdds, stopStdds,
  getStatus,
  // In-memory query functions (SFDPS/ITWS/STDDS)
  getFlightPositions,
  getRecentTerminalWeather,
  getTerminalWeatherByAirport,
  getTerminalWeatherStats,
  getRecentSurfaceEvents,
  getSurfaceEventsByAirport,
  getSurfacePositions,
  getOooi,
  getSurfaceStats,
}
