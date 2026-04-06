import { useState, useMemo, useEffect } from 'react'
import { MapContainer, TileLayer, Polyline, Marker, CircleMarker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getAirportCoords } from '../data/airports'

// ── recenter map + invalidate size on container resize ──────────────────────
function MapUpdater({ center, fitBounds }) {
  const map = useMap()

  useEffect(() => {
    if (fitBounds && fitBounds.length >= 2) {
      map.fitBounds(fitBounds, { padding: [30, 30], maxZoom: 10 })
    } else if (center) {
      map.setView(center, map.getZoom(), { animate: true })
    }
  }, [center?.[0], center?.[1], fitBounds])

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

// Other plane — dim gray
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

// ── shared map content ──────────────────────────────────────────────────────
function MapContent({ center, fullPath, startPos, currentPos, flight, others, large, fitBounds }) {
  const lg = !!large

  // TFMS route: dep airport → arr airport planned path
  // Uses coordinates from TFMS enrichment (sourced from callsign_routes DB or AIRPORTS list)
  const tfms = flight?.tfms
  const depPos = tfms?.dep_lat != null ? [tfms.dep_lat, tfms.dep_lon] : null
  const arrPos = tfms?.arr_lat != null ? [tfms.arr_lat, tfms.arr_lon] : null
  // Fallback to frontend airport list if backend didn't have coords
  const depFallback = !depPos && tfms?.dep_arpt ? getAirportCoords(tfms.dep_arpt) : null
  const arrFallback = !arrPos && tfms?.arr_arpt ? getAirportCoords(tfms.arr_arpt) : null
  const depCoords = depPos || (depFallback ? [depFallback.lat, depFallback.lon] : null)
  const arrCoords = arrPos || (arrFallback ? [arrFallback.lat, arrFallback.lon] : null)
  const plannedRoute = depCoords && arrCoords ? [depCoords, arrCoords] : null

  return (
    <>
      <MapUpdater center={center} fitBounds={fitBounds} />
      <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />

      {/* TFMS planned route — dashed line from dep to arr */}
      {plannedRoute && (
        <Polyline
          positions={plannedRoute}
          pathOptions={{ color: '#555', weight: lg ? 2 : 1.5, opacity: 0.5, dashArray: '6 4' }}
        />
      )}

      {/* Departure airport marker */}
      {depCoords && (
        <CircleMarker center={depCoords} radius={lg ? 5 : 4}
          pathOptions={{ color: '#b5bd68', fillColor: '#b5bd68', fillOpacity: 0.8, weight: 1 }}>
          <Tooltip direction="bottom" offset={[0, 4]} className="flight-map-tooltip">
            {(tfms?.dep_arpt || '').replace(/^K/, '')} (dep)
          </Tooltip>
        </CircleMarker>
      )}

      {/* Arrival airport marker */}
      {arrCoords && (
        <CircleMarker center={arrCoords} radius={lg ? 5 : 4}
          pathOptions={{ color: '#cc6666', fillColor: '#cc6666', fillOpacity: 0.8, weight: 1 }}>
          <Tooltip direction="bottom" offset={[0, 4]} className="flight-map-tooltip">
            {(tfms?.arr_arpt || '').replace(/^K/, '')} (arr)
            {tfms?.eta && <><br />{new Date(tfms.eta).toISOString().substring(11, 16)}z</>}
          </Tooltip>
        </CircleMarker>
      )}

      {/* ADS-B actual track */}
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
            {flight.alt != null ? ` · ${Math.round(flight.alt * 3.281).toLocaleString()}ft` : ''}
            {flight.routeDeviation > 50 && ` · ${flight.routeDeviation}km off-route`}
          </Tooltip>
        </Marker>
      )}

      {others.map((f) => (
        <Marker key={f.icao} position={[f.lat, f.lon]} icon={nearbyIcon(f.hdg ?? 0, lg)}>
          <Tooltip direction="top" offset={[0, lg ? -12 : -8]} className="flight-map-tooltip">
            {f.callsign || f.icao}
            {f.alt != null ? ` · ${Math.round(f.alt * 3.281).toLocaleString()}ft` : ''}
          </Tooltip>
        </Marker>
      ))}
    </>
  )
}

// ── toggle button helper ────────────────────────────────────────────────────
function MapBtn({ active, onClick, children, large }) {
  const sz = large ? 'text-xs py-1 px-2.5' : 'text-[9px] py-0.5 px-1.5'
  return (
    <button
      className={`font-mono border cursor-pointer ${sz} ${
        active
          ? 'bg-acc/20 border-acc text-acc'
          : 'bg-bg1/90 border-border2 text-fg3 hover:text-fg2'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export default function FlightMap({ snapshots, flight, flights, fullscreen, onToggleFullscreen }) {
  const [viewMode, setViewMode] = useState('nearby') // 'default' | 'nearby' | 'all'

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

  // All flights with positions (excluding selected)
  const allOthers = useMemo(() => {
    if (!flights || !flight) return []
    return flights.filter(
      (f) => f.icao !== flight.icao && f.lat != null && f.lon != null
    )
  }, [flights, flight?.icao])

  // Nearby: within ~100 mi / 160 km
  const nearbyOthers = useMemo(() => {
    if (!currentPos) return []
    const [lat1, lon1] = currentPos
    const toRad = Math.PI / 180
    const R = 6371
    const maxKm = 160
    return allOthers.filter((f) => {
      const dLat = (f.lat - lat1) * toRad
      const dLon = (f.lon - lon1) * toRad
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * toRad) * Math.cos(f.lat * toRad) * Math.sin(dLon / 2) ** 2
      const d = 2 * R * Math.asin(Math.sqrt(a))
      return d <= maxKm
    })
  }, [allOthers, currentPos?.[0], currentPos?.[1]])

  // Which set of other flights to show
  const others = viewMode === 'all' ? allOthers : viewMode === 'nearby' ? nearbyOthers : []

  // Fit bounds when showing all flights
  const fitBounds = useMemo(() => {
    if (viewMode !== 'all' || allOthers.length === 0) return null
    const pts = allOthers.map((f) => [f.lat, f.lon])
    if (currentPos) pts.push(currentPos)
    return pts
  }, [viewMode, allOthers, currentPos])

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

  const toggle = (mode) => setViewMode((prev) => prev === mode ? 'default' : mode)

  const contentProps = { center, fullPath, startPos, currentPos, flight, others, fitBounds }

  // ── fullscreen overlay ──────────────────────────────────────────────────────
  if (fullscreen) {
    const fsProps = { ...contentProps, large: true }
    return (
      <>
        <div className="h-48 w-full border-t border-b border-border bg-bg text-center text-fg3 text-[10px] flex items-center justify-center">
          map expanded
        </div>

        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
          onClick={(e) => { if (e.target === e.currentTarget) onToggleFullscreen() }}
        >
          <div className="w-[75vw] h-[75vh] bg-bg border border-border2 flex flex-col">
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

            <div className="flex-1 relative">
              <div className="absolute top-2.5 right-2.5 z-1000 flex gap-1">
                <MapBtn active={viewMode === 'nearby'} onClick={() => toggle('nearby')} large>
                  nearby{viewMode === 'nearby' && nearbyOthers.length > 0 ? ` (${nearbyOthers.length})` : ''}
                </MapBtn>
                <MapBtn active={viewMode === 'all'} onClick={() => toggle('all')} large>
                  all{viewMode === 'all' ? ` (${allOthers.length})` : ''}
                </MapBtn>
              </div>
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
      <div className="absolute top-1.5 right-1.5 z-1000 flex gap-1">
        <MapBtn active={viewMode === 'nearby'} onClick={() => toggle('nearby')}>
          nearby{viewMode === 'nearby' && nearbyOthers.length > 0 ? ` (${nearbyOthers.length})` : ''}
        </MapBtn>
        <MapBtn active={viewMode === 'all'} onClick={() => toggle('all')}>
          all{viewMode === 'all' ? ` (${allOthers.length})` : ''}
        </MapBtn>
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
        zoom={12}
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
