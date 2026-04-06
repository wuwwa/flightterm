import { useState, useEffect, useMemo, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Polyline, Polygon, Marker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'
import AIRPORTS from '../../data/airports'
import axios from 'axios'
import { fetchSigmets, fetchPireps } from '../../services/weather'
import { fetchAnomalyFeed, fetchAnomalyHotspots } from '../../services/dashboard'

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

// ── Style constants ─────────────────────────────────────────────────────────

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

// ── Layer toggle button ─────────────────────────────────────────────────────

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

// ── Main component ──────────────────────────────────────────────────────────

export default function NasMap({ backendOk, onSelectAirport }) {
  const { nasSummary, flights, flowEvents } = useSwim()

  // Layer toggles
  const [showFlights, setShowFlights] = useState(false)
  const [showCascades, setShowCascades] = useState(true)
  const [showSigmets, setShowSigmets] = useState(true)
  const [showPireps, setShowPireps] = useState(false)
  const [showTfrs, setShowTfrs] = useState(true)
  const [showAnomalies, setShowAnomalies] = useState(true)
  const [showWxCells, setShowWxCells] = useState(false)

  // Fetched data
  const [sigmets, setSigmets] = useState([])
  const [pireps, setPireps] = useState([])
  const [tfrs, setTfrs] = useState([])
  const [anomalies, setAnomalies] = useState([])
  const [hotspots, setHotspots] = useState([])
  const [terminalWx, setTerminalWx] = useState([])
  const [routeDeviations, setRouteDeviations] = useState([])

  // Fetch layers data (60s for weather, 30s for anomalies, 60s for TFRs)
  useEffect(() => {
    if (!backendOk) return
    let cancelled = false
    const refresh = () => {
      Promise.allSettled([
        fetchSigmets(),
        fetchPireps(24, -125, 50, -66, { age: 2 }),
        axios.get('/api/swim/tfrs').then(r => r.data),
        fetchAnomalyFeed(100),
        fetchAnomalyHotspots(168, 2),
        axios.get('/api/swim/weather', { params: { limit: 100 } }).then(r => r.data),
        axios.get('/api/swim/routes/deviations', { params: { limit: 15 } }).then(r => r.data),
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
      })
    }
    refresh()
    const id = setInterval(refresh, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

  const airports = nasSummary?.airports || []

  // ── Computed map data ─────────────────────────────────────────────────────

  const airportMarkers = useMemo(() =>
    airports.filter(a => AIRPORTS[a.airport]).map(a => ({ ...a, ...AIRPORTS[a.airport] })),
    [airports]
  )

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

  // Route deviation lines
  const devLines = useMemo(() =>
    routeDeviations.filter(d => d.avg_km > 30 && AIRPORTS[d.dep_arpt] && AIRPORTS[d.arr_arpt]).map(d => ({
      positions: [[AIRPORTS[d.dep_arpt].lat, AIRPORTS[d.dep_arpt].lon], [AIRPORTS[d.arr_arpt].lat, AIRPORTS[d.arr_arpt].lon]],
      ...d,
    })),
    [routeDeviations]
  )

  // Flight dots
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
        <span className="flex gap-1 items-center flex-wrap">
          <LayerBtn active={showTfrs} onClick={() => setShowTfrs(v => !v)} color="red" count={tfrPolys.length}>TFRs</LayerBtn>
          <LayerBtn active={showSigmets} onClick={() => setShowSigmets(v => !v)} color="ylw" count={sigmetPolys.length}>WX</LayerBtn>
          <LayerBtn active={showPireps} onClick={() => setShowPireps(v => !v)} color="cyn" count={pirepPoints.length}>PIREPs</LayerBtn>
          <LayerBtn active={showAnomalies} onClick={() => setShowAnomalies(v => !v)} color="red" count={anomalyPoints.length}>anomalies</LayerBtn>
          <LayerBtn active={showWxCells} onClick={() => setShowWxCells(v => !v)} color="mag" count={wxPoints.length}>ITWS</LayerBtn>
          <LayerBtn active={showCascades} onClick={() => setShowCascades(v => !v)} color="red">cascades</LayerBtn>
          <LayerBtn active={showFlights} onClick={() => setShowFlights(v => !v)} color="acc">flights</LayerBtn>
        </span>
      </div>

      <div style={{ height: '340px' }}>
        <MapContainer center={[39, -96]} zoom={4} className="h-full w-full" style={{ background: '#1a1a1a' }} zoomControl={false}>
          <MapInvalidator />
          <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />

          {/* ── Layer 1: SIGMET polygons (weather hazards) ──────────────────── */}
          {showSigmets && sigmetPolys.map((s, i) => (
            <Polygon key={`sig-${i}`} positions={s.coords}
              pathOptions={SIGMET_STYLE[s.hazard] || SIGMET_STYLE.TURB}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {s.type} — {s.hazard}<br />{s.raw}
              </span></Tooltip>
            </Polygon>
          ))}

          {/* ── Layer 2: TFR polygons (airspace restrictions) ───────────────── */}
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

          {/* ── Layer 3: Flow restriction geometry (FXA, RSTR areas) ────────── */}
          {flowPolys.map((p, i) => (
            <Polygon key={`flow-${i}`} positions={p.coords} pathOptions={FLOW_GEOM_STYLE}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {p.event_type} {p.facility || ''}<br />
                {p.ceiling && `FL${p.floor || '?'}–${p.ceiling} `}
                {p.text?.substring(0, 60) || ''}
              </span></Tooltip>
            </Polygon>
          ))}

          {/* ── Layer 4: Route deviation corridors ──────────────────────────── */}
          {devLines.map((d, i) => (
            <Polyline key={`dev-${i}`} positions={d.positions}
              pathOptions={{ color: '#f0c674', weight: 2, opacity: 0.4, dashArray: '8 4' }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {d.dep_arpt?.replace(/^K/, '')} → {d.arr_arpt?.replace(/^K/, '')}<br />
                {d.flights} flights, avg {d.avg_km}km off-route
              </span></Tooltip>
            </Polyline>
          ))}

          {/* ── Layer 5: Cascade impact lines ────────────────────────────────── */}
          {cascadeLines.map((line, i) => (
            <Polyline key={`cas-${i}`} positions={line.positions}
              pathOptions={{ color: '#cc6666', weight: 1.5, opacity: 0.3 }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {line.origin?.replace(/^K/, '')} → {line.airport?.replace(/^K/, '')} (held)
              </span></Tooltip>
            </Polyline>
          ))}

          {/* ── Layer 6: PIREPs (turbulence/icing reports) ──────────────────── */}
          {showPireps && pirepPoints.map((p, i) => (
            <Marker key={`pirep-${i}`} position={[p.lat, p.lon]} icon={pirepIcon(p.turb || p.ice)}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                PIREP FL{p.fl || '?'} {p.acType || ''}<br />
                {p.turb && `turb: ${p.turb} `}{p.ice && `ice: ${p.ice}`}
              </span></Tooltip>
            </Marker>
          ))}

          {/* ── Layer 7: Terminal weather (ITWS cells) ───────────────────────── */}
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

          {/* ── Layer 8: Anomaly hotspot circles ─────────────────────────────── */}
          {showAnomalies && hotspotCircles.map((h, i) => (
            <CircleMarker key={`hs-${i}`} center={[h.lat, h.lon]}
              radius={Math.min(20, 6 + (h.count || 1) * 2)}
              pathOptions={{ color: '#cc6666', fillColor: '#cc6666', fillOpacity: 0.08, weight: 1, dashArray: '3 3' }}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                hotspot: {h.count} anomalies in 7d
              </span></Tooltip>
            </CircleMarker>
          ))}

          {/* ── Layer 9: Anomaly aircraft markers ────────────────────────────── */}
          {showAnomalies && anomalyPoints.map((a, i) => (
            <Marker key={`anom-${i}`} position={[a.lat, a.lon]} icon={anomalyIcon(a.severity, a.hdg)}>
              <Tooltip><span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>{a.callsign || a.icao}</b> [{a.severity}] {a.score}<br />
                {a.reasons?.slice(0, 3).join('; ')}
              </span></Tooltip>
            </Marker>
          ))}

          {/* ── Layer 10: Flight positions ────────────────────────────────────── */}
          {flightDots.map(f => (
            <CircleMarker key={f.icao} center={[f.lat, f.lon]} radius={1.5}
              pathOptions={{ color: '#81a2be', fillColor: '#81a2be', fillOpacity: 0.5, weight: 0 }} />
          ))}

          {/* ── Layer 11: Airport markers (always on, top layer) ──────────────── */}
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
    </div>
  )
}
