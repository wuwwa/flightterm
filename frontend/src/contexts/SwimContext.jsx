import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const SwimContext = createContext(null)

// ── Tiered polling intervals ────────────────────────────────────────────────
// Fast:   real-time operational data that changes every few seconds
// Medium: data that updates on each SWIM message cycle (~15-30s)
// Slow:   structural/config data that rarely changes
const FAST   = 10_000  // 10s — flights, oooi, status
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

  // Fast tier (10s): flight positions, surface events, feed status
  const refreshFast = useCallback(async () => {
    if (!backendOk) return
    const results = await Promise.allSettled([
      axios.get('/api/swim/status'),
      axios.get('/api/swim/flights', { params: { limit: 200 } }),
      axios.get('/api/swim/oooi', { params: { limit: 30 } }),
    ])
    const val = (i) => results[i].status === 'fulfilled' ? results[i].value.data : null
    const arr = (i) => { const v = val(i); return Array.isArray(v) ? v : [] }
    if (val(0)) setStatus(val(0))
    setFlights(arr(1))
    setOooi(arr(2))
  }, [backendOk])

  // Medium tier (30s): flow events, weather, TFRs
  const refreshMedium = useCallback(async () => {
    if (!backendOk) return
    const results = await Promise.allSettled([
      axios.get('/api/swim/flow', { params: { limit: 50 } }),
      axios.get('/api/swim/weather', { params: { limit: 50 } }),
      axios.get('/api/swim/tfrs'),
    ])
    const arr = (i) => { const v = results[i].status === 'fulfilled' ? results[i].value.data : null; return Array.isArray(v) ? v : [] }
    setFlowEvents(arr(0))
    setWeather(arr(1))
    setTfrs(arr(2))
  }, [backendOk])

  // Slow tier (60s): airport configs, NOTAM airports
  const refreshSlow = useCallback(async () => {
    if (!backendOk) return
    const results = await Promise.allSettled([
      axios.get('/api/swim/airports'),
      axios.get('/api/swim/notams/airports', { params: { limit: 12 } }),
    ])
    const arr = (i) => { const v = results[i].status === 'fulfilled' ? results[i].value.data : null; return Array.isArray(v) ? v : [] }
    setAirportConfigs(arr(0))
    setNotamAirports(arr(1))
  }, [backendOk])

  useEffect(() => {
    if (!backendOk) return
    // Initial fetch — all tiers at once
    refreshFast()
    refreshMedium()
    refreshSlow()
    const fastId = setInterval(refreshFast, FAST)
    const medId = setInterval(refreshMedium, MEDIUM)
    const slowId = setInterval(refreshSlow, SLOW)
    return () => { clearInterval(fastId); clearInterval(medId); clearInterval(slowId) }
  }, [backendOk, refreshFast, refreshMedium, refreshSlow])

  return (
    <SwimContext.Provider value={{
      status,
      flowEvents,
      flights,
      airportConfigs,
      tfrs,
      notamAirports,
      weather,
      oooi,
    }}>
      {children}
    </SwimContext.Provider>
  )
}

export function useSwim() {
  const ctx = useContext(SwimContext)
  if (!ctx) throw new Error('useSwim must be used within SwimProvider')
  return ctx
}
