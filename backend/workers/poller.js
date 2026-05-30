// ── Poller worker thread ───────────────────────────────────────────────────
// Entry point that runs the OpenSky poller + anomaly scoring + DB writes on
// a separate Node worker thread. Main thread talks to this via postMessage
// through backend/poller-host.js (the facade that preserves the original
// poller.js API for index.js callers).
//
// Why a worker thread and not just more yields?
// Even with chunking, the poller's sync DB writes (~500ms/cycle) + scoring
// iterations + enrichment all run on the main event loop. Stacked against
// HTTP request handlers that ALSO run sync SQL (SWR memoized endpoints
// still pay one sync compute per unique key on first hit), the loop stays
// wedge-prone. Isolating the poller to its own thread gives main's event
// loop back entirely for HTTP serving + SWIM ingest drain.
//
// DB access: worker opens its own better-sqlite3 connection (inside the
// db.js module it requires). WAL mode means concurrent readers + one
// writer across connections is safe. SQLite serializes writes at the file
// level via native mutex — that wait happens off the main thread.
//
// Logging: every message exchange is tagged `[poller-worker]` for visibility
// in Fly logs. Snapshot sizes are logged every N cycles to confirm the
// postMessage payload isn't growing unbounded.

'use strict'

const { parentPort, threadId } = require('worker_threads')

if (!parentPort) {
  throw new Error('poller-worker must be spawned via worker_threads, not required')
}

// Set the role BEFORE requiring db so its module-scope checks see it.
// db.js gates _purgeTimer on process.env.WORKER_ROLE — the worker must
// NOT run maintenance; that's main's job.
process.env.WORKER_ROLE = 'poller'

console.log(`[poller-worker] starting thread=${threadId} pid=${process.pid}`)

const poller = require('../poller')

// ── Relay anomaly events through to main ──────────────────────────────────
// index.js's /api/anomalies/stream SSE handler subscribes to poller-host's
// anomalyEvents. poller-host relays 'anomaly:*' messages from this worker
// into emits on its own EventEmitter, so existing SSE subscriptions work
// unchanged.
const RELAY_EVENTS = ['anomaly:new', 'anomaly:critical', 'anomaly:resolved']
let relayedCounts = { 'anomaly:new': 0, 'anomaly:critical': 0, 'anomaly:resolved': 0 }

for (const type of RELAY_EVENTS) {
  poller.anomalyEvents.on(type, (data) => {
    try {
      parentPort.postMessage({ type, data })
      relayedCounts[type]++
    } catch (err) {
      console.warn(`[poller-worker] relay ${type} failed:`, err.message)
    }
  })
}

// Log event relay rates every 60s so we can confirm flow.
setInterval(() => {
  const total = Object.values(relayedCounts).reduce((a, b) => a + b, 0)
  if (total > 0) {
    console.log(`[poller-worker] relayed events last 60s: new=${relayedCounts['anomaly:new']} critical=${relayedCounts['anomaly:critical']} resolved=${relayedCounts['anomaly:resolved']}`)
  }
  relayedCounts = { 'anomaly:new': 0, 'anomaly:critical': 0, 'anomaly:resolved': 0 }
}, 60_000).unref()

// ── Periodic snapshots to main ────────────────────────────────────────────
// Keys of in-memory state that main needs to serve HTTP requests.
// Main receives, stores locally, serves from that cached copy. No
// cross-thread synchronous calls — everything is eventually-consistent
// with a ~N-second lag.

let snapshotCounter = 0

// flights:snapshot — backs /api/flights.
// Cadence: 5s. getFlights() returns { flights[], fetchedAt, region, count,
// pollInterval }. With ~5000 flights serialized, postMessage copy is ~1–2 MB.
// Tolerable — GC pressure on main is the only cost.
setInterval(() => {
  try {
    const snap = poller.getFlights()
    parentPort.postMessage({ type: 'flights:snapshot', data: snap })
    snapshotCounter++
    if (snapshotCounter % 12 === 0) {
      // Once per minute, log the size so we catch drift early.
      console.log(`[poller-worker] flights snapshot: ${snap?.flights?.length ?? 0} flights`)
    }
  } catch (err) {
    console.warn('[poller-worker] flights snapshot failed:', err.message)
  }
}, 5_000).unref()

// status:snapshot — backs /api/poller/status and /api/health/ready.
// Cadence: 10s. Small payload (running, interval, counts).
setInterval(() => {
  try {
    const status = poller.getStatus()
    parentPort.postMessage({ type: 'status:snapshot', data: status })
  } catch (err) {
    console.warn('[poller-worker] status snapshot failed:', err.message)
  }
}, 10_000).unref()

// deviations:snapshot — backs /api/swim/routes/deviations.
// Cadence: 30s. Reads enrichCache + latestFlights to compute per-route
// deviations. Small payload — a few hundred rows max at minDevKm=0.
setInterval(() => {
  try {
    const devs = poller.getRouteDeviationsLive(0, 200)
    parentPort.postMessage({ type: 'deviations:snapshot', data: devs })
  } catch (err) {
    console.warn('[poller-worker] deviations snapshot failed:', err.message)
  }
}, 30_000).unref()

// ── Commands from main ────────────────────────────────────────────────────
parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return
  console.log(`[poller-worker] received command: ${msg.type}`)
  if (msg.type === 'stop') {
    try { poller.stop() } catch (_) {}
    process.exit(0)
  } else if (msg.type === 'start') {
    try { poller.start() } catch (err) {
      console.error('[poller-worker] start failed:', err.message)
    }
  }
})

// ── Meta + kick off ───────────────────────────────────────────────────────
// One-time meta post so main knows the active-key count without another RPC.
parentPort.postMessage({
  type: 'meta',
  data: { keyCount: poller.getActiveKeyCount() }
})

// Start polling. index.js's startup code also called poller.start() — now
// that call happens in the worker, not main.
poller.start()
console.log('[poller-worker] poller started')

// If the worker crashes, at least log the reason before dying.
process.on('uncaughtException', (err) => {
  console.error('[poller-worker] uncaughtException:', err.stack || err.message)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[poller-worker] unhandledRejection:', reason)
})
