import { useMemo, useEffect } from 'react'
import { MapContainer, TileLayer, Polyline, Marker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// ── recenter map + invalidate size on container resize ──────────────────────
function MapUpdater({ center }) {
  const map = useMap()
  useEffect(() => {
    if (center) map.setView(center, map.getZoom(), { animate: true })
  }, [center?.[0], center?.[1]])

  useEffect(() => {
    const container = map.getContainer()
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(container)
    return () => ro.disconnect()
  }, [map])

  return null
}

// ── SVG icon factories ──────────────────────────────────────────────────────
function makeIcon(svg, size = [20, 20], anchor = [10, 10]) {
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: size,
    iconAnchor: anchor,
  })
}

// Selected plane — green
function planeIcon(hdg = 0) {
  return makeIcon(
    `<svg width="20" height="20" viewBox="0 0 20 20" style="transform:rotate(${hdg}deg)">
      <path d="M10 2 L12.5 8 L18 9.5 L12.5 11 L13 17 L10 15 L7 17 L7.5 11 L2 9.5 L7.5 8 Z"
            fill="#b5bd68" stroke="#1a1a1a" stroke-width="0.8"/>
    </svg>`,
    [20, 20],
    [10, 10]
  )
}

// Nearby plane — dim gray, smaller
function nearbyIcon(hdg = 0) {
  return makeIcon(
    `<svg width="14" height="14" viewBox="0 0 20 20" style="transform:rotate(${hdg}deg)">
      <path d="M10 2 L12.5 8 L18 9.5 L12.5 11 L13 17 L10 15 L7 17 L7.5 11 L2 9.5 L7.5 8 Z"
            fill="#888" stroke="#1a1a1a" stroke-width="0.8" opacity="0.7"/>
    </svg>`,
    [14, 14],
    [7, 7]
  )
}

// Start flag icon
const startIcon = makeIcon(
  `<svg width="14" height="18" viewBox="0 0 14 18">
    <line x1="2" y1="2" x2="2" y2="17" stroke="#888" stroke-width="1.5"/>
    <rect x="2" y="2" width="10" height="7" rx="1" fill="#888" opacity="0.7"/>
  </svg>`,
  [14, 18],
  [2, 17]
)

// ── deduplicate consecutive identical positions ──────────────────────────────
function dedup(pts) {
  if (pts.length === 0) return pts
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] !== pts[i - 1][0] || pts[i][1] !== pts[i - 1][1]) {
      out.push(pts[i])
    }
  }
  return out
}

export default function FlightMap({ snapshots, flight, flights, showNearby }) {
  // Build path from snapshots that have valid lat/lon
  const path = useMemo(() => {
    if (!snapshots) return []
    return snapshots
      .filter((s) => s.lat != null && s.lon != null)
      .map((s) => [s.lat, s.lon])
  }, [snapshots])

  // Current position from live flight object
  const currentPos =
    flight?.lat != null && flight?.lon != null ? [flight.lat, flight.lon] : null

  // Nearby flights (within ~100 mi / ~160 km of selected)
  const nearby = useMemo(() => {
    if (!showNearby || !flights || !currentPos) return []
    const [lat1, lon1] = currentPos
    const toRad = Math.PI / 180
    const R = 6371 // km
    const maxKm = 160
    return flights.filter((f) => {
      if (f.icao === flight.icao || f.lat == null || f.lon == null) return false
      const dLat = (f.lat - lat1) * toRad
      const dLon = (f.lon - lon1) * toRad
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * toRad) * Math.cos(f.lat * toRad) * Math.sin(dLon / 2) ** 2
      const d = 2 * R * Math.asin(Math.sqrt(a))
      return d <= maxKm
    })
  }, [showNearby, flights, currentPos?.[0], currentPos?.[1]])

  // If we have no position at all, show nothing
  if (!currentPos && path.length === 0) {
    return (
      <div className="py-4 px-2.5 text-center text-fg3 text-[10px]">
        no position data
      </div>
    )
  }

  // Full path: history + current, deduped
  const fullPath = dedup(currentPos ? [...path, currentPos] : path)

  // Center on current pos, or last known
  const center = currentPos || fullPath[fullPath.length - 1]

  // Start point
  const startPos = fullPath.length >= 2 ? fullPath[0] : null

  return (
    <div className="h-48 w-full border-t border-b border-border">
        <MapContainer
          center={center}
          zoom={8}
          className="h-full w-full"
          zoomControl={false}
          attributionControl={false}
          dragging={true}
          scrollWheelZoom={true}
          doubleClickZoom={true}
          touchZoom={true}
          key={flight?.icao}
        >
          <MapUpdater center={center} />
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />

          {/* Path taken — solid line */}
          {fullPath.length >= 2 && (
            <Polyline
              positions={fullPath}
              pathOptions={{ color: '#81a2be', weight: 2.5, opacity: 0.85 }}
            />
          )}

          {/* Starting point — flag icon */}
          {startPos && (
            <Marker position={startPos} icon={startIcon}>
              <Tooltip direction="bottom" offset={[0, 2]} className="flight-map-tooltip">
                first seen
              </Tooltip>
            </Marker>
          )}

          {/* Current position — green plane */}
          {currentPos && (
            <Marker position={currentPos} icon={planeIcon(flight?.hdg ?? 0)}>
              <Tooltip direction="top" offset={[0, -12]} permanent className="flight-map-tooltip">
                {flight.callsign || flight.icao}
                {flight.alt != null ? ` · ${Math.round(flight.alt)}m` : ''}
              </Tooltip>
            </Marker>
          )}

          {/* Nearby aircraft — gray planes */}
          {nearby.map((f) => (
            <Marker key={f.icao} position={[f.lat, f.lon]} icon={nearbyIcon(f.hdg ?? 0)}>
              <Tooltip direction="top" offset={[0, -8]} className="flight-map-tooltip">
                {f.callsign || f.icao}
                {f.alt != null ? ` · ${Math.round(f.alt)}m` : ''}
              </Tooltip>
            </Marker>
          ))}
        </MapContainer>
    </div>
  )
}
