// ── SWIM Service Manager (HTTP Client) ──────────────────────────────────────
// Polls the separate swim worker service (flightterm-swim) for ephemeral data
// snapshots every 2 seconds. Durable data (FNS/TFMS) is written to SQLite by
// the worker via HTTP POST to this app's /internal/swim/* endpoints.
//
// This module exposes the same query API as before — API endpoints in index.js
// don't need to change. All get*() functions read from the local snapshot cache.

const axios = require('axios')
const db = require('../db')

const WORKER_URL = process.env.SWIM_WORKER_URL || 'http://flightterm-swim.internal:3002'
const POLL_INTERVAL = 5000

// ── Snapshot data (updated every 2s from worker) ───────────────────────────
let _sfdps = []
let _itws = []
let _stdds = []
let _consumerStats = {}
let _feedStats = {}
let _surfaceStats = { total: 0, surface: 0, departures: 0, tracon: 0, rvr: 0, oooi: 0, airports: 0 }
let _weatherStats = { total: 0, tornado: 0, windshear: 0, microburst: 0, gust_front: 0, precip: 0, hazard_text: 0, storm_motion: 0, critical: 0, sites: 0 }
let _connected = false
let _pollTimer = null

// ═══════════════════════════════════════════════════════════════════════════
// Polling
// ═══════════════════════════════════════════════════════════════════════════

let _positionPersistCount = 0

async function pollWorker() {
  try {
    const res = await axios.get(`${WORKER_URL}/api/snapshot`, { timeout: 15000 })
    _sfdps = res.data.sfdps || []
    _itws = res.data.itws || []
    _stdds = res.data.stdds || []
    _consumerStats = res.data.consumerStats || {}
    _feedStats = res.data.feedStats || {}
    _surfaceStats = res.data.surfaceStats || _surfaceStats
    _weatherStats = res.data.weatherStats || _weatherStats
    if (!_connected) {
      _connected = true
      console.log('swim: connected to worker service')
    }
    // Persist SFDPS positions + sector counts (every other poll = ~10s)
    if (_sfdps.length > 0 && ++_positionPersistCount % 2 === 0) {
      try { db.persistFlightPositions(_sfdps) } catch {}
      try { db.persistSectorCounts(_sfdps) } catch {}
    }
  } catch {
    if (_connected) {
      _connected = false
      console.warn('swim: worker service unreachable')
    }
  }
}

function startAll() {
  if (_pollTimer) return Promise.resolve({})
  console.log(`swim: polling worker at ${WORKER_URL}`)
  _pollTimer = setInterval(pollWorker, POLL_INTERVAL)
  pollWorker() // initial poll
  return Promise.resolve({})
}

function stopAll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
  _connected = false
  console.log('swim: polling stopped')
}

// ═══════════════════════════════════════════════════════════════════════════
// Status
// ═══════════════════════════════════════════════════════════════════════════

function getStatus() {
  const status = { feeds: {}, workerConnected: _connected }

  const feedNames = ['fns', 'tfms', 'sfdps', 'itws', 'stdds']
  for (const name of feedNames) {
    if (_consumerStats[name]) {
      status.feeds[name] = {
        ..._consumerStats[name],
        bufferDepth: name === 'sfdps' ? _sfdps.length : name === 'itws' ? _itws.length : name === 'stdds' ? _stdds.length : 0,
      }
    } else {
      const queueEnv = `SWIM_${name.toUpperCase()}_QUEUE`
      status.feeds[name] = { connected: false, enabled: !!(process.env.SWIM_USERNAME && process.env[queueEnv]) }
    }
  }

  try { status.notams = db.getNotamStats() } catch { status.notams = null }
  try { status.tfms = db.getTfmsStats() } catch { status.tfms = null }
  status.terminalWeather = _weatherStats
  status.surface = _surfaceStats

  return status
}

// ═══════════════════════════════════════════════════════════════════════════
// Query functions (serve from snapshot cache — synchronous)
// ═══════════════════════════════════════════════════════════════════════════

function getFlightPositions(limit = 500) {
  const result = []
  for (let i = _sfdps.length - 1; i >= 0 && result.length < limit; i--) {
    if (_sfdps[i].lat != null && _sfdps[i].lon != null) result.push(_sfdps[i])
  }
  return result
}

function getRecentTerminalWeather(limit = 20) {
  return _itws.slice(-limit).reverse()
}

function getTerminalWeatherByAirport(airport, limit = 10) {
  const result = []
  for (let i = _itws.length - 1; i >= 0 && result.length < limit; i--) {
    if (_itws[i].airport === airport || _itws[i].site === airport) result.push(_itws[i])
  }
  return result
}

function getTerminalWeatherStats() { return _weatherStats }

function getRecentSurfaceEvents(limit = 30) {
  return _stdds.slice(-limit).reverse()
}

function getSurfaceEventsByAirport(airport, limit = 20) {
  const result = []
  for (let i = _stdds.length - 1; i >= 0 && result.length < limit; i--) {
    if (_stdds[i].airport === airport) result.push(_stdds[i])
  }
  return result
}

function getSurfacePositions(limit = 300) {
  const result = []
  for (let i = _stdds.length - 1; i >= 0 && result.length < limit; i--) {
    const e = _stdds[i]
    if (e.lat != null && e.lon != null && (e.service === 'TAIS' || e.service === 'SMES')) result.push(e)
  }
  return result
}

function getOooi(limit = 30) {
  const oooi = ['SPOT_OUT', 'OFF', 'ON', 'SPOT_IN', 'DEPARTURE']
  const result = []
  for (let i = _stdds.length - 1; i >= 0 && result.length < limit; i--) {
    if (oooi.includes(_stdds[i].event_type)) result.push(_stdds[i])
  }
  return result
}

function getSurfaceStats() { return _surfaceStats }

// Stubs (worker lifecycle is managed by Fly.io, not by this module)
function startFns() {} function stopFns() {}
function startTfms() {} function stopTfms() {}
function startSfdps() {} function stopSfdps() {}
function startItws() {} function stopItws() {}
function startStdds() {} function stopStdds() {}

module.exports = {
  startAll,
  stopAll,
  startFns, stopFns,
  startTfms, stopTfms,
  startSfdps, stopSfdps,
  startItws, stopItws,
  startStdds, stopStdds,
  getStatus,
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
