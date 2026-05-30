import React, { useState, useEffect, useMemo, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Polyline, Polygon, Marker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'
import AIRPORTS from '../../data/airports'
import axios from 'axios'
import { fetchSigmets, fetchPireps } from '../../services/weather'
import { fetchAnomalyFeed, fetchAnomalyHotspots, fetchFlightPositions, fetchSurfacePositions } from '../../services/dashboard'
import { fetchMapContext } from '../../services/contextMap'

// ── Correlation-layer icons (v5.1.0) ────────────────────────────────────────

// FIRMS fire pixel — small orange dot scaled by Fire Radiative Power (FRP).
function fireIcon(frp) {
  const s = frp > 20 ? 10 : frp > 5 ? 8 : 6
  return L.divIcon({
    html: `<svg width="${s}" height="${s}" viewBox="0 0 10 10">
      <circle cx="5" cy="5" r="4" fill="#ff6600" fill-opacity="0.85" stroke="#0d0d0d" stroke-width="0.5"/>
    </svg>`,
    className: '', iconSize: [s, s], iconAnchor: [s / 2, s / 2],
  })
}

// EONET event — hexagon with category-colored fill.
function eonetIcon(categories = []) {
  const c = categories.includes('wildfires')       ? '#ff6600'
          : categories.includes('severeStorms')    ? '#cc6666'
          : categories.includes('volcanoes')       ? '#a3685a'
          : categories.includes('seaLakeIce')      ? '#8abeb7'
          : categories.includes('earthquakes')     ? '#b294bb'
          : '#888'
  return L.divIcon({
    html: `<svg width="12" height="14" viewBox="0 0 12 14">
      <polygon points="6,1 11,4 11,10 6,13 1,10 1,4" fill="${c}" fill-opacity="0.85" stroke="#0d0d0d" stroke-width="1"/>
    </svg>`,
    className: '', iconSize: [12, 14], iconAnchor: [6, 7],
  })
}

// USGS earthquake — radius scaled by magnitude; red for M5+, purple else.
function quakeIcon(mag) {
  const s = mag >= 6 ? 18 : mag >= 5 ? 15 : mag >= 4 ? 12 : mag >= 3 ? 9 : 7
  const c = mag >= 5 ? '#cc6666' : '#b294bb'
  return L.divIcon({
    html: `<svg width="${s}" height="${s}" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="4" fill="${c}" fill-opacity="0.9"/>
      <circle cx="10" cy="10" r="7" fill="none" stroke="${c}" stroke-width="1" stroke-opacity="0.5"/>
      <circle cx="10" cy="10" r="9" fill="none" stroke="${c}" stroke-width="0.6" stroke-opacity="0.3"/>
    </svg>`,
    className: '', iconSize: [s, s], iconAnchor: [s / 2, s / 2],
  })
}

// USGS volcano — triangle tinted by HANS color code.
function volcanoIcon(colorCode) {
  const c = colorCode === 'RED'    ? '#ff3333'
          : colorCode === 'ORANGE' ? '#ff8833'
          : colorCode === 'YELLOW' ? '#f0c674'
          : '#888'
  return L.divIcon({
    html: `<svg width="16" height="14" viewBox="0 0 16 14">
      <path d="M8 1 L15 13 L1 13 Z" fill="${c}" fill-opacity="0.9" stroke="#0d0d0d" stroke-width="1" stroke-linejoin="round"/>
      <path d="M6 9 L7 6 L9 7 L10 5" fill="none" stroke="#0d0d0d" stroke-width="0.8"/>
    </svg>`,
    className: '', iconSize: [16, 14], iconAnchor: [8, 13],
  })
}

// NPS webcam — small camera glyph.
function webcamIcon(isStreaming) {
  const c = isStreaming ? '#8abeb7' : '#81a2be'
  return L.divIcon({
    html: `<svg width="12" height="10" viewBox="0 0 12 10">
      <rect x="1" y="2" width="8" height="6" rx="1" fill="${c}" fill-opacity="0.85" stroke="#0d0d0d" stroke-width="0.8"/>
      <polygon points="9,3.5 11,2 11,8 9,6.5" fill="${c}" fill-opacity="0.85" stroke="#0d0d0d" stroke-width="0.8"/>
    </svg>`,
    className: '', iconSize: [12, 10], iconAnchor: [6, 5],
  })
}

// Resolve FAA 3-letter or ICAO 4-letter codes to AIRPORTS lookup
function resolveAirport(code) {
  if (!code) return null
  if (AIRPORTS[code]) return { code, ...AIRPORTS[code] }
  if (AIRPORTS['K' + code]) return { code: 'K' + code, ...AIRPORTS['K' + code] }
  return null
}

// ── Map utilities ───────────────────────────────────────────────────────────

function MapInvalidator() {
  const map = useMap()
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(map.getContainer())
    return () => ro.disconnect()
  }, [map])
  return null
}

// Sync this map's pan/zoom with a shared viewState. When viewState changes
// from outside (another panel moved), apply via setView. When the user
// pans/zooms this panel, broadcast via onViewChange. The applyingExternalRef
// flag prevents the external apply from triggering its own broadcast (which
// would create an infinite ping-pong between panels).
function ViewSync({ viewState, onViewChange }) {
  const map = useMap()
  const applyingExternalRef = useRef(false)

  // Apply external viewState changes to the map.
  useEffect(() => {
    if (!viewState) return
    const c = map.getCenter()
    const z = map.getZoom()
    const dLat = Math.abs(c.lat - viewState.center[0])
    const dLng = Math.abs(c.lng - viewState.center[1])
    if (dLat < 0.001 && dLng < 0.001 && z === viewState.zoom) return  // no-op
    applyingExternalRef.current = true
    map.setView(viewState.center, viewState.zoom, { animate: false })
  }, [viewState, map])

  // Broadcast user-driven moves.
  useEffect(() => {
    if (!onViewChange) return
    const handler = () => {
      if (applyingExternalRef.current) {
        applyingExternalRef.current = false
        return
      }
      const c = map.getCenter()
      const z = map.getZoom()
      onViewChange({ center: [c.lat, c.lng], zoom: z })
    }
    map.on('moveend', handler)
    map.on('zoomend', handler)
    return () => {
      map.off('moveend', handler)
      map.off('zoomend', handler)
    }
  }, [map, onViewChange])

  return null
}

function pirepIcon(intensity) {
  const colors = { SEV: '#ff3333', EXTRM: '#ff3333', 'MOD-SEV': '#ff6600', MOD: '#ffcc00', 'LGT-MOD': '#888', LGT: '#666' }
  const c = colors[intensity] || '#888'
  return L.divIcon({
    html: `<svg width="8" height="8" viewBox="0 0 8 8"><polygon points="4,0.5 7.5,4 4,7.5 0.5,4" fill="${c}" stroke="#0d0d0d" stroke-width="0.5" opacity="0.85"/></svg>`,
    className: '', iconSize: [8, 8], iconAnchor: [4, 4],
  })
}

function anomalyIcon(severity, hdg = 0) {
  const colors = { CRITICAL: '#ff3333', HIGH: '#ffcc00', MEDIUM: '#888888' }
  const c = colors[severity] || '#888'
  const s = severity === 'CRITICAL' ? 16 : severity === 'HIGH' ? 13 : 10
  return L.divIcon({
    html: `<svg width="${s}" height="${s}" viewBox="0 0 20 20" style="transform:rotate(${hdg}deg)">
      <path d="M10 2 L12.5 8 L18 9.5 L12.5 11 L13 17 L10 15 L7 17 L7.5 11 L2 9.5 L7.5 8 Z"
        fill="${c}" stroke="#0d0d0d" stroke-width="0.8"/></svg>`,
    className: '', iconSize: [s, s], iconAnchor: [s / 2, s / 2],
  })
}

function notamIcon(count, hasRwy) {
  // Document with folded corner — recognizable as a paper notice
  const c = hasRwy ? '#ff6633' : '#cc9933'
  const sz = count > 10 ? 16 : count > 5 ? 14 : 12
  return L.divIcon({
    html: `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20">
      <path d="M3 2 L13 2 L17 6 L17 18 L3 18 Z" fill="${c}" fill-opacity="0.9" stroke="#0d0d0d" stroke-width="1.2"/>
      <path d="M13 2 L13 6 L17 6" fill="none" stroke="#0d0d0d" stroke-width="1"/>
      <line x1="6" y1="10" x2="14" y2="10" stroke="#0d0d0d" stroke-width="1"/>
      <line x1="6" y1="13" x2="14" y2="13" stroke="#0d0d0d" stroke-width="1"/>
      <line x1="6" y1="16" x2="11" y2="16" stroke="#0d0d0d" stroke-width="1"/>
    </svg>`,
    className: '', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2],
  })
}

// Terminal weather alert icon — warning triangle, colored by highest severity,
// with a single-character symbol identifying the event type.
function wxIcon(severity, eventType) {
  const colors = { CRITICAL: '#ff3333', HIGH: '#ff9933', MEDIUM: '#ffcc00', LOW: '#888888' }
  // Symbols: T tornado, M microburst, W windshear, G gust front, ! hazard text, P precip
  const labels = {
    TORNADO: 'T', MICROBURST: 'M', WINDSHEAR: 'W', GUST_FRONT: 'G',
    HAZARD_TEXT: '!', PRECIP: 'P', STORM_MOTION: 'S',
  }
  const c = colors[severity] || '#888'
  const lbl = labels[eventType] || '·'
  const sz = severity === 'CRITICAL' ? 20 : severity === 'HIGH' ? 17 : 14
  return L.divIcon({
    html: `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20">
      <path d="M10 1.5 L18.5 17 L1.5 17 Z" fill="${c}" fill-opacity="0.9" stroke="#0d0d0d" stroke-width="1.2" stroke-linejoin="round"/>
      <text x="10" y="14.5" text-anchor="middle" font-size="9" font-weight="bold" fill="#0d0d0d" font-family="monospace">${lbl}</text>
    </svg>`,
    className: '', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2],
  })
}

function flowIcon(eventType) {
  const colors = { GS: '#ff3333', GDP: '#f0c674', REROUTE: '#b294bb', AFP: '#f0c674', CTOP: '#de935f', RSTR: '#de935f', GADV: '#b294bb' }
  const labels = { GS: 'S', GDP: 'D', REROUTE: 'R', AFP: 'A', CTOP: 'C', RSTR: 'M', GADV: 'A' }
  const c = colors[eventType] || '#888'
  const lbl = labels[eventType] || '?'
  return L.divIcon({
    html: `<svg width="14" height="14" viewBox="0 0 16 16">
      <polygon points="8,1 15,8 8,15 1,8" fill="${c}" fill-opacity="0.8" stroke="#0d0d0d" stroke-width="0.8"/>
      <text x="8" y="11.5" text-anchor="middle" font-size="7" font-weight="bold" fill="#0d0d0d">${lbl}</text>
    </svg>`,
    className: '', iconSize: [14, 14], iconAnchor: [7, 7],
  })
}

// ── Style constants ──────────────────────────────���──────────────────────────

const SIGMET_STYLE = {
  CONVECTIVE: { color: '#ff3333', fillColor: '#ff3333', fillOpacity: 0.10, weight: 1.5, dashArray: '4 3' },
  TURB:       { color: '#ffcc00', fillColor: '#ffcc00', fillOpacity: 0.08, weight: 1.5, dashArray: '4 3' },
  ICE:        { color: '#00ccff', fillColor: '#00ccff', fillOpacity: 0.08, weight: 1.5, dashArray: '4 3' },
}

const TFR_STYLE = { color: '#ff3333', fillColor: '#ff3333', fillOpacity: 0.15, weight: 2 }
const FLOW_GEOM_STYLE = { color: '#b294bb', fillColor: '#b294bb', fillOpacity: 0.12, weight: 1.5, dashArray: '6 3' }

function airportColor(a) {
  if (a.hasGS) return '#cc6666'
  if (a.hasGDP) return '#f0c674'
  if (a.congestion === 'CONGESTION_BUILDING') return '#cc6666'
  if (a.congestion === 'ELEVATED') return '#f0c674'
  if ((a.depDelay || 0) > 15 || (a.arrDelay || 0) > 15) return '#f0c674'
  if (a.inbound + a.outbound > 0) return '#b5bd68'
  return '#555555'
}

function airportRadius(a) {
  const t = (a.inbound || 0) + (a.outbound || 0)
  return t > 100 ? 8 : t > 50 ? 6 : t > 20 ? 5 : t > 5 ? 4 : 3
}

// ── Layer toggle button ──────────────────────────────���──────────────────────

function LayerBtn({ active, onClick, color, children, count }) {
  return (
    <button
      onClick={onClick}
      className={clsx('px-1.5 py-px border rounded transition-colors text-[9px]',
        active ? `border-${color}/50 text-${color}` : 'border-border text-fg3'
      )}
    >
      {children}{count > 0 ? ` (${count})` : ''}
    </button>
  )
}

// ── Main component ───────────��───────────────────────────────────��──────────

export default function NasMap({
  backendOk, onSelectAirport, compact = false,
  flights: propFlights, trackedIcaos, trackHistory,
  // ── v5.7 quadrant-mode props ───────────────────────────────────────────
  // categoryFilter: array of layer keys ['flights', 'sigmets', ...]. When
  //   provided, the toggle UI is hidden and only the listed layers render.
  //   Used by MapQuadrants to scope each panel to one category.
  // viewState / onViewChange: optional shared center+zoom for cross-panel
  //   pan/zoom sync. When set, this map's viewport tracks viewState and
  //   broadcasts user pans/zooms back via onViewChange.
  // hideControls: explicit override to hide the controls bar even without
  //   a categoryFilter (e.g. embedding NasMap inside another chrome).
  categoryFilter, viewState, onViewChange, hideControls,
  // staticView: disables pan + scroll-zoom + zoom buttons. Used for
  // thumbnail maps where the user isn't meant to interact — the whole
  // tile is click-to-promote instead. Tooltips still work (layer data
  // is still rendered, just with no navigation).
  staticView,
  // onSummaryChange({ counts, headlines }) — fires whenever the visible
  // data changes. counts: object of layer-key → count. headlines: array
  // of up-to-3 named items (the "what's worth looking at" rows shown in
  // the panel header strip). Lets MapQuadrants render a summary line
  // per panel without duplicating fetches.
  onSummaryChange,
  // mapData — when provided, NasMap uses this lifted dataset instead of
  // running its own fetch effects. Required when several NasMap instances
  // are on the same page (MapQuadrants); otherwise each one would fire
  // ~10 endpoints every 30 s and choke the backend event loop.
  mapData,
}) {
  const { nasSummary, flights: swimFlights, flowEvents, notamAirports } = useSwim()
  const flights = propFlights || swimFlights

  // categoryFilter mode: layers come from the prop, toggle UI is hidden.
  // We still maintain the show* state so all downstream useMemo/useEffect
  // dependencies keep working — it just gets driven by the filter prop
  // instead of by user clicks.
  const filterMode = Array.isArray(categoryFilter)
  const inFilter = (k) => filterMode && categoryFilter.includes(k)

  // Layer toggles — default OFF for busy layers, ON for key operational layers
  const [showIfrPositions, setShowIfrPositions] = useState(filterMode ? inFilter('ifr') : false)
  const [showFlights, setShowFlights] = useState(filterMode ? inFilter('flights') : false)
  const [showCascades, setShowCascades] = useState(filterMode ? inFilter('cascades') : true)
  const [showSigmets, setShowSigmets] = useState(filterMode ? inFilter('sigmets') : true)
  const [showPireps, setShowPireps] = useState(filterMode ? inFilter('pireps') : false)
  const [showTfrs, setShowTfrs] = useState(filterMode ? inFilter('tfrs') : true)
  const [showAnomalies, setShowAnomalies] = useState(filterMode ? inFilter('anomalies') : true)
  const [showWxCells, setShowWxCells] = useState(filterMode ? inFilter('wxCells') : true)
  const [showNotams, setShowNotams] = useState(filterMode ? inFilter('notams') : true)
  const [showFlowPrograms, setShowFlowPrograms] = useState(filterMode ? inFilter('flowPrograms') : true)
  const [showTracon, setShowTracon] = useState(filterMode ? inFilter('tracon') : false)
  const [showRouteDevs, setShowRouteDevs] = useState(filterMode ? inFilter('routeDevs') : true)

  // Sync show* state when categoryFilter changes (parent re-renders with a
  // new array). No-op when filter mode is off — user retains manual control.
  useEffect(() => {
    if (!filterMode) return
    setShowIfrPositions(inFilter('ifr'))
    setShowFlights(inFilter('flights'))
    setShowCascades(inFilter('cascades'))
    setShowSigmets(inFilter('sigmets'))
    setShowPireps(inFilter('pireps'))
    setShowTfrs(inFilter('tfrs'))
    setShowAnomalies(inFilter('anomalies'))
    setShowWxCells(inFilter('wxCells'))
    setShowNotams(inFilter('notams'))
    setShowFlowPrograms(inFilter('flowPrograms'))
    setShowTracon(inFilter('tracon'))
    setShowRouteDevs(inFilter('routeDevs'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryFilter && categoryFilter.join('|')])

  // Correlation-layer toggles (v5.1.0) — persisted in localStorage.
  const readToggle = (name, def) => {
    try { const v = localStorage.getItem('nasmap:ctx:' + name); if (v != null) return v === '1' } catch {}
    return def
  }
  const useLsToggle = (name, def) => {
    const [v, set] = useState(() => readToggle(name, def))
    const wrapped = (next) => {
      const resolved = typeof next === 'function' ? next(v) : next
      try { localStorage.setItem('nasmap:ctx:' + name, resolved ? '1' : '0') } catch {}
      set(resolved)
    }
    return [v, wrapped]
  }
  const [showFires,     setShowFires]     = useLsToggle('fires',     filterMode ? inFilter('fires')     : false)
  const [showEvents,    setShowEvents]    = useLsToggle('events',    filterMode ? inFilter('events')    : false)
  const [showQuakes,    setShowQuakes]    = useLsToggle('quakes',    filterMode ? inFilter('quakes')    : false)
  const [showVolcanoes, setShowVolcanoes] = useLsToggle('volcanoes', filterMode ? inFilter('volcanoes') : false)
  const [showWebcams,   setShowWebcams]   = useLsToggle('webcams',   filterMode ? inFilter('webcams')   : false)

  // Sync correlation-layer toggles when the categoryFilter changes too.
  useEffect(() => {
    if (!filterMode) return
    setShowFires(inFilter('fires'))
    setShowEvents(inFilter('events'))
    setShowQuakes(inFilter('quakes'))
    setShowVolcanoes(inFilter('volcanoes'))
    setShowWebcams(inFilter('webcams'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryFilter && categoryFilter.join('|')])

  // Fetched data (map-specific, not from SwimContext)
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

  // Correlation-layer data (v5.1.0)
  const [fires, setFires]         = useState([])
  const [eonetEvents, setEonetEvents]     = useState([])
  const [quakes, setQuakes]       = useState([])
  const [volcanoes, setVolcanoes] = useState([])
  const [webcams, setWebcams]     = useState([])
  const [ctxError, setCtxError]   = useState(null)

  // Sync local state from lifted mapData when provided. This bypasses the
  // internal fetch effects entirely so multiple NasMap instances under
  // the same parent share one set of upstream calls.
  useEffect(() => {
    if (!mapData) return
    setSigmets(mapData.sigmets || [])
    setPireps(mapData.pireps || [])
    setTfrs(mapData.tfrs || [])
    setAnomalies(mapData.anomalies || [])
    setHotspots(mapData.hotspots || [])
    setTerminalWx(mapData.terminalWx || [])
    setRouteDeviations(mapData.routeDeviations || [])
    setIfrPositions(mapData.ifrPositions || [])
    setSurfacePositions(mapData.surfacePositions || [])
    setWeatherDelays(mapData.weatherDelays || null)
    setSectorData(mapData.sectorData || [])
    setFires(mapData.fires || [])
    setEonetEvents(mapData.eonetEvents || [])
    setQuakes(mapData.quakes || [])
    setVolcanoes(mapData.volcanoes || [])
    setWebcams(mapData.webcams || [])
    if (mapData.ctxError !== undefined) setCtxError(mapData.ctxError)
  }, [mapData])

  // Fetch all map layer data (staggered refresh) — skipped when mapData
  // is supplied externally (the MapQuadrants path).
  useEffect(() => {
    if (!backendOk || mapData) return
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
    const id = setInterval(refresh, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk, mapData])

  // ── Correlation-layer fetch (v5.1.0) — only fires when any toggle is on ──
  // Skipped when mapData is supplied externally (parent owns the geo fetch).
  useEffect(() => {
    if (!backendOk || mapData) return
    const active = []
    if (showFires)     active.push('fires')
    if (showEvents)    active.push('events')
    if (showQuakes)    active.push('quakes')
    if (showVolcanoes) active.push('volcanoes')
    if (showWebcams)   active.push('webcams')
    if (active.length === 0) return

    let cancelled = false
    const refresh = async () => {
      try {
        const data = await fetchMapContext({ layers: active })
        if (cancelled) return
        setCtxError(null)
        if (showFires)     setFires(data.fires?.fires || [])
        if (showEvents)    setEonetEvents(data.events?.events || [])
        if (showQuakes)    setQuakes(data.quakes?.quakes || [])
        if (showVolcanoes) setVolcanoes(data.volcanoes?.alerts || [])
        if (showWebcams)   setWebcams((data.webcams?.webcams || []).filter(c => c.status === 'Active'))
      } catch (err) {
        if (!cancelled) setCtxError(err.response?.data?.error || err.message)
      }
    }
    refresh()
    // Refresh cadence matches FIRMS cache TTL (10 min) to avoid burning quota.
    const id = setInterval(refresh, 5 * 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk, mapData, showFires, showEvents, showQuakes, showVolcanoes, showWebcams])

  const airports = nasSummary?.airports || []

  // ── Computed map data ────��──────────────────────────��─────────────────────

  const airportMarkers = useMemo(() =>
    airports.filter(a => AIRPORTS[a.airport]).map(a => ({ ...a, ...AIRPORTS[a.airport] })),
    [airports]
  )

  // IFR flight positions (TFMS — FAA-tracked IFR flights with radar positions)
  const ifrDots = useMemo(() => {
    if (!showIfrPositions) return []
    return ifrPositions.filter(f => f.lat != null && f.lon != null)
  }, [ifrPositions, showIfrPositions])

  // Cascade lines
  const cascadeLines = useMemo(() => {
    if (!showCascades) return []
    const lines = []
    for (const a of airports) {
      if (!a.cascade || !AIRPORTS[a.airport]) continue
      const dest = AIRPORTS[a.airport]
      for (const orig of (a.cascade.origins || [])) {
        if (AIRPORTS[orig]) {
          lines.push({ positions: [[AIRPORTS[orig].lat, AIRPORTS[orig].lon], [dest.lat, dest.lon]], airport: a.airport, origin: orig })
        }
      }
    }
    return lines
  }, [airports, showCascades])

  // SIGMET polygons
  const sigmetPolys = useMemo(() =>
    sigmets.filter(s => s.coords?.length >= 3).map(s => ({
      coords: s.coords.map(c => [c.lat, c.lon]),
      hazard: s.hazard, type: s.airSigmetType,
      raw: s.rawAirSigmet?.substring(0, 100),
    })),
    [sigmets]
  )

  // TFR polygons
  const tfrPolys = useMemo(() =>
    tfrs.filter(t => t.geometry).map(t => {
      try {
        const geo = typeof t.geometry === 'string' ? JSON.parse(t.geometry) : t.geometry
        if (!Array.isArray(geo) || geo.length < 3) return null
        return { coords: geo.map(([lat, lon]) => [lat, lon]), ...t }
      } catch { return null }
    }).filter(Boolean),
    [tfrs]
  )

  // Flow event geometry (FXA, RSTR with polygons)
  const flowPolys = useMemo(() =>
    (flowEvents || []).filter(e => e.geometry).map(e => {
      try {
        const geo = typeof e.geometry === 'string' ? JSON.parse(e.geometry) : e.geometry
        if (!Array.isArray(geo) || geo.length < 3) return null
        return { coords: geo.map(([lat, lon]) => [lat, lon]), ...e }
      } catch { return null }
    }).filter(Boolean),
    [flowEvents]
  )

  // Flow programs (GDP, GS, REROUTE, RSTR, GADV — airport markers)
  const flowProgramMarkers = useMemo(() => {
    if (!showFlowPrograms) return []
    const types = ['GS', 'GDP', 'REROUTE', 'AFP', 'CTOP', 'RSTR', 'GADV']
    const seen = new Set()
    return (flowEvents || [])
      .filter(e => types.includes(e.event_type) && e.airport)
      .map(e => {
        const ap = resolveAirport(e.airport)
        if (!ap) return null
        // Dedup by type+airport
        const key = `${e.event_type}-${ap.code}`
        if (seen.has(key)) return null
        seen.add(key)
        return { ...e, resolvedAirport: ap.code, lat: ap.lat, lon: ap.lon }
      })
      .filter(Boolean)
  }, [flowEvents, showFlowPrograms])

  // PIREP points
  const pirepPoints = useMemo(() =>
    pireps.filter(p => p.lat != null && p.lon != null).map(p => ({
      lat: p.lat, lon: p.lon, turb: p.tbInt1, ice: p.icgInt1, fl: p.fltLvl, acType: p.acType,
    })),
    [pireps]
  )

  // Anomaly points
  const anomalyPoints = useMemo(() =>
    anomalies.filter(a => a.lat != null && a.lon != null),
    [anomalies]
  )

  // Hotspot circles
  const hotspotCircles = useMemo(() =>
    hotspots.filter(h => h.lat != null && h.lon != null),
    [hotspots]
  )

  // Terminal weather markers — ITWS Alerts have null lat/lon and are keyed by
  // FAA 3-letter site/airport codes (MCI, DTW, ...). Resolve to lat/lon via
  // the airports lookup, then dedup by airport keeping the highest-severity
  // event and accumulating all other events for the tooltip.
  const wxPoints = useMemo(() => {
    const SEV_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }
    const byAirport = new Map()
    for (const w of terminalWx) {
      const code = w.airport || w.site
      if (!code) continue
      // Use existing lat/lon if present, else resolve from airport code.
      let lat = w.lat, lon = w.lon, resolvedCode = code
      if (lat == null || lon == null) {
        const ap = resolveAirport(code)
        if (!ap) continue
        lat = ap.lat; lon = ap.lon; resolvedCode = ap.code
      }
      const existing = byAirport.get(resolvedCode)
      const isHigherSev = !existing || (SEV_RANK[w.severity] || 0) > (SEV_RANK[existing.severity] || 0)
      const events = existing?.events || []
      if (!events.some(e => e.event_type === w.event_type)) {
        events.push({ event_type: w.event_type, severity: w.severity, text: w.text, valid_time: w.valid_time })
      }
      if (isHigherSev) {
        byAirport.set(resolvedCode, { ...w, lat, lon, code: resolvedCode, events })
      } else {
        existing.events = events
      }
    }
    return Array.from(byAirport.values())
  }, [terminalWx])

  // NOTAM airport markers (field is `location`, may be 3-letter FAA or 4-letter ICAO)
  const notamMarkers = useMemo(() => {
    if (!showNotams) return []
    return (notamAirports || [])
      .map(n => {
        const ap = resolveAirport(n.location)
        if (!ap) return null
        return { ...n, airport: ap.code, lat: ap.lat, lon: ap.lon, hasRwy: (n.rwy || 0) > 0 }
      })
      .filter(Boolean)
  }, [notamAirports, showNotams])

  // Route deviation lines
  const devLines = useMemo(() => {
    if (!showRouteDevs) return []
    return routeDeviations.map(d => {
      const dep = resolveAirport(d.dep_arpt)
      const arr = resolveAirport(d.arr_arpt)
      if (!dep || !arr || d.avg_km <= 30) return null
      return { positions: [[dep.lat, dep.lon], [arr.lat, arr.lon]], ...d, dep_arpt: dep.code, arr_arpt: arr.code }
    }).filter(Boolean)
  }, [routeDeviations, showRouteDevs])

  // Surface/TRACON markers
  const traconDots = useMemo(() => {
    if (!showTracon) return []
    return surfacePositions.filter(s => s.lat != null && s.lon != null)
  }, [surfacePositions, showTracon])

  // Flight dots (ADS-B from SwimContext)
  const flightDots = useMemo(() => {
    if (!showFlights) return []
    return flights.filter(f => f.lat != null && f.lon != null).slice(0, 800)
  }, [flights, showFlights])

  // Tracked flights — user-pinned flights with trail history
  const TRACK_COLORS = ['#f0c674', '#b294bb', '#de935f', '#8abeb7', '#81a2be', '#cc6666', '#b5bd68', '#a3685a']
  const trackedFlights = useMemo(() => {
    if (!trackedIcaos || trackedIcaos.size === 0) return []
    const icaoList = [...trackedIcaos]
    return icaoList.map((icao, idx) => {
      const f = flights.find(fl => fl.icao === icao)
      if (!f || f.lat == null || f.lon == null) return null
      const trail = (trackHistory || {})[icao] || []
      const trailPositions = trail
        .filter(p => p.lat != null && p.lon != null)
        .map(p => [p.lat, p.lon])
      return { ...f, trail: trailPositions, color: TRACK_COLORS[idx % TRACK_COLORS.length] }
    }).filter(Boolean)
  }, [trackedIcaos, flights, trackHistory])

  // Counts for toggle buttons
  const gsCount = airports.filter(a => a.hasGS).length
  const gdpCount = airports.filter(a => a.hasGDP).length

  // ── Summary report-up to MapQuadrants headlines strip ─────────────────
  // Fires when any of the visible-data arrays change. We compute the top-3
  // "what matters" items per category here because the data is already in
  // memory and ranked. MapQuadrants then renders this as plain-language
  // headlines under each panel header — the user shouldn't have to decode
  // icons to know "KOW186 is squawking 7500."
  useEffect(() => {
    if (!onSummaryChange) return
    const counts = {
      flights:      Array.isArray(flights) ? flights.length : 0,
      anomalies:    anomalyPoints.length,
      routeDevs:    devLines.length,
      ifr:          ifrPositions.length,
      tracon:       surfacePositions.length,
      sigmets:      sigmetPolys.length,
      pireps:       pirepPoints.length,
      wxCells:      wxPoints.length,
      tfrs:         tfrPolys.length,
      notams:       notamMarkers.length,
      flowPrograms: flowProgramMarkers.length,
      flowGs:       gsCount,
      flowGdp:      gdpCount,
      fires:        fires.length,
      events:       eonetEvents.length,
      quakes:       quakes.length,
      volcanoes:    volcanoes.length,
      webcams:      webcams.length,
    }

    // Compute top-3 headlines per category. Each entry: { kind, label, detail }
    // kind drives the chip color in MapHeadlines. Sorted by severity within
    // each picker. We always pick 3 across all categories — MapQuadrants
    // will filter to the ones that match its categoryFilter.
    const headlines = []

    // Anomalies — highest score first.
    const sortedAnoms = [...anomalyPoints].sort((a, b) => (b.score || 0) - (a.score || 0))
    for (const a of sortedAnoms.slice(0, 3)) {
      headlines.push({
        cat: 'traffic',
        kind: a.severity === 'CRITICAL' ? 'critical' : a.severity === 'HIGH' ? 'high' : 'medium',
        label: a.callsign || a.icao,
        detail: a.category || a.reasons?.[0] || 'anomaly',
      })
    }
    // Off-route diversions (only if no critical anomalies above)
    if (sortedAnoms.filter(a => a.severity === 'CRITICAL').length < 2) {
      const sortedDevs = [...devLines].sort((a, b) => (b.deviation_km || 0) - (a.deviation_km || 0))
      for (const d of sortedDevs.slice(0, 2)) {
        headlines.push({
          cat: 'traffic', kind: 'off-route',
          label: d.callsign || '—',
          detail: `${Math.round(d.deviation_km || 0)}km off route`,
        })
      }
    }

    // Severe SIGMETs first.
    const sortedSigmets = [...sigmetPolys].sort((a, b) => {
      const rank = { CONVECTIVE: 3, ICE: 2, TURB: 1 }
      return (rank[b.hazard] || 0) - (rank[a.hazard] || 0)
    })
    for (const s of sortedSigmets.slice(0, 3)) {
      headlines.push({
        cat: 'weather', kind: s.hazard?.toLowerCase() || 'sigmet',
        label: s.hazard || 'SIGMET', detail: (s.raw || '').slice(0, 40),
      })
    }
    // Severe PIREPs (top 2 most severe)
    const sortedPireps = [...pirepPoints].filter(p => /SEV|MOD/.test(p.turb || '')).slice(0, 2)
    for (const p of sortedPireps) {
      headlines.push({
        cat: 'weather', kind: p.turb?.includes('SEV') ? 'critical' : 'medium',
        label: 'PIREP', detail: `${p.turb || ''} turb @ FL${p.fl || '?'}`,
      })
    }

    // Flow events: GS first, then GDP, then TFRs.
    const gsAirports = airports.filter(a => a.hasGS).slice(0, 3)
    for (const ap of gsAirports) {
      headlines.push({
        cat: 'constraints', kind: 'critical',
        label: ap.airport.replace(/^K/, ''), detail: 'ground stop',
      })
    }
    const gdpAirports = airports.filter(a => a.hasGDP && !a.hasGS).slice(0, 3)
    for (const ap of gdpAirports) {
      headlines.push({
        cat: 'constraints', kind: 'high',
        label: ap.airport.replace(/^K/, ''), detail: 'GDP active',
      })
    }
    for (const t of tfrPolys.slice(0, 2)) {
      headlines.push({
        cat: 'constraints', kind: 'high',
        label: 'TFR', detail: t.location || (t.text || '').slice(0, 40) || 'restriction',
      })
    }

    // Geo: largest quakes first, active volcanoes, then biggest fires.
    const sortedQuakes = [...quakes].sort((a, b) => (b.mag || 0) - (a.mag || 0))
    for (const q of sortedQuakes.slice(0, 2)) {
      headlines.push({
        cat: 'geo', kind: (q.mag || 0) >= 5 ? 'critical' : 'medium',
        label: `M${(q.mag || 0).toFixed(1)}`,
        detail: q.place || 'earthquake',
      })
    }
    for (const v of volcanoes.slice(0, 2)) {
      headlines.push({
        cat: 'geo', kind: v.alert_level === 'WARNING' ? 'critical' : 'high',
        label: v.volcano_name || 'volcano', detail: v.alert_level || 'alert',
      })
    }
    if (fires.length > 0) {
      headlines.push({
        cat: 'geo', kind: 'medium',
        label: `${fires.length} fires`, detail: 'FIRMS active hotspots',
      })
    }

    onSummaryChange({ counts, headlines })
  }, [
    onSummaryChange, flights, anomalyPoints, devLines, ifrPositions, surfacePositions,
    sigmetPolys, pirepPoints, wxPoints, tfrPolys, notamMarkers, flowProgramMarkers,
    fires, eonetEvents, quakes, volcanoes, webcams, airports, gsCount, gdpCount,
  ])

  // Hide controls when (a) compact embedding, (b) caller asked, or
  // (c) we're filter-locked into one category (toggles would be misleading
  // since the categoryFilter overrides them).
  const showControls = !compact && !hideControls && !filterMode

  return (
    <div className={clsx('bg-bg1', compact && 'h-full flex flex-col min-h-0')}>
      {/* Controls — hidden in compact mode to save vertical space */}
      {showControls && (
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex flex-wrap gap-1 justify-between items-center">
        <span className="flex items-center gap-1.5">
          <span>US airspace</span>
          {gsCount > 0 && <span className="text-red animate-pulse">GS:{gsCount}</span>}
          {gdpCount > 0 && <span className="text-ylw">GDP:{gdpCount}</span>}
        </span>
        <span className="flex gap-2 items-center flex-wrap">
          {/* Weather group */}
          <span className="flex gap-1 items-center">
            <span className="text-fg3/40 text-[7px] uppercase tracking-wide">wx</span>
            <LayerBtn active={showTfrs} onClick={() => setShowTfrs(v => !v)} color="red" count={tfrPolys.length}>TFRs</LayerBtn>
            <LayerBtn active={showSigmets} onClick={() => setShowSigmets(v => !v)} color="ylw" count={sigmetPolys.length}>SIGMETs</LayerBtn>
            <LayerBtn active={showPireps} onClick={() => setShowPireps(v => !v)} color="cyn" count={pirepPoints.length}>PIREPs</LayerBtn>
            <LayerBtn active={showWxCells} onClick={() => setShowWxCells(v => !v)} color="mag" count={wxPoints.length}>WEATHER</LayerBtn>
          </span>
          {/* Flights group */}
          <span className="flex gap-1 items-center">
            <span className="text-fg3/40 text-[7px] uppercase tracking-wide">flt</span>
            <LayerBtn active={showFlights} onClick={() => setShowFlights(v => !v)} color="acc">ADS-B</LayerBtn>
            <LayerBtn active={showIfrPositions} onClick={() => setShowIfrPositions(v => !v)} color="grn" count={ifrPositions.length}>IFR</LayerBtn>
            <LayerBtn active={showTracon} onClick={() => setShowTracon(v => !v)} color="cyn" count={surfacePositions.length}>TRACON</LayerBtn>
          </span>
          {/* Events group */}
          <span className="flex gap-1 items-center">
            <span className="text-fg3/40 text-[7px] uppercase tracking-wide">evt</span>
            <LayerBtn active={showAnomalies} onClick={() => setShowAnomalies(v => !v)} color="red" count={anomalyPoints.length}>anomalies</LayerBtn>
            <LayerBtn active={showRouteDevs} onClick={() => setShowRouteDevs(v => !v)} color="ylw" count={devLines.length}>off-route</LayerBtn>
            <LayerBtn active={showFlowPrograms} onClick={() => setShowFlowPrograms(v => !v)} color="ylw" count={flowProgramMarkers.length}>flow</LayerBtn>
            <LayerBtn active={showNotams} onClick={() => setShowNotams(v => !v)} color="org" count={(notamAirports || []).length}>NOTAMs</LayerBtn>
            <LayerBtn active={showCascades} onClick={() => setShowCascades(v => !v)} color="red">cascades</LayerBtn>
          </span>
          {/* Correlation-layer group (v5.1.0) — external context sources */}
          <span className="flex gap-1 items-center">
            <span className="text-fg3/40 text-[7px] uppercase tracking-wide" title="external context sources — FIRMS, EONET, USGS, NPS">env</span>
            <LayerBtn active={showFires}     onClick={() => setShowFires(v => !v)}     color="org" count={showFires ? fires.length : 0}>fires</LayerBtn>
            <LayerBtn active={showEvents}    onClick={() => setShowEvents(v => !v)}    color="mag" count={showEvents ? eonetEvents.length : 0}>events</LayerBtn>
            <LayerBtn active={showQuakes}    onClick={() => setShowQuakes(v => !v)}    color="mag" count={showQuakes ? quakes.length : 0}>quakes</LayerBtn>
            <LayerBtn active={showVolcanoes} onClick={() => setShowVolcanoes(v => !v)} color="red" count={showVolcanoes ? volcanoes.length : 0}>volc</LayerBtn>
            <LayerBtn active={showWebcams}   onClick={() => setShowWebcams(v => !v)}   color="cyn" count={showWebcams ? webcams.length : 0}>cams</LayerBtn>
            {ctxError && <span className="text-red text-[8px]" title={ctxError}>ctx!</span>}
          </span>
        </span>
      </div>
      )}

      <div
        className={compact ? 'flex-1 min-h-0' : undefined}
        style={compact ? undefined : { height: 'min(78vh, 760px)', minHeight: 520 }}
      >
        <MapContainer
          center={[39, -96]} zoom={4}
          className="h-full w-full" style={{ background: '#1a1a1a' }}
          zoomControl={!staticView}
          scrollWheelZoom={false}
          dragging={!staticView}
          doubleClickZoom={!staticView}
          touchZoom={!staticView}
          boxZoom={!staticView}
          keyboard={!staticView}
          attributionControl={false}>

          <MapInvalidator />
          {(viewState || onViewChange) && <ViewSync viewState={viewState} onViewChange={onViewChange} />}
          <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />

          {/* ── SIGMET polygons (weather hazards) ─────────────────────────── */}
          {showSigmets && sigmetPolys.map((s, i) => (
            <Polygon key={`sig-${i}`} positions={s.coords}
              pathOptions={SIGMET_STYLE[s.hazard] || SIGMET_STYLE.TURB}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {s.type} — {s.hazard}<br />{s.raw}
              </span></Tooltip>
            </Polygon>
          ))}

          {/* ── TFR polygons (airspace restrictions) ──────────────────────── */}
          {showTfrs && tfrPolys.map((t, i) => (
            <Polygon key={`tfr-${i}`} positions={t.coords} pathOptions={TFR_STYLE}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>TFR</b> {t.location || ''}<br />
                {t.alt_lower != null && `${t.alt_lower}–${t.alt_upper}ft `}
                {t.text?.substring(0, 80) || 'restriction active'}
              </span></Tooltip>
            </Polygon>
          ))}

          {/* TFR point markers (for TFRs without polygon geometry) */}
          {showTfrs && tfrs.filter(t => !t.geometry && t.lat != null).map((t, i) => (
            <CircleMarker key={`tfrpt-${i}`} center={[t.lat, t.lon]} radius={6}
              pathOptions={{ color: '#ff3333', fillColor: '#ff3333', fillOpacity: 0.3, weight: 2 }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                TFR {t.location || ''}: {t.text?.substring(0, 60) || ''}
              </span></Tooltip>
            </CircleMarker>
          ))}

          {/* ── Flow restriction geometry (FXA, RSTR areas) ────��──────────── */}
          {flowPolys.map((p, i) => (
            <Polygon key={`flow-${i}`} positions={p.coords} pathOptions={FLOW_GEOM_STYLE}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {p.event_type} {p.facility || ''}<br />
                {p.ceiling && `FL${p.floor || '?'}–${p.ceiling} `}
                {p.text?.substring(0, 60) || ''}
              </span></Tooltip>
            </Polygon>
          ))}

          {/* ── Flow program markers (GDP / GS / REROUTE / RSTR at airports) */}
          {flowProgramMarkers.map((f, i) => (
            <Marker key={`fp-${i}`} position={[f.lat, f.lon]} icon={flowIcon(f.event_type)}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>{f.event_type}</b> {(f.resolvedAirport || f.airport || '').replace(/^K/, '')}<br />
                {f.delay_minutes > 0 && `delay: ${Math.round(f.delay_minutes)}m `}
                {f.restriction_type && `${f.restriction_type} ${f.restriction_value || ''} `}
                {f.reason ? f.reason.substring(0, 60) : ''}<br />
                {f.text?.substring(0, 100) || ''}
              </span></Tooltip>
            </Marker>
          ))}

          {/* ── Route deviation corridors ─────────────────────────────────── */}
          {devLines.map((d, i) => (
            <Polyline key={`dev-${i}`} positions={d.positions}
              pathOptions={{ color: '#f0c674', weight: 2, opacity: 0.5, dashArray: '8 4' }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {d.dep_arpt?.replace(/^K/, '')} → {d.arr_arpt?.replace(/^K/, '')}<br />
                {d.flights} flights, avg {d.avg_km}km off-route
              </span></Tooltip>
            </Polyline>
          ))}

          {/* ── Cascade impact lines ──────────────────────────────���──────── */}
          {cascadeLines.map((line, i) => (
            <Polyline key={`cas-${i}`} positions={line.positions}
              pathOptions={{ color: '#cc6666', weight: 1.5, opacity: 0.3 }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {line.origin?.replace(/^K/, '')} → {line.airport?.replace(/^K/, '')} (held)
              </span></Tooltip>
            </Polyline>
          ))}

          {/* ── PIREPs (turbulence/icing reports) ─��─────────────────────���─── */}
          {showPireps && pirepPoints.map((p, i) => (
            <Marker key={`pirep-${i}`} position={[p.lat, p.lon]} icon={pirepIcon(p.turb || p.ice)}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                PIREP FL{p.fl || '?'} {p.acType || ''}<br />
                {p.turb && `turb: ${p.turb} `}{p.ice && `ice: ${p.ice}`}
              </span></Tooltip>
            </Marker>
          ))}

          {/* ── Terminal weather alerts (ITWS) ────────────────────────────── */}
          {showWxCells && wxPoints.map((w, i) => (
            <Marker key={`wx-${i}`} position={[w.lat, w.lon]} icon={wxIcon(w.severity, w.event_type)}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>{(w.code || w.airport || w.site || '—').replace(/^K/, '')}</b> — Terminal Weather<br />
                {(w.events || [{ event_type: w.event_type, severity: w.severity }]).map((e, j) => (
                  <span key={j} style={{ display: 'block' }}>
                    <span style={{ color: e.severity === 'CRITICAL' ? '#ff3333' : e.severity === 'HIGH' ? '#ff9933' : e.severity === 'MEDIUM' ? '#ffcc00' : '#888' }}>●</span>
                    {' '}{e.event_type?.replace(/_/g, ' ')} [{e.severity}]
                  </span>
                ))}
              </span></Tooltip>
            </Marker>
          ))}

          {/* ── NOTAM markers at airports ──────────────────────���──────────── */}
          {notamMarkers.map((n, i) => (
            <Marker key={`notam-${i}`} position={[n.lat, n.lon]} icon={notamIcon(n.count, n.hasRwy)}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>NOTAMs</b> {n.airport?.replace(/^K/, '')} — {n.count} active<br />
                {n.rwy > 0 && <span style={{ color: '#ff6633' }}>RWY:{n.rwy} </span>}
                {n.twy > 0 && `TWY:${n.twy} `}
                {n.apron > 0 && `APRON:${n.apron} `}
                {n.svc > 0 && `SVC:${n.svc} `}
                {n.obst > 0 && `OBST:${n.obst} `}
                {n.airspace > 0 && <span style={{ color: '#ff3333' }}>AIRSPACE:{n.airspace}</span>}
              </span></Tooltip>
            </Marker>
          ))}

          {/* ── Anomaly hotspot circles (24h) ──────────────────────────��──── */}
          {showAnomalies && hotspotCircles.map((h, i) => (
            <CircleMarker key={`hs-${i}`} center={[h.lat, h.lon]}
              radius={Math.min(20, 6 + (h.count || 1) * 2)}
              pathOptions={{ color: '#cc6666', fillColor: '#cc6666', fillOpacity: 0.08, weight: 1, dashArray: '3 3' }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                hotspot: {h.count} anomalies in 24h
                {h.deviation != null && <><br />{h.deviation > 1 ? `${h.deviation.toFixed(1)}x above` : `${(1/h.deviation).toFixed(1)}x below`} baseline</>}
              </span></Tooltip>
            </CircleMarker>
          ))}

          {/* ── Anomaly aircraft markers ────────────���─────────────────────── */}
          {showAnomalies && anomalyPoints.map((a, i) => (
            <Marker key={`anom-${i}`} position={[a.lat, a.lon]} icon={anomalyIcon(a.severity, a.hdg)}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>{a.callsign || a.icao}</b> [{a.severity}] {a.score}<br />
                {a.reasons?.slice(0, 3).join('; ')}
              </span></Tooltip>
            </Marker>
          ))}

          {/* ── Surface/TRACON radar tracks ───────────────────────────────── */}
          {traconDots.map((s, i) => (
            <CircleMarker key={`trc-${i}`} center={[s.lat, s.lon]} radius={2}
              pathOptions={{ color: '#8abeb7', fillColor: '#8abeb7', fillOpacity: 0.6, weight: 0 }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {s.callsign || '—'} [{s.service}]<br />
                {s.tracon && `TRACON: ${s.tracon} `}
                {s.airport && `APT: ${s.airport.replace(/^K/, '')} `}
                {s.altitude && `ALT: ${s.altitude} `}
                {s.speed != null && `SPD: ${Math.round(s.speed)}kt`}
              </span></Tooltip>
            </CircleMarker>
          ))}

          {/* ── IFR flight positions (SFDPS en route) ────────────────────── */}
          {ifrDots.map((f, i) => {
            const alt = Number(f.reported_alt || f.altitude) || 0
            const color = alt >= 350 ? '#b5bd68' : alt >= 240 ? '#8abeb7' : alt >= 100 ? '#81a2be' : '#b294bb'
            return (
              <CircleMarker key={`ifr-${i}`} center={[f.lat, f.lon]} radius={1.5}
                pathOptions={{ color, fillColor: color, fillOpacity: 0.7, weight: 0 }}>
                <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                  <b>{f.acid}</b>{f.aircraft_type ? ` (${f.aircraft_type})` : ''} {f.flight_status ? `[${f.flight_status}]` : ''}<br />
                  {f.dep_arpt?.replace(/^K/, '') || '?'} → {f.arr_arpt?.replace(/^K/, '') || '?'}
                  {f.route ? <><br /><span style={{ color: '#999', fontSize: 10 }}>{f.route.length > 50 ? f.route.substring(0, 50) + '…' : f.route}</span></> : null}<br />
                  {(f.reported_alt || f.altitude) && `FL${f.reported_alt || f.altitude} `}
                  {f.speed && `${Math.round(f.speed)}kt `}
                  {f.heading && `HDG ${Math.round(f.heading)}° `}
                  {f.beacon_code && `SQ ${f.beacon_code}`}
                  {f.artcc && <><br /><span style={{ color: '#999' }}>{f.artcc}{f.sector ? ` / ${f.sector}` : ''}</span></>}
                </span></Tooltip>
              </CircleMarker>
            )
          })}

          {/* ── ADS-B flight positions ────────────────────────────────────── */}
          {flightDots.map(f => (
            <CircleMarker key={f.icao || f.acid} center={[f.lat, f.lon]} radius={1.5}
              pathOptions={{ color: '#81a2be', fillColor: '#81a2be', fillOpacity: 0.5, weight: 0 }} />
          ))}

          {/* ── Tracked flights — user-pinned with trail + plane icon ────── */}
          {trackedFlights.map(f => (
            <React.Fragment key={`tracked-${f.icao}`}>
              {f.trail.length >= 2 && (
                <Polyline positions={f.trail}
                  pathOptions={{ color: f.color, weight: 2.5, opacity: 0.6, dashArray: '6 4' }} />
              )}
              <CircleMarker center={[f.lat, f.lon]} radius={5}
                pathOptions={{ color: f.color, fillColor: f.color, fillOpacity: 0.9, weight: 2 }}>
                <Tooltip permanent direction="right" offset={[8, 0]} className="tracked-label">
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: f.color, letterSpacing: '0.5px' }}>
                    {f.callsign || f.icao}
                  </span>
                </Tooltip>
              </CircleMarker>
            </React.Fragment>
          ))}

          {/* ── Airport markers (always on, top layer) ─────────��─────────── */}
          {airportMarkers.map(a => (
            <CircleMarker key={a.airport} center={[a.lat, a.lon]} radius={airportRadius(a)}
              pathOptions={{
                color: airportColor(a), fillColor: airportColor(a),
                fillOpacity: 0.7, weight: a.hasGS || a.hasGDP ? 2 : 1,
              }}
              eventHandlers={{ click: () => onSelectAirport?.(a.airport) }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>{a.airport.replace(/^K/, '')}</b> {a.city}<br />
                {a.inbound} in / {a.outbound} out
                {a.depDelay != null && <><br />dep: {a.depDelay > 0 ? '+' : ''}{a.depDelay}m</>}
                {a.arrDelay != null && <><br />arr: {a.arrDelay > 0 ? '+' : ''}{a.arrDelay}m</>}
                {a.taxiOut != null && <><br />taxi out: {a.taxiOut}m</>}
                {a.congestion !== 'NORMAL' && <><br /><span style={{ color: '#f0c674' }}>{a.congestion}</span></>}
                {a.hasGS && <><br /><span style={{ color: '#cc6666' }}>GROUND STOP</span></>}
                {a.hasGDP && <><br /><span style={{ color: '#f0c674' }}>GDP {a.maxFlowDelay > 0 ? a.maxFlowDelay + 'm' : ''}</span></>}
                {a.cascade && <><br />{a.cascade.affectedFlights} flights held</>}
              </span></Tooltip>
            </CircleMarker>
          ))}

          {/* ── Correlation layer (v5.1.0) ───────────────────────────────── */}

          {/* FIRMS active fire pixels */}
          {showFires && fires.map((f, i) => (
            <Marker key={`fire-${i}`} position={[f.lat, f.lon]} icon={fireIcon(f.frp || 0)}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>FIRMS fire pixel</b><br />
                FRP: {f.frp?.toFixed(1) ?? '—'} MW<br />
                brightness: {f.brightness?.toFixed(1)}K<br />
                {f.acqDate} {f.acqTime}z · {f.daynight === 'D' ? 'day' : 'night'} · conf {f.confidence}
              </span></Tooltip>
            </Marker>
          ))}

          {/* EONET natural events */}
          {showEvents && eonetEvents.filter(e => e.lat != null && e.lon != null).map(e => (
            <Marker key={`eo-${e.id}`} position={[e.lat, e.lon]} icon={eonetIcon(e.categories)}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>{e.title}</b><br />
                {e.categories.join(', ')}<br />
                {e.magnitude != null && <>{e.magnitude} {e.magnitudeUnit}<br /></>}
                {e.date}
              </span></Tooltip>
            </Marker>
          ))}

          {/* USGS earthquakes */}
          {showQuakes && quakes.map(q => (
            <Marker key={`eq-${q.id}`} position={[q.lat, q.lon]} icon={quakeIcon(q.mag || 0)}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>M{q.mag?.toFixed(1)}</b> {q.place}<br />
                depth: {q.depthKm?.toFixed(1)}km<br />
                {q.tsunami ? <span style={{ color: '#cc6666' }}>TSUNAMI<br /></span> : null}
                {new Date(q.time).toISOString().replace('T', ' ').slice(0, 16)}z
              </span></Tooltip>
            </Marker>
          ))}

          {/* USGS volcano alerts — plotted at observatory region centroid (HANS
              list has no coords; we approximate via the observatory name). */}
          {showVolcanoes && volcanoes.map(v => {
            // Rough observatory centroids until we wire a proper volcano coord DB.
            const obs = v.observatory || ''
            const coord = obs.includes('Alaska')  ? [56.0, -159.0]
                        : obs.includes('Hawaii') || obs.includes('Hawaiian') ? [19.4, -155.3]
                        : obs.includes('Cascade') ? [46.2, -121.5]
                        : [39, -96]  // fallback, CONUS center
            return (
              <Marker key={`volc-${v.vnum}`} position={coord} icon={volcanoIcon(v.colorCode)}>
                <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                  <b>{v.name}</b><br />
                  {v.colorCode} · {v.alertLevel}<br />
                  {v.observatory}<br />
                  <span style={{ color: '#888', fontSize: 9 }}>(approx loc — HANS feed has no coords)</span>
                </span></Tooltip>
              </Marker>
            )
          })}

          {/* NPS webcams — click opens the full cam page */}
          {showWebcams && webcams.map(c => (
            <Marker key={`cam-${c.id}`} position={[c.lat, c.lon]} icon={webcamIcon(c.isStreaming)}
              eventHandlers={{ click: () => window.open(c.url, '_blank', 'noopener') }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>{c.title}</b><br />
                {c.park} ({c.parkState})<br />
                {c.isStreaming ? <span style={{ color: '#8abeb7' }}>streaming</span> : 'snapshot'}
                <br /><span style={{ color: '#888' }}>click to open</span>
              </span></Tooltip>
            </Marker>
          ))}

        </MapContainer>
      </div>

      {/* Weather-delay causation + Sector congestion panels */}
      {/* Weather-delay causation + Sector congestion — only render when there's data */}
      {(() => {
        const hasWxDelay = (weatherDelays?.predictions?.length > 0) || (weatherDelays?.confirmed?.some(c => c.hasWeatherCause))
        const hasSectors = sectorData.length > 0
        if (!hasWxDelay && !hasSectors) return null

        return (
          <div className={clsx('grid gap-px bg-border', hasWxDelay && hasSectors ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1')}>
            {hasWxDelay && (
              <div className="bg-bg1 p-2">
                <div className="text-[9px] text-fg3/50 uppercase mb-1.5 flex items-center gap-2">
                  <span>Weather → Delay Causation</span>
                  {weatherDelays?.predictions?.length > 0 && (
                    <span className="text-ylw text-[8px] animate-pulse">{weatherDelays.predictions.length} predicted</span>
                  )}
                </div>

                {weatherDelays?.predictions?.length > 0 && (
                  <div className="mb-2">
                    <div className="text-[8px] text-ylw/70 uppercase mb-0.5">Predicted delays</div>
                    {weatherDelays.predictions.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex items-center gap-2 text-[9px] py-0.5 border-b border-ylw/10 bg-ylw/3 px-1 rounded mb-0.5">
                        <span className="text-acc w-10 shrink-0">{p.airport?.replace(/^K/, '')}</span>
                        <span className="text-ylw">{p.weatherType?.replace(/_/g, ' ')}</span>
                        <span className="text-fg3">{p.eventCount} events</span>
                        <span className={`ml-auto ${p.probability > 0.6 ? 'text-red' : 'text-ylw'}`}>
                          {Math.round(p.probability * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {weatherDelays?.confirmed?.some(c => c.hasWeatherCause) && (
                  <div>
                    <div className="text-[8px] text-fg3/40 uppercase mb-0.5">Active flow programs with weather</div>
                    {weatherDelays.confirmed.filter(c => c.hasWeatherCause).slice(0, 8).map((c, i) => (
                      <div key={i} className="flex items-center gap-2 text-[9px] py-0.5 border-b border-white/3">
                        <span className={`w-8 shrink-0 ${c.flowType === 'GS' ? 'text-red' : 'text-ylw'}`}>{c.flowType}</span>
                        <span className="text-acc w-10 shrink-0">{c.airport?.replace(/^K/, '')}</span>
                        <span className="text-fg2">{c.weather[0]?.type?.replace(/_/g, ' ')}{c.weather[0]?.offsetMin ? ` (${c.weather[0].offsetMin}m before)` : ''}</span>
                        {c.delayMin > 0 && <span className="text-fg3/50 ml-auto tabular-nums">{Math.round(c.delayMin)}m</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {hasSectors && (
              <div className="bg-bg1 p-2">
                <div className="text-[9px] text-fg3/50 uppercase mb-1.5">ARTCC Sector Load</div>
                <div>
                  <div className="flex items-center gap-1 text-[7px] text-fg3/40 mb-0.5 px-1">
                    <span className="w-10 shrink-0">ARTCC</span>
                    <span className="w-12 shrink-0 text-right">flights</span>
                    <span className="w-10 shrink-0 text-right">sectors</span>
                    <span className="flex-1 ml-2">load</span>
                  </div>
                  {sectorData.map((s, i) => {
                    const load = s.total_flights || 0
                    const maxLoad = Math.max(...sectorData.map(x => x.total_flights || 1))
                    const pct = Math.round((load / maxLoad) * 100)
                    const color = load > 100 ? 'bg-red/60' : load > 50 ? 'bg-ylw/60' : 'bg-grn/60'
                    return (
                      <div key={i} className="flex items-center gap-1 text-[9px] py-0.5 px-1 border-b border-white/3">
                        <span className="text-acc w-10 shrink-0">{s.artcc}</span>
                        <span className="text-fg2 w-12 shrink-0 text-right tabular-nums">{s.total_flights}</span>
                        <span className="text-fg3 w-10 shrink-0 text-right tabular-nums">{s.active_sectors}</span>
                        <div className="flex-1 ml-2 h-2 bg-bg2 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {trackedFlights.length > 0 && <style>{`
        .tracked-label {
          background: rgba(13,13,13,0.75) !important;
          border: 1px solid rgba(255,255,255,0.08) !important;
          box-shadow: none !important;
          padding: 1px 5px !important;
          border-radius: 1px !important;
        }
        .tracked-label::before { display: none !important; }
      `}</style>}
    </div>
  )
}
