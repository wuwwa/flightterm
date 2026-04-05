import { useState, useCallback } from 'react'
import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'
import TfmsMap from './TfmsMap'
import AirportBoard from './AirportBoard'
import FlightTimeline from './FlightTimeline'
import DelayBoard from './DelayBoard'

const TABS = [
  { id: 'map', label: 'MAP' },
  { id: 'board', label: 'AIRPORT' },
  { id: 'delays', label: 'DELAYS' },
]

export default function TfmsPanel({ backendOk }) {
  const { flights, flowEvents, airportConfigs } = useSwim()
  const [tab, setTab] = useState('map')
  const [selectedFlight, setSelectedFlight] = useState(null)
  const [selectedAirport, setSelectedAirport] = useState('')
  const [collapsed, setCollapsed] = useState(false)

  const handleSelectFlight = useCallback((f) => {
    setSelectedFlight(prev => prev?.acid === f.acid ? null : f)
  }, [])

  const handleSelectAirport = useCallback((airport) => {
    setSelectedAirport(airport)
    setTab('board')
  }, [])

  const positioned = flights.filter(f => f.lat != null && f.lon != null).length

  return (
    <div className="bg-bg1 border-t border-border">
      {/* Header */}
      <div className="bg-bg2 border-b border-border py-1 px-3 flex items-center gap-2">
        <div
          className="flex items-center gap-2 cursor-pointer select-none"
          onClick={() => setCollapsed(c => !c)}
        >
          <span className="text-acc text-[9px] tracking-wider uppercase font-bold">TFMS</span>
          <span className="text-fg3 text-[9px]">{flights.length} flights{positioned > 0 ? ` · ${positioned} positioned` : ''}</span>
          <span className="text-fg3 text-[9px]">{collapsed ? '▸' : '▾'}</span>
        </div>

        {!collapsed && (
          <div className="flex gap-px ml-auto">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={(e) => { e.stopPropagation(); setTab(t.id) }}
                className={clsx(
                  'text-[8px] px-2 py-0.5 transition-colors',
                  tab === t.id
                    ? 'bg-acc/15 text-acc border border-acc/30'
                    : 'text-fg3 hover:text-fg2 border border-transparent'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-px bg-border" style={{ height: '320px' }}>
          {/* Main content area */}
          <div className="bg-bg1 min-h-0">
            {tab === 'map' && (
              <TfmsMap
                flights={flights}
                flowEvents={flowEvents}
                selectedFlight={selectedFlight}
                onSelectFlight={handleSelectFlight}
                airportConfigs={airportConfigs}
              />
            )}
            {tab === 'board' && (
              <AirportBoard
                flights={flights}
                airport={selectedAirport}
                onChangeAirport={setSelectedAirport}
                onSelectFlight={handleSelectFlight}
              />
            )}
            {tab === 'delays' && (
              <DelayBoard
                flowEvents={flowEvents}
                flights={flights}
                onSelectAirport={handleSelectAirport}
              />
            )}
          </div>

          {/* Right sidebar: flight timeline (always visible) */}
          <div className="bg-bg1 min-h-0 overflow-hidden hidden md:block">
            <FlightTimeline flight={selectedFlight} />
          </div>
        </div>
      )}
    </div>
  )
}
