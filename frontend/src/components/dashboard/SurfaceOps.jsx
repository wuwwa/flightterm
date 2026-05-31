import { useState } from 'react'
import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'
import { FlightLifecyclePopup, AirportMovementsPopup } from './SwimPopup'
import SwimWarming from '../SwimWarming'

function timeAgo(ts) {
  if (!ts) return ''
  const now = Date.now()
  const t = new Date(ts + (ts.endsWith('Z') ? '' : 'Z')).getTime()
  const sec = Math.round((now - t) / 1000)
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return ts.substring(11, 16) + 'z'
}

// Extract aircraft type from text like "OFF AAL2604 A319 rwy 18L at KCLT"
function acType(text) {
  if (!text) return null
  const parts = text.split(' ')
  return parts.length >= 3 && parts[2].length >= 2 && parts[2].length <= 5 && parts[2] !== 'rwy' ? parts[2] : null
}

export default function SurfaceOps({ backendOk }) {
  const { status, oooi } = useSwim()
  const stats = status?.surface
  const [selectedFlight, setSelectedFlight] = useState(null)
  const [selectedAirport, setSelectedAirport] = useState(null)

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      <div className="py-0.5 px-2 text-[9px] bg-bg2 border-b border-border flex justify-between shrink-0">
        <span className="text-fg3">live movements</span>
        <span className="text-fg3/50">{stats?.airports || 0} airports</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {oooi.length > 0 ? oooi.map((e, i) => {
          const apt = (e.airport || '').replace(/^K/, '')
          const type = acType(e.text)
          const rwy = e.runway?.split('/')[0]

          let verb, color
          if (e.event_type === 'OFF') { verb = 'departed'; color = 'text-grn' }
          else if (e.event_type === 'ON') { verb = 'landed at'; color = 'text-cyn' }
          else if (e.event_type === 'SPOT_OUT') { verb = 'pushback at'; color = 'text-ylw' }
          else if (e.event_type === 'SPOT_IN') { verb = 'at gate'; color = 'text-acc' }
          else { verb = e.event_type; color = 'text-fg3' }

          return (
            <div key={e.id || i} className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3">
              <span
                className="text-fg2 font-bold w-14 shrink-0 truncate cursor-pointer hover:text-acc"
                onClick={() => e.callsign && setSelectedFlight(e.callsign)}
                title={e.callsign ? `View ${e.callsign} lifecycle` : ''}
              >{e.callsign || '—'}</span>
              <span className={clsx('shrink-0', color)}>{verb}</span>
              <span
                className="text-acc font-bold shrink-0 cursor-pointer hover:underline"
                onClick={() => e.airport && setSelectedAirport(e.airport)}
                title={`View all movements at ${apt}`}
              >{apt}</span>
              {rwy && <span className="text-fg3/40">rwy {rwy}</span>}
              {type && <span className="text-fg3/30">{type}</span>}
              <span className="text-fg3/30 ml-auto shrink-0 tabular-nums">{timeAgo(e.received_at)}</span>
            </div>
          )
        }) : (
          <SwimWarming fallback={
            <div className="py-2 px-2 text-center text-fg3 text-[9px]">
              {stats?.airports > 0 ? 'waiting for movements...' : 'STDDS feed not connected'}
            </div>
          } />
        )}
      </div>

      {selectedFlight && (
        <FlightLifecyclePopup callsign={selectedFlight} onClose={() => setSelectedFlight(null)} />
      )}
      {selectedAirport && (
        <AirportMovementsPopup airport={selectedAirport} onClose={() => setSelectedAirport(null)} />
      )}
    </div>
  )
}
