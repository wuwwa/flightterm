import clsx from 'clsx'

// Coarse US state bounding boxes for geographic labeling when no airport is nearby
const US_STATES = [
  { id: 'AK', lat: [51, 71], lon: [-180, -130] },
  { id: 'HI', lat: [18, 23], lon: [-161, -154] },
  { id: 'WA', lat: [45.5, 49], lon: [-124.8, -116.9] },
  { id: 'OR', lat: [42, 46.3], lon: [-124.6, -116.5] },
  { id: 'CA', lat: [32.5, 42], lon: [-124.4, -114.1] },
  { id: 'NV', lat: [35, 42], lon: [-120, -114] },
  { id: 'AZ', lat: [31.3, 37], lon: [-114.8, -109] },
  { id: 'UT', lat: [37, 42], lon: [-114.1, -109] },
  { id: 'CO', lat: [37, 41], lon: [-109.1, -102] },
  { id: 'NM', lat: [31.3, 37], lon: [-109.1, -103] },
  { id: 'TX', lat: [25.8, 36.5], lon: [-106.7, -93.5] },
  { id: 'OK', lat: [33.6, 37], lon: [-103, -94.4] },
  { id: 'KS', lat: [37, 40], lon: [-102.1, -94.6] },
  { id: 'NE', lat: [40, 43], lon: [-104.1, -95.3] },
  { id: 'SD', lat: [42.5, 46], lon: [-104.1, -96.4] },
  { id: 'ND', lat: [45.9, 49], lon: [-104.1, -96.6] },
  { id: 'MT', lat: [44.4, 49], lon: [-116.1, -104] },
  { id: 'WY', lat: [41, 45], lon: [-111.1, -104.1] },
  { id: 'ID', lat: [42, 49], lon: [-117.2, -111] },
  { id: 'MN', lat: [43.5, 49.4], lon: [-97.2, -89.5] },
  { id: 'IA', lat: [40.4, 43.5], lon: [-96.6, -90.1] },
  { id: 'MO', lat: [36, 40.6], lon: [-95.8, -89] },
  { id: 'AR', lat: [33, 36.5], lon: [-94.6, -89.6] },
  { id: 'LA', lat: [29, 33], lon: [-94.1, -89] },
  { id: 'MS', lat: [30, 35], lon: [-91.7, -88.1] },
  { id: 'AL', lat: [30, 35], lon: [-88.5, -84.9] },
  { id: 'TN', lat: [35, 36.7], lon: [-90.3, -81.6] },
  { id: 'KY', lat: [36.5, 39.2], lon: [-89.6, -82] },
  { id: 'WI', lat: [42.5, 47], lon: [-92.9, -86.8] },
  { id: 'IL', lat: [37, 42.5], lon: [-91.5, -87.5] },
  { id: 'IN', lat: [37.8, 41.8], lon: [-88.1, -84.8] },
  { id: 'MI', lat: [41.7, 48.3], lon: [-90.4, -82.1] },
  { id: 'OH', lat: [38.4, 42], lon: [-84.8, -80.5] },
  { id: 'WV', lat: [37.2, 40.6], lon: [-82.6, -77.7] },
  { id: 'VA', lat: [36.5, 39.5], lon: [-83.7, -75.2] },
  { id: 'NC', lat: [33.8, 36.6], lon: [-84.3, -75.5] },
  { id: 'SC', lat: [32, 35.2], lon: [-83.4, -78.5] },
  { id: 'GA', lat: [30.4, 35], lon: [-85.6, -80.8] },
  { id: 'FL', lat: [24.5, 31], lon: [-87.6, -80] },
  { id: 'PA', lat: [39.7, 42.3], lon: [-80.5, -74.7] },
  { id: 'NY', lat: [40.5, 45], lon: [-79.8, -71.9] },
  { id: 'NJ', lat: [38.9, 41.4], lon: [-75.6, -74] },
  { id: 'CT', lat: [41, 42.1], lon: [-73.7, -71.8] },
  { id: 'MA', lat: [41.2, 42.9], lon: [-73.5, -69.9] },
  { id: 'ME', lat: [43, 47.5], lon: [-71.1, -67] },
  { id: 'VT', lat: [42.7, 45.1], lon: [-73.4, -71.5] },
  { id: 'NH', lat: [42.7, 45.3], lon: [-72.6, -70.7] },
]

function labelZone(hotspot) {
  const { lat, lon, nearest_airport, airport_city, airport_state, airport_dist_km } = hotspot
  // Near a known airport — show city, state + ICAO
  if (airport_city && airport_dist_km <= 80) {
    return `${airport_city}, ${airport_state} (${nearest_airport})`
  }
  // Try US state with airport context
  for (const s of US_STATES) {
    if (lat >= s.lat[0] && lat <= s.lat[1] && lon >= s.lon[0] && lon <= s.lon[1]) {
      if (nearest_airport) return `${s.id} · nr ${nearest_airport}`
      return s.id
    }
  }
  // Outside US — use airport if available
  if (airport_city) return `${airport_city}, ${airport_state} (${nearest_airport})`
  if (nearest_airport) return nearest_airport
  // Last resort: coarse lat/lon
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(0)}°${ns} ${Math.abs(lon).toFixed(0)}°${ew}`
}

export { labelZone }

export default function ZoneMetrics({ hotspots, onSelectZone, selectedZone }) {
  if (!hotspots || hotspots.length === 0) return null

  // Sort by deviation (highest first), then by count if no baseline
  const sorted = [...hotspots].sort((a, b) => {
    if (a.deviation != null && b.deviation != null) return b.deviation - a.deviation
    if (a.deviation != null) return -1
    if (b.deviation != null) return 1
    return b.count - a.count
  })

  return (
    <div className="bg-border">
      <div className="py-0.5 px-2.5 text-[9px] text-fg3 bg-bg2 border-t border-b border-border flex justify-between">
        <span>zone activity (24h)</span>
        <span>{sorted.length} zone{sorted.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="bg-bg1 max-h-[200px] overflow-y-auto">
        {/* Header row */}
        <div className="grid grid-cols-[1fr_50px_50px_60px] gap-1 py-0.5 px-2.5 text-[9px] text-fg3 border-b border-white/5 bg-bg2/50">
          <span>location</span>
          <span className="text-right">events</span>
          <span className="text-right">aircraft</span>
          <span className="text-right">vs norm</span>
        </div>
        {sorted.map((h, i) => {
          const location = labelZone(h)
          const devLabel = h.deviation != null
            ? `${h.deviation}x`
            : '—'
          const devColor = h.deviation != null
            ? h.deviation >= 3 ? 'text-red' : h.deviation >= 1.5 ? 'text-ylw' : 'text-grn'
            : 'text-fg3'
          const isSelected = selectedZone && selectedZone.lat === h.lat && selectedZone.lon === h.lon

          return (
            <div
              key={i}
              className={clsx(
                'grid grid-cols-[1fr_50px_50px_60px] gap-1 py-0.5 px-2.5 text-[10px] border-b border-white/3 cursor-pointer hover:bg-bg2 transition-colors',
                isSelected && 'bg-acc/8 border-l-2 border-l-acc',
                !isSelected && h.deviation >= 3 && 'bg-red/5',
              )}
              onClick={() => onSelectZone?.({ ...h, label: location })}
            >
              <span className="text-acc truncate" title={h.categories.join(', ')}>
                {location}
              </span>
              <span className="text-fg2 text-right tabular-nums">{h.count}</span>
              <span className="text-fg3 text-right tabular-nums">{h.unique_aircraft}</span>
              <span className={clsx('text-right tabular-nums font-medium', devColor)}>
                {devLabel}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
