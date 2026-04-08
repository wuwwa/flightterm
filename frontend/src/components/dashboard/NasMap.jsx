import { useState, useEffect, useMemo, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Polyline, Polygon, Marker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'
import AIRPORTS from '../../data/airports'
import axios from 'axios'
import { fetchSigmets, fetchPireps } from '../../services/weather'
import { fetchAnomalyFeed, fetchAnomalyHotspots, fetchFlightPositions, fetchSurfacePositions } from '../../services/dashboard'

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
  const c = hasRwy ? '#ff6633' : '#cc9933'
  const sz = count > 10 ? 12 : count > 5 ? 10 : 8
  return L.divIcon({
    html: `<svg width="${sz}" height="${sz}" viewBox="0 0 16 16">
      <rect x="1" y="1" width="14" height="14" rx="2" fill="${c}" fill-opacity="0.7" stroke="#0d0d0d" stroke-width="0.8"/>
      <text x="8" y="12" text-anchor="middle" font-size="9" font-weight="bold" fill="#0d0d0d">N</text>
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

export default function NasMap({ backendOk, onSelectAirport }) {
  const { nasSummary, flights, flowEvents, notamAirports } = useSwim()

  // Layer toggles — default OFF for busy layers, ON for key operational layers
  const [showIfrPositions, setShowIfrPositions] = useState(false)
  const [showFlights, setShowFlights] = useState(false)
  const [showCascades, setShowCascades] = useState(true)
  const [showSigmets, setShowSigmets] = useState(true)
  const [showPireps, setShowPireps] = useState(false)
  const [showTfrs, setShowTfrs] = useState(true)
  const [showAnomalies, setShowAnomalies] = useState(true)
  const [showWxCells, setShowWxCells] = useState(false)
  const [showNotams, setShowNotams] = useState(false)
  const [showFlowPrograms, setShowFlowPrograms] = useState(true)
  const [showTracon, setShowTracon] = useState(false)
  const [showRouteDevs, setShowRouteDevs] = useState(true)

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

  // Fetch all map layer data (staggered refresh)
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
    const id = setInterval(refresh, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

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

  // Terminal weather markers
  const wxPoints = useMemo(() =>
    terminalWx.filter(w => w.lat != null && w.lon != null && (w.severity === 'CRITICAL' || w.severity === 'HIGH')),
    [terminalWx]
  )

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

  // Counts for toggle buttons
  const gsCount = airports.filter(a => a.hasGS).length
  const gdpCount = airports.filter(a => a.hasGDP).length

  return (
    <div className="bg-bg1">
      {/* Controls */}
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex flex-wrap gap-1 justify-between items-center">
        <span className="flex items-center gap-1.5">
          <span>US airspace</span>
          {gsCount > 0 && <span className="text-red font-bold animate-pulse">GS:{gsCount}</span>}
          {gdpCount > 0 && <span className="text-ylw font-bold">GDP:{gdpCount}</span>}
        </span>
        <span className="flex gap-2 items-center flex-wrap">
          {/* Weather group */}
          <span className="flex gap-1 items-center">
            <span className="text-fg3/40 text-[7px] uppercase tracking-wide">wx</span>
            <LayerBtn active={showTfrs} onClick={() => setShowTfrs(v => !v)} color="red" count={tfrPolys.length}>TFRs</LayerBtn>
            <LayerBtn active={showSigmets} onClick={() => setShowSigmets(v => !v)} color="ylw" count={sigmetPolys.length}>WX</LayerBtn>
            <LayerBtn active={showPireps} onClick={() => setShowPireps(v => !v)} color="cyn" count={pirepPoints.length}>PIREPs</LayerBtn>
            <LayerBtn active={showWxCells} onClick={() => setShowWxCells(v => !v)} color="mag" count={wxPoints.length}>ITWS</LayerBtn>
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
        </span>
      </div>

      <div style={{ height: 'min(78vh, 760px)', minHeight: 520 }}>
        <MapContainer center={[39, -96]} zoom={4} className="h-full w-full" style={{ background: '#1a1a1a' }} zoomControl={true} scrollWheelZoom={false} attributionControl={false}>
          <MapInvalidator />
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

          {/* ── Terminal weather (ITWS cells) ─────────────────────────────── */}
          {showWxCells && wxPoints.map((w, i) => (
            <CircleMarker key={`wx-${i}`} center={[w.lat, w.lon]} radius={5}
              pathOptions={{
                color: w.severity === 'CRITICAL' ? '#ff3333' : '#ffcc00',
                fillColor: w.severity === 'CRITICAL' ? '#ff3333' : '#ffcc00',
                fillOpacity: 0.4, weight: 1,
              }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {w.event_type?.replace(/_/g, ' ')} [{w.severity}]<br />
                {w.airport || w.site || '—'}: {w.text?.substring(0, 60) || ''}
              </span></Tooltip>
            </CircleMarker>
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
                    <span className="text-ylw text-[8px] font-bold animate-pulse">{weatherDelays.predictions.length} predicted</span>
                  )}
                </div>

                {weatherDelays?.predictions?.length > 0 && (
                  <div className="mb-2">
                    <div className="text-[8px] text-ylw/70 uppercase mb-0.5">Predicted delays</div>
                    {weatherDelays.predictions.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex items-center gap-2 text-[9px] py-0.5 border-b border-ylw/10 bg-ylw/3 px-1 rounded mb-0.5">
                        <span className="text-acc font-bold w-10 shrink-0">{p.airport?.replace(/^K/, '')}</span>
                        <span className="text-ylw">{p.weatherType?.replace(/_/g, ' ')}</span>
                        <span className="text-fg3">{p.eventCount} events</span>
                        <span className={`ml-auto font-bold ${p.probability > 0.6 ? 'text-red' : 'text-ylw'}`}>
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
                        <span className={`font-bold w-8 shrink-0 ${c.flowType === 'GS' ? 'text-red' : 'text-ylw'}`}>{c.flowType}</span>
                        <span className="text-acc font-bold w-10 shrink-0">{c.airport?.replace(/^K/, '')}</span>
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
                        <span className="text-acc font-bold w-10 shrink-0">{s.artcc}</span>
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
    </div>
  )
}
