import { useState, useEffect, useRef } from 'react'
import { MapContainer, Marker, Circle, Polygon, Rectangle, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { fetchAnomalyFeed, fetchAnomalyHotspots } from '../../services/dashboard'
import { fetchSigmets, fetchPireps } from '../../services/weather'
import { REGIONS } from '../../services/opensky'
import OpenFreeMapLayer from '../OpenFreeMapLayer'

const REGION_CENTERS = {
  usa:      [38, -96],
  europe:   [50, 15],
  asia:     [35, 110],
  atlantic: [35, -40],
  global:   [30, 0],
}

const REGION_BBOX = {
  usa:      [24, -125, 49.5, -66],
  europe:   [35, -10, 71, 40],
  asia:     [10, 70, 55, 145],
  atlantic: [10, -70, 60, -10],
}

const SEV_COLORS = {
  CRITICAL: '#ff3333',
  HIGH:     '#ffcc00',
  MEDIUM:   '#888888',
}

const SIGMET_STYLE = {
  CONVECTIVE: { color: '#ff3333', fillColor: '#ff3333', fillOpacity: 0.12 },
  TURB:       { color: '#ffcc00', fillColor: '#ffcc00', fillOpacity: 0.10 },
  ICE:        { color: '#00ccff', fillColor: '#00ccff', fillOpacity: 0.10 },
}

const PIREP_COLORS = {
  SEV: '#ff3333', EXTRM: '#ff3333', 'MOD-SEV': '#ff6600', MOD: '#ffcc00', 'LGT-MOD': '#888',
}

function pirepIcon(intensity) {
  const color = PIREP_COLORS[intensity] || PIREP_COLORS.MOD
  return L.divIcon({
    html: `<svg width="10" height="10" viewBox="0 0 10 10">
      <polygon points="5,1 9,5 5,9 1,5" fill="${color}" stroke="#0d0d0d" stroke-width="0.6" opacity="0.85"/>
    </svg>`,
    className: '',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  })
}

const PLANE_PATH = 'M10 2 L12.5 8 L18 9.5 L12.5 11 L13 17 L10 15 L7 17 L7.5 11 L2 9.5 L7.5 8 Z'

function planeIcon(hdg = 0, severity = 'MEDIUM', resolved = false) {
  const color = resolved ? '#555555' : (SEV_COLORS[severity] || SEV_COLORS.MEDIUM)
  const s = severity === 'CRITICAL' ? 24 : severity === 'HIGH' ? 20 : 16
  const h = s / 2
  const opacity = resolved ? 0.4 : 1
  return L.divIcon({
    html: `<svg width="${s}" height="${s}" viewBox="0 0 20 20" style="transform:rotate(${hdg}deg);opacity:${opacity}">
      <path d="${PLANE_PATH}" fill="${color}" stroke="#0d0d0d" stroke-width="0.8"/>
    </svg>`,
    className: '',
    iconSize: [s, s],
    iconAnchor: [h, h],
  })
}

function AutoBounds({ points }) {
  const map = useMap()
  const fitted = useRef(false)

  useEffect(() => {
    if (points.length < 2 || fitted.current) return
    const bounds = points.map(p => [p.lat, p.lon])
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 7 })
    fitted.current = true
  }, [map, points])

  return null
}

// ── Search boundary overlay ─────────────────────────────────────────────────
// Shows where data is being fetched from. Pulses briefly on each refresh.
function SearchBoundary({ region, lastFetchAt }) {
  const [opacity, setOpacity] = useState(0.25)

  // Pulse on refresh: flash bright then fade
  useEffect(() => {
    if (!lastFetchAt) return
    setOpacity(0.4)
    const t1 = setTimeout(() => setOpacity(0.15), 1500)
    const t2 = setTimeout(() => setOpacity(0.08), 3000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [lastFetchAt])

  if (!REGIONS[region]?.bbox) return null

  const b = REGIONS[region].bbox
  return (
    <Rectangle
      bounds={[[b.lamin, b.lomin], [b.lamax, b.lomax]]}
      pathOptions={{
        color: '#33ff66',
        fillColor: 'transparent',
        fillOpacity: 0,
        weight: 1,
        opacity: opacity,
        dashArray: '8 4',
      }}
    />
  )
}

export default function HeatMap({ backendOk, region = 'usa', lastFetchAt, onSelect }) {
  const [anomalies, setAnomalies] = useState([])
  const [hotspots, setHotspots] = useState([])
  const [sigmets, setSigmets] = useState([])
  const [pireps, setPireps] = useState([])
  const [loading, setLoading] = useState(false)
  const [showWx, setShowWx] = useState(true)
  const [showPireps, setShowPireps] = useState(false)
  const [showBounds, setShowBounds] = useState(true)
  const [showHotspots, setShowHotspots] = useState(false)
  const [sevFilter, setSevFilter] = useState({ CRITICAL: true, HIGH: true, MEDIUM: true })

  const refresh = () => {
    if (!backendOk) return
    setLoading(true)
    const bbox = REGION_BBOX[region] || REGION_BBOX.usa
    Promise.all([
      fetchAnomalyFeed(50).catch(() => []),
      fetchAnomalyHotspots(24, 2).catch(() => []),
      fetchSigmets().catch(() => []),
      fetchPireps(bbox[0], bbox[1], bbox[2], bbox[3], { age: 2, inten: 'mod' }).catch(() => []),
    ]).then(([a, h, s, p]) => {
      setAnomalies(a)
      setHotspots(h)
      setSigmets(s)
      setPireps(p)
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!backendOk) return
    refresh()
    const id = setInterval(refresh, 60_000)
    return () => clearInterval(id)
  }, [backendOk, region])

  const allPoints = anomalies.filter(a => a.lat != null && a.lon != null)
  const points = allPoints.filter(a => sevFilter[a.severity] !== false)
  const center = REGION_CENTERS[region] || REGION_CENTERS.usa

  // SIGMET polygons with valid coords
  const sigmetPolys = sigmets.filter(s => s.coords?.length >= 3).map(s => ({
    coords: s.coords.map(c => [c.lat, c.lon]),
    hazard: s.hazard,
    type: s.airSigmetType,
    raw: s.rawAirSigmet?.substring(0, 80),
  }))

  // PIREPs with location
  const pirepPoints = pireps.filter(p => p.lat != null && p.lon != null).map(p => ({
    lat: p.lat,
    lon: p.lon,
    turb: p.tbInt1 || null,
    ice: p.icgInt1 || null,
    fl: p.fltLvl,
    acType: p.acType,
  }))

  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0 }
  for (const p of allPoints) counts[p.severity] = (counts[p.severity] || 0) + 1

  const sourceLabel = 'opensky'

  return (
    <div className="bg-bg1">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex flex-wrap gap-y-0.5 justify-between items-center">
        <span className="mr-2">anomaly map</span>
        <span className="flex flex-wrap gap-1.5 items-center">
          <button
            onClick={() => setShowBounds(b => !b)}
            className={`px-1.5 py-px border rounded transition-colors ${showBounds ? 'border-mag/50 text-mag' : 'border-border text-fg3'}`}
          >
            {showBounds ? sourceLabel : 'SCAN'}
          </button>
          <button
            onClick={() => setShowHotspots(h => !h)}
            className={`px-1.5 py-px border rounded transition-colors ${showHotspots ? 'border-mag/50 text-mag' : 'border-border text-fg3'}`}
          >
            <span className="hidden sm:inline">hotspots</span><span className="sm:hidden">HS</span> {hotspots.length > 0 ? `(${hotspots.length})` : ''}
          </button>
          <button
            onClick={() => setShowWx(w => !w)}
            className={`px-1.5 py-px border rounded transition-colors ${showWx ? 'border-acc/50 text-acc' : 'border-border text-fg3'}`}
          >
            WX {showWx ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={() => setShowPireps(p => !p)}
            className={`px-1.5 py-px border rounded transition-colors ${showPireps ? 'border-ylw/50 text-ylw' : 'border-border text-fg3'}`}
          >
            <span className="hidden sm:inline">PIREPs</span><span className="sm:hidden">PR</span> {showPireps ? 'ON' : 'OFF'}
          </button>
          {showWx && sigmetPolys.length > 0 && (
            <span className="hidden sm:inline"><span className="text-red">{sigmetPolys.length}</span> SIGMET{sigmetPolys.length !== 1 ? 's' : ''}</span>
          )}
          {showPireps && pirepPoints.length > 0 && (
            <span className="hidden sm:inline"><span className="text-ylw">{pirepPoints.length}</span> PIREP{pirepPoints.length !== 1 ? 's' : ''}</span>
          )}
          <span className="flex gap-0 border border-border rounded overflow-hidden">
            {[
              { key: 'CRITICAL', label: 'crit', on: 'bg-red/20 text-red', color: 'text-red' },
              { key: 'HIGH', label: 'high', on: 'bg-ylw/20 text-ylw', color: 'text-ylw' },
              { key: 'MEDIUM', label: 'med', on: 'bg-fg3/20 text-fg3', color: 'text-fg3' },
            ].map(s => (
              <button
                key={s.key}
                onClick={() => setSevFilter(prev => ({ ...prev, [s.key]: !prev[s.key] }))}
                className={`px-1 py-px text-[9px] border-none cursor-pointer ${sevFilter[s.key] ? s.on : 'bg-transparent text-fg3/30'}`}
                title={`${sevFilter[s.key] ? 'Hide' : 'Show'} ${s.key} anomalies`}
              >
                {s.label} {counts[s.key] > 0 ? counts[s.key] : ''}
              </button>
            ))}
          </span>
          <span>
            {points.length > 0 ? (
              <span>{points.length} anomal{points.length !== 1 ? 'ies' : 'y'}</span>
            ) : (
              <span className="text-grn">clear</span>
            )}
          </span>
          {loading && <span className="text-fg3">...</span>}
        </span>
      </div>
      <div className="h-96 relative">
        <MapContainer
          center={center}
          zoom={4}
          scrollWheelZoom={false}
          zoomControl={true}
          attributionControl
          style={{ height: '100%', width: '100%', background: '#0d0d0d' }}
        >
          <OpenFreeMapLayer opacity={0.6} />
          <AutoBounds points={points} />

          {/* Search boundaries — rendered first (behind everything) */}
          {showBounds && (
            <SearchBoundary
              region={region}
              lastFetchAt={lastFetchAt}
            />
          )}

          {/* Anomaly hotspots — circles colored by deviation from baseline */}
          {showHotspots && hotspots.map((h, i) => {
            // If baseline exists, color by deviation (how unusual vs history)
            // If no baseline yet, fall back to relative frequency
            let color, intensity
            if (h.deviation != null) {
              // deviation: 1.0 = normal, 2.0 = 2x above baseline, etc.
              intensity = Math.min(1, (h.deviation - 1) / 4) // 1x→0, 5x+→1
              color = h.deviation >= 3 ? '#ff3333' : h.deviation >= 1.5 ? '#ff8800' : '#cc66ff'
            } else {
              // No baseline — use relative frequency
              const maxCount = Math.max(...hotspots.map(x => x.count), 1)
              intensity = h.count / maxCount
              color = intensity > 0.6 ? '#ff3333' : intensity > 0.3 ? '#ff8800' : '#cc66ff'
            }
            const fillOpacity = 0.05 + intensity * 0.1
            const radius = Math.min(80000, 25000 + h.count * 5000)
            return (
              <Circle
                key={`hs-${i}`}
                center={[h.lat, h.lon]}
                radius={radius}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity,
                  weight: 1.5,
                  opacity: 0.4 + intensity * 0.4,
                  dashArray: '6 3',
                }}
              >
                <Tooltip direction="top" sticky>
                  <div style={{ fontSize: '10px', lineHeight: '1.4', fontFamily: 'monospace' }}>
                    <div><strong>HOTSPOT</strong> — {h.count} events (24h)</div>
                    {h.airport_city && <div><strong>{h.airport_city}, {h.airport_state}</strong> · {h.nearest_airport} ({h.airport_dist_km}km)</div>}
                    {!h.airport_city && h.nearest_airport && <div>near <strong>{h.nearest_airport}</strong> ({h.airport_dist_km}km)</div>}
                    <div>{h.unique_aircraft} unique aircraft</div>
                    {h.deviation != null ? (
                      <div style={{ color: h.deviation >= 3 ? '#ff3333' : h.deviation >= 1.5 ? '#ff8800' : '#aaa' }}>
                        {h.deviation}x vs baseline ({h.baseline_avg}/day avg)
                      </div>
                    ) : (
                      <div style={{ opacity: 0.5 }}>building baseline... ({h.baseline_days}d data)</div>
                    )}
                    <div style={{ opacity: 0.7 }}>{h.categories.join(', ')}</div>
                    <div style={{ opacity: 0.5 }}>last: {new Date(h.last_seen).toLocaleString()}</div>
                  </div>
                </Tooltip>
              </Circle>
            )
          })}

          {/* SIGMET polygons */}
          {showWx && sigmetPolys.map((s, i) => {
            const style = SIGMET_STYLE[s.hazard] || SIGMET_STYLE.TURB
            return (
              <Polygon
                key={`sig-${i}`}
                positions={s.coords}
                pathOptions={{
                  color: style.color,
                  fillColor: style.fillColor,
                  fillOpacity: style.fillOpacity,
                  weight: 1.5,
                  opacity: 0.6,
                  dashArray: '4 4',
                }}
              >
                <Tooltip direction="top" sticky>
                  <div style={{ fontSize: '10px', lineHeight: '1.3', fontFamily: 'monospace' }}>
                    <div><strong>{s.type}</strong> — {s.hazard}</div>
                    {s.raw && <div style={{ opacity: 0.7, maxWidth: 250 }}>{s.raw}</div>}
                  </div>
                </Tooltip>
              </Polygon>
            )
          })}

          {/* PIREP markers — small diamonds */}
          {showPireps && pirepPoints.map((p, i) => {
            const intensity = p.turb || p.ice || 'MOD'
            return (
              <Marker
                key={`pirep-${i}`}
                position={[p.lat, p.lon]}
                icon={pirepIcon(intensity)}
              >
                <Tooltip direction="top" offset={[0, -6]}>
                  <div style={{ fontSize: '10px', lineHeight: '1.3', fontFamily: 'monospace' }}>
                    <div><strong>PIREP</strong> FL{p.fl || '???'} {p.acType || ''}</div>
                    {p.turb && <div>Turbulence: {p.turb}</div>}
                    {p.ice && <div>Icing: {p.ice}</div>}
                  </div>
                </Tooltip>
              </Marker>
            )
          })}

          {/* Anomaly aircraft — on top */}
          {points.map((a, i) => (
            <Marker
              key={a.id || i}
              position={[a.lat, a.lon]}
              icon={planeIcon(a.hdg || 0, a.severity, a.resolved)}
              zIndexOffset={a.resolved ? 500 : 1000}
              eventHandlers={{ click: () => onSelect?.(a) }}
            >
              <Tooltip direction="top" offset={[0, -10]}>
                <div style={{ fontSize: '10px', lineHeight: '1.3', fontFamily: 'monospace' }}>
                  <div><strong>{a.icao}</strong> {a.callsign || ''}</div>
                  <div>{a.severity} · score {a.score}</div>
                  {a.airport_city && <div>{a.airport_city}, {a.airport_state} · {a.nearest_airport} ({a.airport_dist_km}km)</div>}
                  {!a.airport_city && a.nearest_airport && <div>near {a.nearest_airport} ({a.airport_dist_km}km)</div>}
                  {a.category && <div>{a.category}</div>}
                  {a.reasons?.[0] && <div style={{ opacity: 0.7 }}>{a.reasons[0]}</div>}
                </div>
              </Tooltip>
            </Marker>
          ))}
        </MapContainer>
        {/* Legend */}
        <div className="absolute bottom-1.5 right-1.5 z-500 bg-bg1/85 border border-border rounded px-2 py-1 text-[8px] leading-relaxed font-mono pointer-events-none">
          <div className="flex items-center gap-1.5">
            <svg width="10" height="10" viewBox="0 0 20 20"><path d={PLANE_PATH} fill="#ff3333" stroke="#0d0d0d" strokeWidth="0.8"/></svg>
            <span className="text-red">critical</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width="10" height="10" viewBox="0 0 20 20"><path d={PLANE_PATH} fill="#ffcc00" stroke="#0d0d0d" strokeWidth="0.8"/></svg>
            <span className="text-ylw">high</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width="10" height="10" viewBox="0 0 20 20"><path d={PLANE_PATH} fill="#888888" stroke="#0d0d0d" strokeWidth="0.8"/></svg>
            <span className="text-fg3">medium</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width="10" height="10" viewBox="0 0 20 20"><path d={PLANE_PATH} fill="#555555" stroke="#0d0d0d" strokeWidth="0.8" opacity="0.4"/></svg>
            <span className="text-fg3/50">resolved</span>
          </div>
          {showHotspots && hotspots.length > 0 && (
            <div className="mt-0.5 border-t border-white/5 pt-0.5">
              <div className="flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="none" stroke="#cc66ff" strokeWidth="1" strokeDasharray="2 1" opacity="0.7"/></svg>
                <span className="text-mag">normal</span>
              </div>
              <div className="flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="none" stroke="#ff8800" strokeWidth="1" strokeDasharray="2 1" opacity="0.7"/></svg>
                <span style={{ color: '#ff8800' }}>1.5x+ baseline</span>
              </div>
              <div className="flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="none" stroke="#ff3333" strokeWidth="1" strokeDasharray="2 1" opacity="0.7"/></svg>
                <span className="text-red">3x+ baseline</span>
              </div>
            </div>
          )}
          {showWx && (
            <div className="mt-0.5 border-t border-white/5 pt-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-red">---</span>
                <span className="text-red">SIGMET convective</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-ylw">---</span>
                <span className="text-ylw">SIGMET turb</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-cyn">---</span>
                <span className="text-cyn">SIGMET ice</span>
              </div>
            </div>
          )}
          {showPireps && (
            <div className={`${showWx ? '' : 'mt-0.5 border-t border-white/5 pt-0.5'}`}>
              <div className="flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="5,1 9,5 5,9 1,5" fill="#ffcc00" stroke="#0d0d0d" strokeWidth="0.6"/></svg>
                <span className="text-ylw">PIREP</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
