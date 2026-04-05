// ── SWIM Service Manager ────────────────────────────────────────────────────
// Manages connections to FAA SWIM SCDS data feeds.
//   - AIM FNS: Federal NOTAM System (NOTAMs + TFRs)
//   - TFMS: Traffic Flow Management (flight plans + flow events)

const ScdsConsumer = require('./scds-consumer')
const { parseNotam } = require('./fns-parser')
const { parseFlightData, parseFlowData, classifyMessage } = require('./tfms-parser')
const { AIRPORTS } = require('../anomaly')
const db = require('../db')

// Build airport coordinate lookup from the AIRPORTS list (top 50 US airports)
const AIRPORT_COORDS = {}
for (const ap of AIRPORTS) AIRPORT_COORDS[ap.icao] = { lat: ap.lat, lon: ap.lon }

// ── FNS state ───────────────────────────────────────────────────────────────
let fnsConsumer = null
let fnsMessageBuffer = []
let fnsFlushTimer = null

// ── TFMS state ──────────────────────────────────────────────────────────────
let tfmsConsumer = null
let tfmsFlightBuffer = []
let tfmsFlowBuffer = []
let tfmsFlushTimer = null

const FLUSH_INTERVAL = 5000
const FLUSH_BATCH_SIZE = 50

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
  fnsMessageBuffer.push({ notam, xml: xml || null })
  if (fnsMessageBuffer.length >= FLUSH_BATCH_SIZE) flushFns()
}

function flushFns() {
  if (fnsMessageBuffer.length === 0) return
  const batch = fnsMessageBuffer.splice(0)
  try {
    const count = db.upsertNotamBatch(batch.map(b => b.notam), batch.map(b => b.xml))
    const tfrs = batch.filter(b => b.notam.isTfr).length
    if (tfrs > 0) console.log(`swim/FNS: stored ${count} NOTAMs (${tfrs} TFRs)`)
  } catch (err) {
    console.error('swim/FNS: batch store error:', err.message)
  }
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
  fnsConsumer = new ScdsConsumer(config, handleFnsMessage)
  try {
    await fnsConsumer.connect()
    fnsFlushTimer = setInterval(flushFns, FLUSH_INTERVAL)
    console.log('swim/FNS: consumer started — receiving NOTAMs')
    return true
  } catch (err) {
    console.error('swim/FNS: failed to start:', err.message)
    fnsConsumer = null
    return false
  }
}

function stopFns() {
  if (fnsFlushTimer) { clearInterval(fnsFlushTimer); fnsFlushTimer = null }
  flushFns()
  if (fnsConsumer) { fnsConsumer.disconnect(); fnsConsumer = null }
}

// ═══════════════════════════════════════════════════════════════════════════
// TFMS (Flight Plans + Flow Management)
// ═══════════════════════════════════════════════════════════════════════════

function handleTfmsMessage(xml, props) {
  const msgClass = classifyMessage(props)

  if (msgClass === 'flow') {
    const event = parseFlowData(xml, props)
    if (event) {
      tfmsFlowBuffer.push(event)
      if (tfmsFlowBuffer.length >= FLUSH_BATCH_SIZE) flushTfms()
    }
  } else {
    // parseFlightData returns an array (batched messages contain multiple flights)
    const flights = parseFlightData(xml, props)
    for (const fp of flights) {
      tfmsFlightBuffer.push(fp)
    }
    if (tfmsFlightBuffer.length >= FLUSH_BATCH_SIZE) flushTfms()
  }
}

function flushTfms() {
  // Flush flight plans + auto-populate callsign_routes
  if (tfmsFlightBuffer.length > 0) {
    const batch = tfmsFlightBuffer.splice(0)
    try {
      db.upsertFlightPlanBatch(batch)

      // Auto-populate callsign_routes from TFMS flight plans.
      // Only upsert if we have both origin and destination, and only if the
      // existing route isn't already from TFMS (avoid redundant writes).
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
      console.error('swim/TFMS: flight plan batch error:', err.message)
    }
  }

  // Flush flow events
  if (tfmsFlowBuffer.length > 0) {
    const batch = tfmsFlowBuffer.splice(0)
    try {
      for (const event of batch) db.insertFlowEvent(event)
      const types = [...new Set(batch.map(e => e.eventType).filter(Boolean))]
      if (types.length > 0) {
        console.log(`swim/TFMS: stored ${batch.length} flow events (${types.join(', ')})`)
      }
    } catch (err) {
      console.error('swim/TFMS: flow event batch error:', err.message)
    }
  }
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
  tfmsConsumer = new ScdsConsumer(config, handleTfmsMessage)
  try {
    await tfmsConsumer.connect()
    tfmsFlushTimer = setInterval(flushTfms, FLUSH_INTERVAL)
    console.log('swim/TFMS: consumer started — receiving flight plans + flow data')
    return true
  } catch (err) {
    console.error('swim/TFMS: failed to start:', err.message)
    tfmsConsumer = null
    return false
  }
}

function stopTfms() {
  if (tfmsFlushTimer) { clearInterval(tfmsFlushTimer); tfmsFlushTimer = null }
  flushTfms()
  if (tfmsConsumer) { tfmsConsumer.disconnect(); tfmsConsumer = null }
}

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

async function startAll() {
  const results = {}

  results.fns = await startFns().catch(err => {
    console.error('swim: FNS startup error:', err.message)
    return false
  })

  results.tfms = await startTfms().catch(err => {
    console.error('swim: TFMS startup error:', err.message)
    return false
  })

  const active = Object.entries(results).filter(([, v]) => v).map(([k]) => k)
  if (active.length > 0) {
    console.log(`swim: ${active.length} feed(s) active: ${active.join(', ')}`)
  } else {
    console.log('swim: no feeds configured (set SWIM_* env vars to enable)')
  }
  return results
}

function stopAll() {
  stopFns()
  stopTfms()
  console.log('swim: all feeds stopped')
}

function getStatus() {
  const status = { feeds: {} }

  // FNS
  if (fnsConsumer) {
    status.feeds.fns = fnsConsumer.getStats()
  } else {
    status.feeds.fns = { connected: false, enabled: !!(process.env.SWIM_USERNAME && process.env.SWIM_FNS_QUEUE) }
  }

  // TFMS
  if (tfmsConsumer) {
    status.feeds.tfms = tfmsConsumer.getStats()
  } else {
    status.feeds.tfms = { connected: false, enabled: !!(process.env.SWIM_USERNAME && process.env.SWIM_TFMS_QUEUE) }
  }

  // DB stats
  try { status.notams = db.getNotamStats() } catch { status.notams = null }
  try { status.tfms = db.getTfmsStats() } catch { status.tfms = null }

  return status
}

module.exports = {
  startAll,
  stopAll,
  startFns,
  stopFns,
  startTfms,
  stopTfms,
  getStatus,
}
