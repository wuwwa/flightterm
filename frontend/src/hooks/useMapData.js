// ── useMapData (v5.7.4) ─────────────────────────────────────────────────────
// Single-source-of-truth fetcher for everything the NasMap layers consume.
// Previously each <NasMap> instance ran its own fetch effects; with 4–5
// instances mounted (mobile fallback + 4 quadrant panels) that meant
// ~50 simultaneous /api/* calls every 30 s, which choked the event loop
// and caused Fly's edge proxy to time out connecting to the instance
// (the "app crashed" the user saw).
//
// Now MapQuadrants calls this hook once and passes the result down to all
// NasMap instances as a `mapData` prop. NasMap skips its own fetches when
// that prop is provided.

import { useEffect, useState } from 'react'
import axios from 'axios'
import { fetchSigmets, fetchPireps } from '../services/weather'
import { fetchAnomalyFeed, fetchAnomalyHotspots, fetchFlightPositions, fetchSurfacePositions } from '../services/dashboard'
import { fetchMapContext } from '../services/contextMap'

const REFRESH_HEAVY_MS = 30_000   // weather/anomalies/positions/etc
const REFRESH_GEO_MS   = 5 * 60_000 // FIRMS/EONET/USGS — match server-side TTL

export function useMapData({ backendOk, geoLayers = {} }) {
  // Heavy operational data (always fetched while backend is up).
  const [sigmets, setSigmets] = useState([])
  const [pireps, setPireps] = useState([])
  const [tfrs, setTfrs] = useState([])
  const [anomalies, setAnomalies] = useState([])
  const [hotspots, setHotspots] = useState([])
  const [terminalWx, setTerminalWx] = useState([])
  const [routeDeviations, setRouteDeviations] = useState([])
  const [ifrPositions, setIfrPositions] = useState([])
  const [surfacePositions, setSurfacePositions] = useState([])
  const [weatherDelays, setWeatherDelays] = useState(null)
  const [sectorData, setSectorData] = useState([])

  // Correlation-layer (geo) data — fetched only when at least one of those
  // layers is currently turned on across any panel.
  const [fires, setFires] = useState([])
  const [eonetEvents, setEonetEvents] = useState([])
  const [quakes, setQuakes] = useState([])
  const [volcanoes, setVolcanoes] = useState([])
  const [webcams, setWebcams] = useState([])
  const [ctxError, setCtxError] = useState(null)

  // Heavy fetch — runs once on a 30 s interval. Uses Promise.allSettled so
  // a single slow upstream doesn't tank the whole batch.
  useEffect(() => {
    if (!backendOk) return
    let cancelled = false
    const refresh = () => {
      Promise.allSettled([
        fetchSigmets(),
        fetchPireps(24, -125, 50, -66, { age: 2 }),
        axios.get('/api/swim/tfrs').then(r => r.data),
        fetchAnomalyFeed(100),
        fetchAnomalyHotspots(24, 2),
        axios.get('/api/swim/weather', { params: { limit: 200 } }).then(r => r.data),
        axios.get('/api/swim/routes/deviations', { params: { limit: 25 } }).then(r => r.data),
        fetchFlightPositions(1000),
        fetchSurfacePositions(500),
        axios.get('/api/swim/weather-delays').then(r => r.data).catch(() => null),
        axios.get('/api/swim/sectors').then(r => r.data).catch(() => []),
      ]).then(results => {
        if (cancelled) return
        const val = (i) => results[i].status === 'fulfilled' ? results[i].value : []
        setSigmets(val(0) || [])
        setPireps(val(1) || [])
        setTfrs(val(2) || [])
        setAnomalies(val(3) || [])
        setHotspots(val(4) || [])
        setTerminalWx(val(5) || [])
        setRouteDeviations(val(6) || [])
        setIfrPositions(val(7) || [])
        setSurfacePositions(val(8) || [])
        setWeatherDelays(val(9) || null)
        setSectorData(val(10) || [])
      })
    }
    refresh()
    const id = setInterval(refresh, REFRESH_HEAVY_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

  // Correlation/geo fetch — only runs when at least one geo layer is enabled
  // somewhere in the UI. Slower cadence (5 min) because FIRMS/USGS rate limits.
  // Stable dep on the active set: join into a string so the effect doesn't
  // re-fire on referentially-different but content-identical objects.
  const activeGeo = ['fires', 'events', 'quakes', 'volcanoes', 'webcams']
    .filter(k => geoLayers[k])
  const activeGeoKey = activeGeo.join(',')

  useEffect(() => {
    if (!backendOk || activeGeo.length === 0) return
    let cancelled = false
    const refresh = async () => {
      try {
        const data = await fetchMapContext({ layers: activeGeo })
        if (cancelled) return
        setCtxError(null)
        if (geoLayers.fires)     setFires(data.fires?.fires || [])
        if (geoLayers.events)    setEonetEvents(data.events?.events || [])
        if (geoLayers.quakes)    setQuakes(data.quakes?.quakes || [])
        if (geoLayers.volcanoes) setVolcanoes(data.volcanoes?.alerts || [])
        if (geoLayers.webcams)   setWebcams((data.webcams?.webcams || []).filter(c => c.status === 'Active'))
      } catch (err) {
        if (!cancelled) setCtxError(err.response?.data?.error || err.message)
      }
    }
    refresh()
    const id = setInterval(refresh, REFRESH_GEO_MS)
    return () => { cancelled = true; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendOk, activeGeoKey])

  return {
    sigmets, pireps, tfrs, anomalies, hotspots, terminalWx, routeDeviations,
    ifrPositions, surfacePositions, weatherDelays, sectorData,
    fires, eonetEvents, quakes, volcanoes, webcams, ctxError,
  }
}
