// ── Military-ICAO cache (v5.2.1) ───────────────────────────────────────────
// The OpenSky state vector has no `mil` field. The poller stores every flight
// with `mil: false`. To restore a useful military signal we periodically fetch
// the adsb.fi /mil list (currently-tracked military aircraft globally)
// and build a Set of hex codes. `isMil(icao)` answers in O(1).
//
// TTL 5 minutes. The provider rate-limits at 1 req/sec; 5-min cadence is comfortably
// under that even if multiple processes hit it.

const axios = require('axios')

const URL = `${process.env.ADSBFI_BASE || 'https://opendata.adsb.fi/api/v2'}/mil`
const TTL_MS = 5 * 60_000
let _cache = { t: 0, set: new Set(), size: 0 }
let _inFlight = null

async function refresh() {
  try {
    const res = await axios.get(URL, { timeout: 15_000 })
    const list = res.data?.aircraft || res.data?.ac || []
    const set = new Set()
    for (const a of list) {
      if (a.hex) set.add(a.hex.toLowerCase())
    }
    _cache = { t: Date.now(), set, size: set.size }
    return set
  } catch (err) {
    // Preserve previous cache on failure so the feed doesn't silently lose
    // the mil signal during transient outages.
    console.warn('milCache: refresh failed:', err.message)
    return _cache.set
  }
}

async function ensureFresh() {
  if (Date.now() - _cache.t < TTL_MS) return _cache.set
  if (_inFlight) return _inFlight
  _inFlight = refresh().finally(() => { _inFlight = null })
  return _inFlight
}

// Best-effort sync API. Returns whatever's cached right now and triggers a
// refresh in the background if stale. First call returns empty set; that's
// acceptable because the cache warms before the second poll (60s cadence).
function isMil(icao) {
  if (!icao) return false
  if (Date.now() - _cache.t > TTL_MS) {
    // Fire and forget; the in-flight guard prevents thundering herd.
    ensureFresh().catch(() => {})
  }
  return _cache.set.has(icao.toLowerCase())
}

function stats() {
  return { size: _cache.size, ageMs: Date.now() - _cache.t, stale: Date.now() - _cache.t > TTL_MS }
}

// Eager warm-up in the running service, but never perform network I/O merely
// because a test imported the feed module.
if (!process.env.VITEST) ensureFresh().catch(() => {})

module.exports = { isMil, ensureFresh, stats }
