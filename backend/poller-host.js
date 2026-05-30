// ── Poller host (main-thread facade) ──────────────────────────────────────
// Drop-in replacement for the original in-process poller. The real poller
// runs in backend/workers/poller.js on a separate Node worker thread; this
// module receives snapshots + events via postMessage and surfaces them to
// the rest of index.js through the same API the old poller exported:
//
//   start()              — spawn the worker (or noop if already running)
//   stop()               — tell the worker to shut down
//   getFlights()         — latest flight snapshot (read-through cache)
//   getStatus()          — latest status snapshot
//   getActiveKeyCount()  — static meta reported once at boot
//   getRouteDeviationsLive(minDevKm, limit) — filters from cached snapshot
//   anomalyEvents        — EventEmitter that fires 'anomaly:new' etc. when
//                          the worker posts them
//
// index.js doesn't need any other changes — the import path is the only
// thing that moves. Anomaly SSE subscribers keep working because
// anomalyEvents.on('anomaly:new', …) resolves to this module's emitter,
// which relays every message the worker posts.

'use strict'

const path = require('path')
const { Worker } = require('worker_threads')
const { EventEmitter } = require('events')

const anomalyEvents = new EventEmitter()

// Cached snapshots — populated by worker postMessages. Initial values match
// what getFlights() / getStatus() returned before the worker existed so
// callers don't see undefined on first access.
let latestFlights = { flights: [], fetchedAt: null, region: process.env.POLL_REGION || 'usa', count: 0, pollInterval: 45_000 }
let latestStatus = { running: false, interval: 45_000, region: process.env.POLL_REGION || 'usa' }
let latestDeviations = []
let cachedKeyCount = 0

let worker = null
let desiredRunning = false
let restartTimer = null
let snapshotRxCount = 0

function spawnWorker() {
  const workerPath = path.join(__dirname, 'workers', 'poller.js')
  console.log(`[poller-host] spawning worker at ${workerPath}`)
  try {
    worker = new Worker(workerPath)
  } catch (err) {
    console.error('[poller-host] Worker() constructor failed:', err.message)
    worker = null
    scheduleRestart()
    return
  }
  console.log(`[poller-host] worker spawned threadId=${worker.threadId}`)

  worker.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'flights:snapshot':
        latestFlights = msg.data
        snapshotRxCount++
        if (snapshotRxCount % 12 === 0) {
          // Once per ~minute (5s cadence × 12) log that snapshots are flowing
          console.log(`[poller-host] received flights snapshot: ${msg.data?.flights?.length ?? 0} flights`)
        }
        break
      case 'status:snapshot':
        latestStatus = msg.data
        break
      case 'deviations:snapshot':
        latestDeviations = Array.isArray(msg.data) ? msg.data : []
        break
      case 'meta':
        if (typeof msg.data?.keyCount === 'number') {
          cachedKeyCount = msg.data.keyCount
          console.log(`[poller-host] meta: activeKeyCount=${cachedKeyCount}`)
        }
        break
      case 'anomaly:new':
      case 'anomaly:critical':
      case 'anomaly:resolved':
        // Pass-through to subscribers. SSE handler in index.js listens here.
        anomalyEvents.emit(msg.type, msg.data)
        break
      default:
        console.warn(`[poller-host] unknown message type: ${msg.type}`)
    }
  })

  worker.on('error', (err) => {
    console.error('[poller-host] worker error:', err.stack || err.message)
  })

  worker.on('exit', (code) => {
    console.warn(`[poller-host] worker exited code=${code} (desiredRunning=${desiredRunning})`)
    worker = null
    latestStatus = { ...latestStatus, running: false }
    if (desiredRunning) scheduleRestart()
  })
}

function scheduleRestart() {
  if (restartTimer) return
  const delay = 5_000
  console.warn(`[poller-host] scheduling worker restart in ${delay}ms`)
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (desiredRunning && !worker) {
      console.log('[poller-host] auto-restarting worker')
      spawnWorker()
    }
  }, delay)
  restartTimer.unref?.()
}

function start() {
  desiredRunning = true
  if (worker) {
    console.log('[poller-host] start(): worker already running')
    return
  }
  spawnWorker()
}

function stop() {
  desiredRunning = false
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
  if (!worker) return
  console.log('[poller-host] stop(): terminating worker')
  try { worker.postMessage({ type: 'stop' }) } catch (_) {}
  worker.terminate().then(() => {
    console.log('[poller-host] worker terminated')
  }).catch((err) => {
    console.warn('[poller-host] worker.terminate() rejected:', err.message)
  })
  worker = null
  latestStatus = { ...latestStatus, running: false }
}

function getFlights() { return latestFlights }
function getStatus() {
  // Overlay desiredRunning so callers see the intended state even in the
  // narrow window between worker.exit and respawn.
  return { ...latestStatus, running: desiredRunning && latestStatus.running }
}
function getActiveKeyCount() { return cachedKeyCount }

// Same signature as the original poller — filters the cached deviations
// snapshot. The worker posts unfiltered; we apply the user's thresholds here.
function getRouteDeviationsLive(minDevKm = 20, limit = 25) {
  return (latestDeviations || [])
    .filter((d) => (d?.deviation ?? 0) >= minDevKm)
    .slice(0, limit)
}

module.exports = {
  start,
  stop,
  getFlights,
  getStatus,
  getActiveKeyCount,
  getRouteDeviationsLive,
  anomalyEvents,
}
