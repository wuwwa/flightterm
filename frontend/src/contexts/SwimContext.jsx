import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'

const SwimContext = createContext(null)

// ── Tiered polling intervals ────────────────────────────────────────────────
// Fast:   real-time operational data that changes every few seconds
// Medium: data that updates on each SWIM message cycle (~15-30s)
// Slow:   structural/config data that rarely changes
const FAST   = 10_000  // 10s — flights, oooi, status, NAS summary
const MEDIUM = 30_000  // 30s — flow events, weather, TFRs
const SLOW   = 60_000  // 60s — airport configs, NOTAM airports

export function SwimProvider({ backendOk, children }) {
  const [status, setStatus] = useState(null)
  const [flowEvents, setFlowEvents] = useState([])
  const [flights, setFlights] = useState([])
  const [airportConfigs, setAirportConfigs] = useState([])
  const [tfrs, setTfrs] = useState([])
  const [notamAirports, setNotamAirports] = useState([])
  const [weather, setWeather] = useState([])
  const [oooi, setOooi] = useState([])
  const [nasSummary, setNasSummary] = useState(null)
  const [availability, setAvailability] = useState({ fastUpdatedAt: null, mediumUpdatedAt: null, slowUpdatedAt: null, fastError: null, mediumError: null, slowError: null })
  const [wakeState, setWakeState] = useState({ state: 'idle' })
  const wakeInFlightRef = useRef(null)
  const autoWakeAttemptedRef = useRef(false)

  // Fast tier (10s): flight positions, surface events, feed status, NAS health
  const refreshFast = useCallback(async () => {
    if (!backendOk) return
    const results = await Promise.allSettled([
      axios.get('/api/swim/status'),
      axios.get('/api/swim/flights', { params: { limit: 200 } }),
      axios.get('/api/swim/oooi', { params: { limit: 30 } }),
      axios.get('/api/swim/nas/analytics'),
    ])
    const val = (i) => results[i].status === 'fulfilled' ? results[i].value.data : null
    const arr = (i) => { const v = val(i); return Array.isArray(v) ? v : null }
    if (val(0)) setStatus(val(0))
    if (arr(1)) setFlights(arr(1))
    if (arr(2)) setOooi(arr(2))
    if (val(3)) setNasSummary(val(3))
    const failed = results.filter(result => result.status === 'rejected').length
    setAvailability(previous => ({ ...previous, fastUpdatedAt: failed < results.length ? Date.now() : previous.fastUpdatedAt, fastError: failed ? `${failed} live SWIM request${failed === 1 ? '' : 's'} failed` : null }))
  }, [backendOk])

  const wakeSwim = useCallback(async () => {
    if (!backendOk) return null
    if (status?.workerConnected) {
      setWakeState({ state: 'connected' })
      return { ok: true, state: 'connected' }
    }
    if (wakeInFlightRef.current) return wakeInFlightRef.current

    setWakeState({ state: 'starting' })
    wakeInFlightRef.current = axios.post('/api/swim/wake')
      .then((res) => {
        setWakeState(res.data || { state: 'starting' })
        setTimeout(refreshFast, 3000)
        return res.data
      })
      .catch((err) => {
        const data = err.response?.data
        setWakeState({ state: 'error', error: data?.error || err.message })
        throw err
      })
      .finally(() => {
        wakeInFlightRef.current = null
      })
    return wakeInFlightRef.current
  }, [backendOk, refreshFast, status?.workerConnected])

  // Medium tier (30s): flow events, weather, TFRs
  const refreshMedium = useCallback(async () => {
    if (!backendOk) return
    const results = await Promise.allSettled([
      axios.get('/api/swim/flow', { params: { limit: 50 } }),
      axios.get('/api/swim/weather', { params: { limit: 50 } }),
      axios.get('/api/swim/tfrs'),
    ])
    const arr = (i) => { const v = results[i].status === 'fulfilled' ? results[i].value.data : null; return Array.isArray(v) ? v : null }
    if (arr(0)) setFlowEvents(arr(0))
    if (arr(1)) setWeather(arr(1))
    if (arr(2)) setTfrs(arr(2))
    const failed = results.filter(result => result.status === 'rejected').length
    setAvailability(previous => ({ ...previous, mediumUpdatedAt: failed < results.length ? Date.now() : previous.mediumUpdatedAt, mediumError: failed ? `${failed} operational request${failed === 1 ? '' : 's'} failed` : null }))
  }, [backendOk])

  // Slow tier (60s): airport configs, NOTAM airports
  const refreshSlow = useCallback(async () => {
    if (!backendOk) return
    const results = await Promise.allSettled([
      axios.get('/api/swim/airports'),
      axios.get('/api/swim/notams/airports', { params: { limit: 30 } }),
    ])
    const arr = (i) => { const v = results[i].status === 'fulfilled' ? results[i].value.data : null; return Array.isArray(v) ? v : null }
    if (arr(0)) setAirportConfigs(arr(0))
    if (arr(1)) setNotamAirports(arr(1))
    const failed = results.filter(result => result.status === 'rejected').length
    setAvailability(previous => ({ ...previous, slowUpdatedAt: failed < results.length ? Date.now() : previous.slowUpdatedAt, slowError: failed ? `${failed} reference request${failed === 1 ? '' : 's'} failed` : null }))
  }, [backendOk])

  useEffect(() => {
    if (!backendOk) return
    refreshFast()
    refreshMedium()
    refreshSlow()
    const fastId = setInterval(refreshFast, FAST)
    const medId = setInterval(refreshMedium, MEDIUM)
    const slowId = setInterval(refreshSlow, SLOW)
    return () => { clearInterval(fastId); clearInterval(medId); clearInterval(slowId) }
  }, [backendOk, refreshFast, refreshMedium, refreshSlow])

  useEffect(() => {
    if (!backendOk || autoWakeAttemptedRef.current || status?.workerConnected) return
    autoWakeAttemptedRef.current = true
    wakeSwim().catch(() => {})
  }, [backendOk, status?.workerConnected, wakeSwim])

  // ── Derived warm-up state ────────────────────────────────────────────────
  // The SWIM worker scales to zero after idle and takes ~20-55s to wake and
  // connect its FAA feeds. Surface that progression so panels can show
  // "waking / connecting feeds (n/m)" instead of a silent empty/"not connected"
  // state that reads as broken.
  const warmup = deriveSwimWarmup(status, wakeState)

  return (
    <SwimContext.Provider value={{
      status, flowEvents, flights, airportConfigs, tfrs, notamAirports, weather, oooi, nasSummary, availability,
      wakeSwim, wakeState,
      // warm-up surface
      warming: warmup.phase !== 'live',
      warmupPhase: warmup.phase,
      feedsConnected: warmup.connected,
      feedsTotal: warmup.total,
      warmupLabel: warmup.label,
    }}>
      {children}
    </SwimContext.Provider>
  )
}

// Collapse /api/swim/status + the wake state machine into a simple warm-up
// descriptor. Tolerant of `feeds` being an object map (the real shape:
// { fns: { connected }, tfms: { connected }, ... }), an array, or absent while
// the worker is still coming up.
//
// phase: 'waking'     — wake requested / machine starting, no feeds yet
//        'connecting' — worker reachable but 0 feeds connected
//        'live'       — at least one feed connected (treat dashboard as ready)
function deriveSwimWarmup(status, wakeState) {
  const feeds = status?.feeds
  let total = 0
  let connected = 0
  if (feeds && typeof feeds === 'object') {
    const entries = Array.isArray(feeds) ? feeds : Object.values(feeds)
    total = entries.length
    connected = entries.filter(f => f && f.connected).length
  }

  if (connected > 0) {
    return { phase: 'live', connected, total, label: 'feeds live' }
  }

  const ws = wakeState?.state
  if (ws === 'starting' || ws === 'idle' || !status) {
    return { phase: 'waking', connected: 0, total: total || 5, label: 'waking swim' }
  }
  // Worker reachable (we have a status payload) but no feeds connected yet.
  const t = total || 5
  return { phase: 'connecting', connected: 0, total: t, label: 'linking feeds' }
}

export function useSwim() {
  const ctx = useContext(SwimContext)
  if (!ctx) throw new Error('useSwim must be used within SwimProvider')
  return ctx
}
