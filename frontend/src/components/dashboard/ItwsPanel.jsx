import { useState } from 'react'
import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'
import { WeatherDetailPopup } from './SwimPopup'

// Display order: most-severe types first
const TYPE_ORDER = ['TORNADO', 'MICROBURST', 'WINDSHEAR', 'GUST_FRONT', 'LIGHTNING', 'HAZARD_TEXT', 'PRECIP', 'STORM_MOTION']

const TYPE_LABEL = {
  TORNADO: 'tornado', MICROBURST: 'microburst', WINDSHEAR: 'windshear',
  GUST_FRONT: 'gust front', HAZARD_TEXT: 'hazard', PRECIP: 'precip',
  STORM_MOTION: 'storm motion', LIGHTNING: 'lightning',
}

// Severity color per type — critical events are red, warnings are yellow, info is dim
const TYPE_COLOR = {
  TORNADO: 'text-red',
  MICROBURST: 'text-red',
  WINDSHEAR: 'text-red',
  GUST_FRONT: 'text-ylw',
  LIGHTNING: 'text-ylw',
  HAZARD_TEXT: 'text-ylw',
  PRECIP: 'text-cyn',
  STORM_MOTION: 'text-fg3',
}

export default function ItwsPanel({ backendOk }) {
  const { status, weather: events } = useSwim()
  const stats = status?.terminalWeather
  const [selectedAirport, setSelectedAirport] = useState(null)

  // Group events by type → unique sorted airport list
  const groups = {}
  for (const e of events || []) {
    const type = e.event_type
    if (!type) continue
    const apt = (e.airport || e.site || '').replace(/^K/, '')
    if (!apt) continue
    if (!groups[type]) groups[type] = new Set()
    groups[type].add(apt)
  }

  // Build ordered list of groups that actually have events
  const activeGroups = TYPE_ORDER
    .filter(t => groups[t] && groups[t].size > 0)
    .map(t => ({ type: t, airports: Array.from(groups[t]).sort() }))

  const hasAny = activeGroups.length > 0

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      <div className="py-0.5 px-2 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between shrink-0">
        <span className="ft-chip ft-chip--yellow">terminal weather</span>
        <span>{stats?.sites || 0} sites · {activeGroups.length} hazard{activeGroups.length === 1 ? '' : 's'}</span>
      </div>

      {!hasAny ? (
        <div className="flex-1 flex items-center justify-center text-[9px] text-grn/70">
          no terminal hazards
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {activeGroups.map(g => (
            <div key={g.type} className="px-2 py-1 border-b border-white/3">
              <div className="flex items-baseline gap-1.5 mb-0.5">
                <span className={clsx('font-bold text-[10px] uppercase tracking-wide', TYPE_COLOR[g.type] || 'text-fg2')}>
                  {TYPE_LABEL[g.type] || g.type.toLowerCase()}
                </span>
                <span className="text-fg3/50 text-[9px] tabular-nums">{g.airports.length}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {g.airports.slice(0, 24).map(apt => (
                  <button
                    key={apt}
                    onClick={() => setSelectedAirport('K' + apt)}
                    className="text-[9px] tabular-nums bg-bg2 hover:bg-bg2/60 text-fg2 px-1 py-0 rounded cursor-pointer"
                    title={`view weather at ${apt}`}
                  >
                    {apt}
                  </button>
                ))}
                {g.airports.length > 24 && (
                  <span className="text-[9px] text-fg3/40 px-1">+{g.airports.length - 24}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedAirport && (
        <WeatherDetailPopup airport={selectedAirport} onClose={() => setSelectedAirport(null)} />
      )}
    </div>
  )
}
