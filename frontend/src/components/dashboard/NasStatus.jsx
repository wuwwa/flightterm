import { useState } from 'react'
import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'
import { FlowEventPopup } from './SwimPopup'
import SwimWarming from '../SwimWarming'

// ── Health assessment from NAS analytics ─────────────────────────────────────
function deriveHealth(nasSummary, flowEvents) {
  if (!nasSummary) return null
  const gs = nasSummary.groundStops || 0
  const gdp = nasSummary.gdps || 0
  const congested = nasSummary.congestionBuilding || 0
  const elevated = nasSummary.elevated || 0

  if (gs >= 3 || (gs >= 1 && gdp >= 3))
    return { level: 'SEVERE', color: 'text-red', bg: 'bg-red/10', border: 'border-red/30', desc: 'Major disruptions — multiple ground stops active' }
  if (gs >= 1)
    return { level: 'DEGRADED', color: 'text-red', bg: 'bg-red/5', border: 'border-red/20', desc: 'Ground stops active — expect significant delays' }
  if (gdp >= 3 || congested >= 3)
    return { level: 'IMPACTED', color: 'text-ylw', bg: 'bg-ylw/5', border: 'border-ylw/20', desc: 'Widespread delays — multiple programs active' }
  if (gdp >= 1 || congested >= 1)
    return { level: 'MODERATE', color: 'text-ylw', bg: 'bg-ylw/5', border: 'border-ylw/20', desc: 'Some delays — flow programs in effect' }
  if (elevated >= 2)
    return { level: 'ELEVATED', color: 'text-cyn', bg: 'bg-cyn/5', border: 'border-cyn/20', desc: 'Elevated traffic — monitor for developing delays' }
  return { level: 'NORMAL', color: 'text-grn', bg: 'bg-grn/5', border: 'border-grn/20', desc: 'NAS operating normally' }
}

// Event type to human-readable label
const EVENT_DESC = {
  GS: 'Ground Stop',
  GDP: 'Ground Delay Program',
  AFP: 'Airspace Flow Program',
  REROUTE: 'Reroute',
  RSTR: 'Restriction',
  CTOP: 'Collaborative Trajectory',
  FXA: 'Flow Constraint Area',
}

// Reason to short human label
function reasonLabel(reason) {
  if (!reason) return null
  const r = reason.toLowerCase()
  if (r.includes('weather') || r.includes('wx') || r.includes('wind') || r.includes('thunder') || r.includes('fog') || r.includes('snow') || r.includes('ice') || r.includes('ceil'))
    return 'weather'
  if (r.includes('volume') || r.includes('demand') || r.includes('capacity'))
    return 'volume'
  if (r.includes('equip') || r.includes('staff'))
    return 'equipment'
  if (r.includes('runway') || r.includes('rwy'))
    return 'runway'
  return reason.toLowerCase().substring(0, 16)
}

export default function NasStatus({ backendOk }) {
  const { status, flowEvents, nasSummary, warming } = useSwim()
  const [selectedAirport, setSelectedAirport] = useState(null)

  const feeds = status?.feeds || {}
  const tfmsStats = status?.tfms
  const connectedCount = Object.values(feeds).filter(f => f?.connected).length
  const health = deriveHealth(nasSummary, flowEvents)

  // Split flow events into active restrictions vs advisories
  const restrictions = flowEvents.filter(e => ['GS', 'GDP', 'AFP', 'CTOP', 'RSTR', 'FXA'].includes(e.event_type))
  const gs = restrictions.filter(e => e.event_type === 'GS')
  const gdps = restrictions.filter(e => e.event_type === 'GDP')
  const other = restrictions.filter(e => !['GS', 'GDP'].includes(e.event_type))

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      {/* Header with health assessment */}
      <div className="py-0.5 px-2 text-[9px] bg-bg2 border-b border-border flex justify-between items-center shrink-0">
        <span className="ft-chip ft-chip--green">nas status</span>
        <span className="flex items-center gap-1.5">
          {connectedCount > 0 ? (
            <span className="text-grn text-[8px]">{connectedCount} feed{connectedCount !== 1 ? 's' : ''}</span>
          ) : (
            <span className="text-fg3/40 text-[8px]">no feeds</span>
          )}
        </span>
      </div>

      {/* Health banner */}
      {health && (
        <div className={clsx('px-2 py-1 border-b', health.bg, health.border)}>
          <div className="flex items-center gap-1.5">
            <span className={clsx('text-[10px] font-bold', health.color)}>{health.level}</span>
            {nasSummary && (
              <span className="text-fg3 text-[8px] ml-auto">
                {nasSummary.totalAirports || 0} airports tracked
              </span>
            )}
          </div>
          <div className="text-[8px] text-fg3 mt-0.5">{health.desc}</div>
        </div>
      )}

      {/* Key metrics */}
      {tfmsStats && (
        <div className="grid grid-cols-4 gap-px bg-border border-b border-border shrink-0">
          <div className="bg-bg1 py-0.5 px-1.5 text-center" title="Active IFR flight plans tracked by TFMS">
            <div className="text-[11px] font-medium text-acc">{(tfmsStats.active_flights || 0).toLocaleString()}</div>
            <div className="text-[7px] text-fg3">IFR flights</div>
          </div>
          <div className="bg-bg1 py-0.5 px-1.5 text-center" title="Flight plan updates received in the last hour">
            <div className="text-[11px] font-medium text-fg2">{(tfmsStats.recent_plans || 0).toLocaleString()}</div>
            <div className="text-[7px] text-fg3">updates/hr</div>
          </div>
          <div className="bg-bg1 py-0.5 px-1.5 text-center" title="Airports where NO departures are allowed">
            <div className={clsx('text-[11px] font-medium', (tfmsStats.active_gs || 0) > 0 ? 'text-red font-bold' : 'text-grn')}>{tfmsStats.active_gs || 0}</div>
            <div className="text-[7px] text-fg3">ground stops</div>
          </div>
          <div className="bg-bg1 py-0.5 px-1.5 text-center" title="Airports where departures are delayed to manage arrival rate">
            <div className={clsx('text-[11px] font-medium', (tfmsStats.active_gdps || 0) > 0 ? 'text-ylw' : 'text-grn')}>{tfmsStats.active_gdps || 0}</div>
            <div className="text-[7px] text-fg3">delay pgms</div>
          </div>
        </div>
      )}

      {/* Active restrictions — the important stuff */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {gs.length > 0 && gs.map((ev, i) => (
          <div key={ev.id || `gs-${i}`} className="flex items-start gap-1 py-0.5 px-2 text-[8px] border-b border-red/10 bg-red/5 cursor-pointer hover:bg-red/10" onClick={() => ev.airport && setSelectedAirport(ev.airport)}>
            <span className="text-red font-bold shrink-0 w-4">GS</span>
            <span className="text-acc font-bold shrink-0">{ev.airport || '—'}</span>
            <div className="flex-1 min-w-0">
              <span className="text-fg2">No departures</span>
              {ev.reason && <span className="text-fg3"> — {reasonLabel(ev.reason)}</span>}
              {ev.delay_minutes > 0 && <span className="text-ylw ml-1">{Math.round(ev.delay_minutes)}min</span>}
            </div>
          </div>
        ))}
        {gdps.length > 0 && gdps.map((ev, i) => (
          <div key={ev.id || `gdp-${i}`} className="flex items-start gap-1 py-0.5 px-2 text-[8px] border-b border-ylw/10 bg-ylw/3 cursor-pointer hover:bg-ylw/8" onClick={() => ev.airport && setSelectedAirport(ev.airport)}>
            <span className="text-ylw font-bold shrink-0 w-4">GDP</span>
            <span className="text-acc font-bold shrink-0">{ev.airport || '—'}</span>
            <div className="flex-1 min-w-0">
              <span className="text-fg2">Arrivals delayed</span>
              {ev.reason && <span className="text-fg3"> — {reasonLabel(ev.reason)}</span>}
              {ev.delay_minutes > 0 && <span className="text-ylw ml-1">{Math.round(ev.delay_minutes)}min avg</span>}
            </div>
          </div>
        ))}
        {other.length > 0 && other.map((ev, i) => (
          <div key={ev.id || `oth-${i}`} className="flex items-start gap-1 py-0.5 px-2 text-[8px] border-b border-white/3 cursor-pointer hover:bg-bg2" onClick={() => (ev.airport || ev.facility) && setSelectedAirport(ev.airport || ev.facility)}>
            <span className="text-fg3 font-bold shrink-0 w-4">{ev.event_type}</span>
            <span className="text-acc shrink-0">{ev.airport || ev.facility || '—'}</span>
            <span className="text-fg3 truncate flex-1">{EVENT_DESC[ev.event_type] || ev.event_type}{ev.reason ? ` — ${reasonLabel(ev.reason)}` : ''}</span>
          </div>
        ))}
        {restrictions.length === 0 && connectedCount > 0 && (
          <div className="py-1.5 px-2 text-[8px] text-grn/80">No active restrictions</div>
        )}
        {connectedCount === 0 && (
          warming
            ? <SwimWarming />
            : <div className="py-1.5 px-2 text-[8px] text-fg3/50">SWIM feeds not connected — configure in .env</div>
        )}
      </div>

      {selectedAirport && (
        <FlowEventPopup airport={selectedAirport} onClose={() => setSelectedAirport(null)} />
      )}
    </div>
  )
}
