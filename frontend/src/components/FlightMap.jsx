import { useState, useMemo, useEffect } from 'react'
import { MapContainer, TileLayer, Polyline, Marker, CircleMarker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import clsx from 'clsx'
import 'leaflet/dist/leaflet.css'
import { getAirportCoords } from '../data/airports'

// Great-circle distance (km) between two lat/lon points
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// km → nautical miles
const kmToNm = (km) => Math.round(km * 0.539957)

// Track phase colors — match FlightTable PHASE_COLOR for consistency
const TRACK_PHASE_COLOR = {
  CLIMB:    '#b5bd68',  // green
  CRUISE:   '#81a2be',  // blue
  DESCENT:  '#8abeb7',  // cyan
  GROUND:   '#666',     // gray
}

// Split snapshot list into colored segments by vertical phase.
// Phase derived from altitude delta between consecutive points (m → ft/min).
// Returns: [{ points: [[lat,lon], ...], color: '#...' }, ...]
function buildTrackSegments(snapshots) {
  const valid = snapshots.filter(s => s.lat != null && s.lon != null && s.alt != null)
  if (valid.length < 2) return []

  const segments = []
  let currentSeg = null

  for (let i = 0; i < valid.length; i++) {
    const s = valid[i]
    let phase
    if (s.grounded || (s.alt != null && s.alt < 30)) {
      phase = 'GROUND'
    } else if (i > 0) {
      // Use vertical rate from snapshot if available, otherwise compute from alt delta
      const prev = valid[i - 1]
      const dtMs = (s.ts && prev.ts) ? (s.ts - prev.ts) : null
      let vrFpm = null
      if (s.vertRate != null) vrFpm = s.vertRate * 196.85  // m/s → ft/min
      else if (dtMs && dtMs > 0) vrFpm = ((s.alt - prev.alt) * 3.281) / (dtMs / 60000)
      phase = vrFpm == null ? 'CRUISE'
        : vrFpm > 250 ? 'CLIMB'
        : vrFpm < -250 ? 'DESCENT'
        : 'CRUISE'
    } else {
      phase = 'CRUISE'
    }

    if (currentSeg && currentSeg.phase === phase) {
      currentSeg.points.push([s.lat, s.lon])
    } else {
      // Bridge to previous point so segments connect visually
      if (currentSeg && currentSeg.points.length > 0) {
        const last = currentSeg.points[currentSeg.points.length - 1]
        currentSeg = { phase, color: TRACK_PHASE_COLOR[phase], points: [last, [s.lat, s.lon]] }
      } else {
        currentSeg = { phase, color: TRACK_PHASE_COLOR[phase], points: [[s.lat, s.lon]] }
      }
      segments.push(currentSeg)
    }
  }
  return segments
}

// ── Route stats overlay — filed vs actual comparison ───────────────────────
// Renders in the corner of the FlightMap when TFMS dep/arr coords are present.
// Shows: dep→arr · total filed nm · flown · remaining · progress bar · deviation · ETA delta
function RouteStatsOverlay({ stats }) {
  if (!stats) return null
  const { dep, arr, filedKm, coveredKm, remainingKm, progress, deviation, deviationMode, etaDeltaMin, etaTime } = stats
  const pct = Math.round(progress * 100)
  const devColor = deviation > 100 ? 'text-red' : deviation > 25 ? 'text-ylw' : 'text-grn'
  const etaColor = etaDeltaMin == null ? 'text-fg3'
    : etaDeltaMin > 15 ? 'text-red'
    : etaDeltaMin > 5 ? 'text-ylw'
    : etaDeltaMin < -5 ? 'text-cyn'
    : 'text-grn'

  return (
    <div className="absolute top-1.5 left-1.5 z-1000 bg-bg1/90 border border-border2 px-2 py-1 text-[9px] tabular-nums font-mono backdrop-blur-sm">
      {/* Header — route */}
      <div className="flex items-baseline gap-1 mb-0.5">
        <span className="text-grn font-bold">{dep?.replace(/^K/, '') || '?'}</span>
        <span className="text-fg3">→</span>
        <span className="text-red font-bold">{arr?.replace(/^K/, '') || '?'}</span>
        <span className="text-fg3/60 ml-1">{kmToNm(filedKm)}<span className="text-[7px]">nm</span></span>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-1.5 mb-0.5">
        <div className="w-32 h-1 bg-bg2 rounded-full overflow-hidden">
          <div className="h-full bg-acc rounded-full" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-acc font-bold">{pct}%</span>
      </div>

      {/* Distance breakdown */}
      <div className="flex gap-2 text-[8px] text-fg3 mb-0.5">
        <span><span className="text-fg2">{kmToNm(coveredKm)}</span>nm covered</span>
        {remainingKm != null && <span><span className="text-fg2">{kmToNm(remainingKm)}</span>nm to go</span>}
      </div>

      {/* Bottom row: deviation + ETA delta */}
      <div className="flex gap-2 text-[8px] mt-0.5 pt-0.5 border-t border-white/10">
        <span title={deviationMode === 'polyline' ? 'distance from filed waypoints' : 'distance from great-circle path'}>
          <span className="text-fg3">dev:</span>{' '}
          <span className={clsx('font-bold', devColor)}>
            {deviation > 0 ? `${deviation}km${deviationMode === 'polyline' ? '*' : ''}` : 'on route'}
          </span>
        </span>
        {etaTime && (
          <span title={`filed ETA ${new Date(etaTime).toISOString().substring(11, 16)}z`}>
            <span className="text-fg3">eta:</span>{' '}
            {etaDeltaMin != null ? (
              <span className={clsx('font-bold', etaColor)}>
                {etaDeltaMin > 0 ? `+${etaDeltaMin}` : etaDeltaMin}m
              </span>
            ) : (
              <span className="text-fg3">{new Date(etaTime).toISOString().substring(11, 16)}z</span>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

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
function MapContent({ center, fullPath, startPos, currentPos, flight, others, large, fitBounds, routeStats, snapshots }) {
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

  // Color the planned line by current deviation severity
  const dev = flight?.routeDeviation || 0
  const plannedColor = dev > 100 ? '#cc6666'    // red — major deviation
    : dev > 25 ? '#f0c674'                       // yellow — moderate
    : '#888'                                     // neutral gray — on track

  return (
    <>
      <MapUpdater center={center} fitBounds={fitBounds} />
      <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />

      {/* TFMS planned route — dashed line from dep to arr, colored by deviation severity */}
      {plannedRoute && (
        <Polyline
          positions={plannedRoute}
          pathOptions={{ color: plannedColor, weight: lg ? 2 : 1.5, opacity: 0.6, dashArray: '6 4' }}
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

      {/* ADS-B actual track — per-segment coloring by vertical phase derived
          from snapshot altitudes. Climb=green, Cruise=blue, Descent=cyan,
          Ground=gray. Falls back to a single blue line if snapshots are unavailable. */}
      {fullPath.length >= 2 && (
        snapshots && snapshots.length >= 2 ? (
          buildTrackSegments(snapshots).map((seg, i) => (
            <Polyline
              key={`seg-${i}`}
              positions={seg.points}
              pathOptions={{ color: seg.color, weight: lg ? 3.5 : 2.5, opacity: 0.9 }}
            />
          ))
        ) : (
          <Polyline
            positions={fullPath}
            pathOptions={{ color: '#81a2be', weight: lg ? 3.5 : 2.5, opacity: 0.85 }}
          />
        )
      )}

      {/* Ghost "should be here now" dot — based on filed ETD/ETA schedule.
          Only renders when we have a TFMS schedule and the flight is in flight. */}
      {routeStats?.scheduledPos && (
        <CircleMarker
          center={routeStats.scheduledPos}
          radius={lg ? 7 : 5}
          pathOptions={{
            color: '#888',
            fillColor: '#1a1a1a',
            fillOpacity: 0.6,
            weight: 1.5,
            dashArray: '3 2',
          }}
        >
          <Tooltip direction="top" offset={[0, -2]} className="flight-map-tooltip">
            scheduled position ({Math.round(routeStats.scheduledProgress * 100)}%)
            {routeStats.etaTime && <><br />filed ETA {new Date(routeStats.etaTime).toISOString().substring(11, 16)}z</>}
          </Tooltip>
        </CircleMarker>
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
  const [viewMode, setViewMode] = useState('default') // 'default' | 'nearby' | 'all'

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

  // Fit bounds: show all flights, OR when a TFMS-enriched flight is selected,
  // fit to dep + arr + current position so the full planned route is visible.
  const fitBounds = useMemo(() => {
    // Mode 1: all flights view
    if (viewMode === 'all' && allOthers.length > 0) {
      const pts = allOthers.map((f) => [f.lat, f.lon])
      if (currentPos) pts.push(currentPos)
      return pts
    }
    // Mode 2: TFMS planned route — fit to dep + arr + current pos
    const tfms = flight?.tfms
    if (tfms && currentPos) {
      const depLat = tfms.dep_lat ?? getAirportCoords(tfms.dep_arpt)?.lat
      const depLon = tfms.dep_lon ?? getAirportCoords(tfms.dep_arpt)?.lon
      const arrLat = tfms.arr_lat ?? getAirportCoords(tfms.arr_arpt)?.lat
      const arrLon = tfms.arr_lon ?? getAirportCoords(tfms.arr_arpt)?.lon
      if (depLat != null && arrLat != null) {
        return [[depLat, depLon], [arrLat, arrLon], currentPos]
      }
    }
    return null
  }, [viewMode, allOthers, currentPos, flight?.tfms?.dep_arpt, flight?.tfms?.arr_arpt, flight?.tfms?.dep_lat, flight?.tfms?.arr_lat])

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

  // ── Route stats: filed vs actual ─────────────────────────────────────────
  // Computes total filed distance, distance flown, distance remaining, and ETA delta.
  // Only renders when we have TFMS dep/arr coords. Uses haversine for great-circle math.
  const routeStats = useMemo(() => {
    const tfms = flight?.tfms
    if (!tfms) return null
    const depLat = tfms.dep_lat ?? getAirportCoords(tfms.dep_arpt)?.lat
    const depLon = tfms.dep_lon ?? getAirportCoords(tfms.dep_arpt)?.lon
    const arrLat = tfms.arr_lat ?? getAirportCoords(tfms.arr_arpt)?.lat
    const arrLon = tfms.arr_lon ?? getAirportCoords(tfms.arr_arpt)?.lon
    if (depLat == null || arrLat == null) return null

    const filedKm = haversineKm(depLat, depLon, arrLat, arrLon)

    // Distance covered along the planned route — great-circle from dep to current pos.
    // We use this as "flown" because the ADS-B trail length only reflects locally-seen
    // snapshots (would show a few miles for a transcon flight that just got selected).
    const coveredKm = currentPos ? haversineKm(depLat, depLon, currentPos[0], currentPos[1]) : 0

    // Distance remaining — current pos to arrival airport
    const remainingKm = currentPos ? haversineKm(currentPos[0], currentPos[1], arrLat, arrLon) : null

    // Progress along the planned route (0..1)
    const progress = filedKm > 0 ? Math.max(0, Math.min(1, coveredKm / filedKm)) : 0

    // ETA delta vs filed
    let etaDeltaMin = null
    if (tfms.eta) {
      const etaTime = new Date(tfms.eta).getTime()
      if (!isNaN(etaTime)) {
        // If we have a remaining distance and current ground speed, project actual ETA
        const speedKt = flight?.vel != null ? flight.vel * 1.944 : null
        if (speedKt && speedKt > 50 && remainingKm != null) {
          const remainingNm = remainingKm * 0.539957
          const projectedArrivalMs = Date.now() + (remainingNm / speedKt) * 3600 * 1000
          etaDeltaMin = Math.round((projectedArrivalMs - etaTime) / 60000)
        }
      }
    }

    // "Should be here now" — interpolate along the dep→arr line based on
    // schedule. Uses ETD (or ATD) and ETA to compute the time-elapsed proportion.
    let scheduledPos = null
    let scheduledProgress = null
    const startTime = tfms.atd || tfms.etd
    if (startTime && tfms.eta) {
      const startMs = new Date(startTime).getTime()
      const endMs = new Date(tfms.eta).getTime()
      const nowMs = Date.now()
      if (!isNaN(startMs) && !isNaN(endMs) && endMs > startMs) {
        scheduledProgress = Math.max(0, Math.min(1, (nowMs - startMs) / (endMs - startMs)))
        // Linear interpolation along great-circle (close enough for visual)
        scheduledPos = [
          depLat + (arrLat - depLat) * scheduledProgress,
          depLon + (arrLon - depLon) * scheduledProgress,
        ]
      }
    }

    return {
      dep: tfms.dep_arpt,
      arr: tfms.arr_arpt,
      filedKm: Math.round(filedKm),
      coveredKm: Math.round(coveredKm),
      remainingKm: remainingKm != null ? Math.round(remainingKm) : null,
      progress,
      deviation: flight?.routeDeviation || 0,
      deviationMode: flight?.routeDeviationMode || 'gc',
      etaDeltaMin,
      etaTime: tfms.eta || null,
      scheduledPos,
      scheduledProgress,
    }
  }, [flight?.tfms, flight?.routeDeviation, flight?.routeDeviationMode, flight?.vel, currentPos])

  const contentProps = { center, fullPath, startPos, currentPos, flight, others, fitBounds, routeStats, snapshots }

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
              <RouteStatsOverlay stats={routeStats} />
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
      <RouteStatsOverlay stats={routeStats} />
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
