import { useMemo } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, Polygon, Tooltip } from 'react-leaflet'
import AIRPORTS, { getAirportCoords } from '../../data/airports'
import clsx from 'clsx'
import 'leaflet/dist/leaflet.css'

const STATUS_COLORS = {
  ACTIVE: '#b5bd68', ASCENDING: '#8abeb7', CRUISING: '#81a2be',
  DESCENDING: '#f0c674', FILED: '#b294bb', COMPLETED: '#555555', CANCELLED: '#cc6666',
}

const EVENT_COLORS = {
  GS: '#cc6666', GDP: '#f0c674', AFP: '#f0c674', REROUTE: '#b294bb',
  FXA: '#b294bb', RSTR: '#f0c674', CTOP: '#f0c674',
}

export default function TfmsMap({ flights, flowEvents, selectedFlight, onSelectFlight, airportConfigs }) {
  // Flights with valid positions
  const positioned = useMemo(() =>
    flights.filter(f => f.lat != null && f.lon != null),
    [flights]
  )

  // Route line for selected flight (dep → current pos → arr)
  const routeLine = useMemo(() => {
    if (!selectedFlight) return null
    const points = []
    const dep = getAirportCoords(selectedFlight.dep_arpt)
    if (dep) points.push([dep.lat, dep.lon])
    if (selectedFlight.lat != null && selectedFlight.lon != null) {
      points.push([selectedFlight.lat, selectedFlight.lon])
    }
    const arr = getAirportCoords(selectedFlight.arr_arpt)
    if (arr) points.push([arr.lat, arr.lon])
    return points.length >= 2 ? points : null
  }, [selectedFlight])

  // Airspace polygons from flow events with geometry
  const airspacePolygons = useMemo(() => {
    if (!flowEvents) return []
    return flowEvents
      .filter(e => e.geometry)
      .map(e => {
        try {
          const coords = typeof e.geometry === 'string' ? JSON.parse(e.geometry) : e.geometry
          if (!Array.isArray(coords) || coords.length < 3) return null
          return { ...e, coords: coords.map(([lat, lon]) => [lat, lon]) }
        } catch { return null }
      })
      .filter(Boolean)
  }, [flowEvents])

  // Airport markers with delay status
  const airportMarkers = useMemo(() => {
    const delayMap = {}
    if (flowEvents) {
      for (const e of flowEvents) {
        if (!e.airport) continue
        if (!delayMap[e.airport] || e.event_type === 'GS' || (e.event_type === 'GDP' && delayMap[e.airport].type !== 'GS')) {
          delayMap[e.airport] = { type: e.event_type, delay: e.delay_minutes }
        }
      }
    }
    return Object.entries(AIRPORTS).map(([icao, ap]) => ({
      icao, ...ap,
      delay: delayMap[icao] || null,
      config: airportConfigs?.find(c => c.airport === icao) || null,
    }))
  }, [flowEvents, airportConfigs])

  return (
    <div className="h-full w-full relative">
      <MapContainer
        center={[39, -98]}
        zoom={4}
        className="h-full w-full"
        style={{ background: '#1a1a1a' }}
        zoomControl={false}
      >
        <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />

        {/* Airspace restriction polygons */}
        {airspacePolygons.map((poly, i) => (
          <Polygon
            key={`poly-${i}`}
            positions={poly.coords}
            pathOptions={{
              color: EVENT_COLORS[poly.event_type] || '#f0c674',
              fillColor: EVENT_COLORS[poly.event_type] || '#f0c674',
              fillOpacity: 0.15,
              weight: 1.5,
              dashArray: '4 4',
            }}
          >
            <Tooltip>
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {poly.event_type}{poly.airport ? ` ${poly.airport}` : ''}
                {poly.ceiling && ` FL${poly.ceiling}`}
                {poly.floor && `–${poly.floor}`}
                {poly.text && <br />}{poly.text?.substring(0, 60)}
              </span>
            </Tooltip>
          </Polygon>
        ))}

        {/* Airport dots */}
        {airportMarkers.map(ap => (
          <CircleMarker
            key={ap.icao}
            center={[ap.lat, ap.lon]}
            radius={ap.delay?.type === 'GS' ? 5 : ap.delay ? 4 : 2.5}
            pathOptions={{
              color: ap.delay?.type === 'GS' ? '#cc6666' : ap.delay ? '#f0c674' : '#3a3a3a',
              fillColor: ap.delay?.type === 'GS' ? '#cc6666' : ap.delay ? '#f0c674' : '#555555',
              fillOpacity: ap.delay ? 0.8 : 0.4,
              weight: 1,
            }}
          >
            <Tooltip>
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                <b>{ap.icao.replace(/^K/, '')}</b> {ap.city}
                {ap.delay && <><br /><span style={{ color: ap.delay.type === 'GS' ? '#cc6666' : '#f0c674' }}>{ap.delay.type}{ap.delay.delay ? ` ${Math.round(ap.delay.delay)}m` : ''}</span></>}
                {ap.config && <><br />Arr: {ap.config.arr_runway || '—'} ({ap.config.arr_rate || '?'}/hr)<br />Dep: {ap.config.dep_runway || '—'} ({ap.config.dep_rate || '?'}/hr)</>}
              </span>
            </Tooltip>
          </CircleMarker>
        ))}

        {/* Route line for selected flight */}
        {routeLine && (
          <Polyline
            positions={routeLine}
            pathOptions={{ color: '#81a2be', weight: 2, opacity: 0.6, dashArray: '6 4' }}
          />
        )}

        {/* Flight position markers */}
        {positioned.map(f => {
          const selected = selectedFlight?.acid === f.acid
          const color = STATUS_COLORS[f.flight_status] || '#888888'
          return (
            <CircleMarker
              key={f.acid}
              center={[f.lat, f.lon]}
              radius={selected ? 5 : 3}
              pathOptions={{
                color: selected ? '#b5bd68' : color,
                fillColor: selected ? '#b5bd68' : color,
                fillOpacity: selected ? 1 : 0.7,
                weight: selected ? 2 : 1,
              }}
              eventHandlers={{ click: () => onSelectFlight?.(f) }}
            >
              <Tooltip>
                <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                  <b>{f.acid}</b> {f.flight_status}<br />
                  {f.dep_arpt || '?'} → {f.arr_arpt || '?'}<br />
                  {f.altitude ? `${f.altitude} ` : ''}{f.speed ? `${f.speed}kt` : ''}
                </span>
              </Tooltip>
            </CircleMarker>
          )
        })}
      </MapContainer>
    </div>
  )
}
