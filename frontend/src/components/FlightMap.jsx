import { useMemo, useEffect } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'

// ── recenter map when the tracked flight moves ──────────────────────────────
function MapUpdater({ center, zoom }) {
  const map = useMap()
  useEffect(() => {
    if (center) map.setView(center, zoom ?? map.getZoom(), { animate: true })
  }, [center?.[0], center?.[1]])
  return null
}

// ── heading projection: extend a line N km along current heading ─────────────
function project(lat, lon, hdgDeg, distKm) {
  const R = 6371
  const d = distKm / R
  const brng = (hdgDeg * Math.PI) / 180
  const lat1 = (lat * Math.PI) / 180
  const lon1 = (lon * Math.PI) / 180

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  )
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    )

  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI]
}

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

export default function FlightMap({ snapshots, flight }) {
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

  // Start point = first point in the path (if we have history)
  const startPos = fullPath.length >= 1 ? fullPath[0] : null

  // Projected heading line (~80km ahead)
  const projLine = useMemo(() => {
    if (!currentPos || flight?.hdg == null || flight.grounded) return null
    const pts = []
    for (let d = 0; d <= 80; d += 10) {
      pts.push(project(currentPos[0], currentPos[1], flight.hdg, d))
    }
    return pts
  }, [currentPos, flight?.hdg, flight?.grounded])

  return (
    <div className="h-48 w-full border-t border-b border-border relative">
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

        {/* Projected heading — dashed line */}
        {projLine && (
          <Polyline
            positions={projLine}
            pathOptions={{ color: '#81a2be', weight: 1.5, opacity: 0.35, dashArray: '6 4' }}
          />
        )}

        {/* Starting point — gray dot */}
        {startPos && fullPath.length >= 2 && (
          <CircleMarker
            center={startPos}
            radius={4}
            pathOptions={{ color: '#888', fillColor: '#888', fillOpacity: 1, weight: 1 }}
          >
            <Tooltip direction="bottom" offset={[0, 6]} className="flight-map-tooltip">
              start
            </Tooltip>
          </CircleMarker>
        )}

        {/* Current position — green dot */}
        {currentPos && (
          <CircleMarker
            center={currentPos}
            radius={5}
            pathOptions={{ color: '#b5bd68', fillColor: '#b5bd68', fillOpacity: 1, weight: 0 }}
          >
            <Tooltip direction="top" offset={[0, -8]} permanent className="flight-map-tooltip">
              {flight.callsign || flight.icao}
              {flight.alt != null ? ` · ${Math.round(flight.alt)}m` : ''}
              {flight.hdg != null ? ` · ${Math.round(flight.hdg)}°` : ''}
            </Tooltip>
          </CircleMarker>
        )}
      </MapContainer>
    </div>
  )
}
