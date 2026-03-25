import { useState, useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Polygon, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { fetchAnomalyFeed } from '../../services/dashboard'
import { fetchSigmets, fetchPireps } from '../../services/weather'

const REGION_CENTERS = {
  usa:      [38, -96],
  europe:   [50, 15],
  asia:     [35, 110],
  atlantic: [35, -40],
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

function planeIcon(hdg = 0, severity = 'MEDIUM') {
  const color = SEV_COLORS[severity] || SEV_COLORS.MEDIUM
  const s = severity === 'CRITICAL' ? 24 : severity === 'HIGH' ? 20 : 16
  const h = s / 2
  return L.divIcon({
    html: `<svg width="${s}" height="${s}" viewBox="0 0 20 20" style="transform:rotate(${hdg}deg)">
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

export default function HeatMap({ backendOk, region = 'usa' }) {
  const [anomalies, setAnomalies] = useState([])
  const [sigmets, setSigmets] = useState([])
  const [pireps, setPireps] = useState([])
  const [loading, setLoading] = useState(false)
  const [showWx, setShowWx] = useState(true)

  const refresh = () => {
    if (!backendOk) return
    setLoading(true)
    const bbox = REGION_BBOX[region] || REGION_BBOX.usa
    Promise.all([
      fetchAnomalyFeed(50).catch(() => []),
      fetchSigmets().catch(() => []),
      fetchPireps(bbox[0], bbox[1], bbox[2], bbox[3], { age: 2, inten: 'mod' }).catch(() => []),
    ]).then(([a, s, p]) => {
      setAnomalies(a)
      setSigmets(s)
      setPireps(p)
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!backendOk) return
    refresh()
    const id = setInterval(refresh, 300_000) // 5 min — same as WeatherStatus
    return () => clearInterval(id)
  }, [backendOk])

  const points = anomalies.filter(a => a.lat != null && a.lon != null && !a.resolved)
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
  for (const p of points) counts[p.severity] = (counts[p.severity] || 0) + 1

  return (
    <div className="bg-bg1">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between items-center">
        <span>anomaly map</span>
        <span className="flex gap-2 items-center">
          <button
            onClick={() => setShowWx(w => !w)}
            className={`px-1.5 py-px border rounded transition-colors ${showWx ? 'border-acc/50 text-acc' : 'border-border text-fg3'}`}
          >
            WX {showWx ? 'ON' : 'OFF'}
          </button>
          {showWx && sigmetPolys.length > 0 && (
            <span><span className="text-red">{sigmetPolys.length}</span> SIGMET{sigmetPolys.length !== 1 ? 's' : ''}</span>
          )}
          {showWx && pirepPoints.length > 0 && (
            <span><span className="text-ylw">{pirepPoints.length}</span> PIREP{pirepPoints.length !== 1 ? 's' : ''}</span>
          )}
          {points.length > 0 ? (
            <span>{points.length} anomal{points.length !== 1 ? 'ies' : 'y'}</span>
          ) : (
            <span className="text-grn">clear</span>
          )}
          {loading && <span className="text-fg3">updating...</span>}
        </span>
      </div>
      <div className="h-64">
        <MapContainer
          center={center}
          zoom={4}
          scrollWheelZoom={true}
          zoomControl={false}
          attributionControl={false}
          style={{ height: '100%', width: '100%', background: '#0d0d0d' }}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            opacity={0.6}
          />
          <AutoBounds points={points} />

          {/* SIGMET polygons — rendered first (behind everything) */}
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
          {showWx && pirepPoints.map((p, i) => {
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
              icon={planeIcon(a.hdg || 0, a.severity)}
              zIndexOffset={1000}
            >
              <Tooltip direction="top" offset={[0, -10]}>
                <div style={{ fontSize: '10px', lineHeight: '1.3', fontFamily: 'monospace' }}>
                  <div><strong>{a.icao}</strong> {a.callsign || ''}</div>
                  <div>{a.severity} · score {a.score}</div>
                  {a.category && <div>{a.category}</div>}
                  {a.reasons?.[0] && <div style={{ opacity: 0.7 }}>{a.reasons[0]}</div>}
                </div>
              </Tooltip>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  )
}
