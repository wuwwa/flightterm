import { useState, useMemo, useEffect, useCallback } from 'react'
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
function planeIcon(hdg = 0, large = false) {
  const s = large ? 32 : 20
  const h = s / 2
  return makeIcon(
    `<svg width="${s}" height="${s}" viewBox="0 0 20 20" style="transform:rotate(${hdg}deg)">
      <path d="M10 2 L12.5 8 L18 9.5 L12.5 11 L13 17 L10 15 L7 17 L7.5 11 L2 9.5 L7.5 8 Z"
            fill="#b5bd68" stroke="#1a1a1a" stroke-width="0.8"/>
    </svg>`,
    [s, s],
    [h, h]
  )
}

// Nearby plane — dim gray
function nearbyIcon(hdg = 0, large = false) {
  const s = large ? 22 : 14
  const h = s / 2
  return makeIcon(
    `<svg width="${s}" height="${s}" viewBox="0 0 20 20" style="transform:rotate(${hdg}deg)">
      <path d="M10 2 L12.5 8 L18 9.5 L12.5 11 L13 17 L10 15 L7 17 L7.5 11 L2 9.5 L7.5 8 Z"
            fill="#888" stroke="#1a1a1a" stroke-width="0.8" opacity="0.7"/>
    </svg>`,
    [s, s],
    [h, h]
  )
}

// Start flag icon
function startIcon(large = false) {
  const w = large ? 20 : 14
  const h = large ? 26 : 18
  return makeIcon(
    `<svg width="${w}" height="${h}" viewBox="0 0 14 18">
      <line x1="2" y1="2" x2="2" y2="17" stroke="#888" stroke-width="1.5"/>
      <rect x="2" y="2" width="10" height="7" rx="1" fill="#888" opacity="0.7"/>
    </svg>`,
    [w, h],
    [Math.round(w / 7), h]
  )
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

// ── shared map content (used in both inline and fullscreen) ─────────────────
function MapContent({ center, fullPath, startPos, currentPos, flight, nearby, large }) {
  const lg = !!large
  return (
    <>
      <MapUpdater center={center} />
      <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />

      {fullPath.length >= 2 && (
        <Polyline
          positions={fullPath}
          pathOptions={{ color: '#81a2be', weight: lg ? 3.5 : 2.5, opacity: 0.85 }}
        />
      )}

      {startPos && (
        <Marker position={startPos} icon={startIcon(lg)}>
          <Tooltip direction="bottom" offset={[0, 2]} className="flight-map-tooltip">
            first seen
          </Tooltip>
        </Marker>
      )}

      {currentPos && (
        <Marker position={currentPos} icon={planeIcon(flight?.hdg ?? 0, lg)}>
          <Tooltip direction="top" offset={[0, lg ? -18 : -12]} permanent className="flight-map-tooltip">
            {flight.callsign || flight.icao}
            {flight.alt != null ? ` · ${Math.round(flight.alt)}m` : ''}
          </Tooltip>
        </Marker>
      )}

      {nearby.map((f) => (
        <Marker key={f.icao} position={[f.lat, f.lon]} icon={nearbyIcon(f.hdg ?? 0, lg)}>
          <Tooltip direction="top" offset={[0, lg ? -12 : -8]} className="flight-map-tooltip">
            {f.callsign || f.icao}
            {f.alt != null ? ` · ${Math.round(f.alt)}m` : ''}
          </Tooltip>
        </Marker>
      ))}
    </>
  )
}

export default function FlightMap({ snapshots, flight, flights, fullscreen, onToggleFullscreen }) {
  const [showNearby, setShowNearby] = useState(false)

  // Esc to close expanded map
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e) => { if (e.key === 'Escape') onToggleFullscreen() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, onToggleFullscreen])

  const path = useMemo(() => {
    if (!snapshots) return []
    return snapshots
      .filter((s) => s.lat != null && s.lon != null)
      .map((s) => [s.lat, s.lon])
  }, [snapshots])

  const currentPos =
    flight?.lat != null && flight?.lon != null ? [flight.lat, flight.lon] : null

  const nearby = useMemo(() => {
    if (!showNearby || !flights || !currentPos) return []
    const [lat1, lon1] = currentPos
    const toRad = Math.PI / 180
    const R = 6371
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

  if (!currentPos && path.length === 0) {
    return (
      <div className="py-4 px-2.5 text-center text-fg3 text-[10px]">
        no position data
      </div>
    )
  }

  const fullPath = dedup(currentPos ? [...path, currentPos] : path)
  const center = currentPos || fullPath[fullPath.length - 1]
  const startPos = fullPath.length >= 2 ? fullPath[0] : null
  const contentProps = { center, fullPath, startPos, currentPos, flight, nearby }

  // ── fullscreen overlay ──────────────────────────────────────────────────────
  if (fullscreen) {
    const fsProps = { ...contentProps, large: true }
    return (
      <>
        {/* Inline placeholder so layout doesn't collapse */}
        <div className="h-48 w-full border-t border-b border-border bg-bg text-center text-fg3 text-[10px] flex items-center justify-center">
          map expanded
        </div>

        {/* Expanded overlay — 75% centered modal */}
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
          onClick={(e) => { if (e.target === e.currentTarget) onToggleFullscreen() }}
        >
          <div className="w-[75vw] h-[75vh] bg-bg border border-border2 flex flex-col">
            {/* Header bar */}
            <div className="bg-bg2 border-b border-border py-1.5 px-3 flex justify-between items-center text-xs text-fg2 shrink-0">
              <span className="text-acc">
                map — {flight.callsign || flight.icao}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-fg3 text-[10px]">esc to close</span>
                <button
                  className="bg-transparent border-none text-fg3 text-xs cursor-pointer hover:text-fg"
                  onClick={onToggleFullscreen}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Map fills remaining space */}
            <div className="flex-1 relative">
              {/* Nearby toggle */}
              <button
                className={`absolute top-2.5 right-2.5 z-1000 text-xs font-mono py-1 px-2.5 border cursor-pointer ${
                  showNearby
                    ? 'bg-acc/20 border-acc text-acc'
                    : 'bg-bg1/90 border-border2 text-fg3 hover:text-fg2'
                }`}
                onClick={() => setShowNearby(p => !p)}
              >
                nearby{showNearby && nearby.length > 0 ? ` (${nearby.length})` : ''}
              </button>
              <MapContainer
                center={center}
                zoom={7}
                className="h-full w-full"
                zoomControl={false}
                attributionControl={false}
                dragging={true}
                scrollWheelZoom={true}
                doubleClickZoom={true}
                touchZoom={true}
                key={`fs-${flight?.icao}`}
              >
                <MapContent {...fsProps} />
              </MapContainer>
            </div>
          </div>
        </div>
      </>
    )
  }

  // ── inline map ──────────────────────────────────────────────────────────────
  return (
    <div className="h-48 w-full border-t border-b border-border relative">
      {/* Map controls */}
      <div className="absolute top-1.5 right-1.5 z-1000 flex gap-1">
        <button
          className={`text-[9px] font-mono py-0.5 px-1.5 border cursor-pointer ${
            showNearby
              ? 'bg-acc/20 border-acc text-acc'
              : 'bg-bg1/90 border-border2 text-fg3 hover:text-fg2'
          }`}
          onClick={() => setShowNearby(p => !p)}
        >
          nearby{showNearby && nearby.length > 0 ? ` (${nearby.length})` : ''}
        </button>
        <button
          className="bg-bg1/90 border border-border2 text-fg3 hover:text-fg cursor-pointer p-0.5"
          onClick={onToggleFullscreen}
          title="Expand map"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="6,1 1,1 1,6" />
            <polyline points="10,1 15,1 15,6" />
            <polyline points="6,15 1,15 1,10" />
            <polyline points="10,15 15,15 15,10" />
          </svg>
        </button>
      </div>

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
        <MapContent {...contentProps} />
      </MapContainer>
    </div>
  )
}
