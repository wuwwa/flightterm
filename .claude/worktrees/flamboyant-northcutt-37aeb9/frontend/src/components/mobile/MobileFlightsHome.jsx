import clsx from 'clsx'
import FlightTable from '../FlightTable'
import NasMap from '../dashboard/NasMap'
import { useSwim } from '../../contexts/SwimContext'

// ── Stat cell ───────────────────────────────────────────────────────────────
function StatCell({ label, value, color, pulse }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-1">
      <div className={clsx('font-bold tabular-nums text-[12px] leading-tight', color, pulse && 'animate-pulse')}>
        {value}
      </div>
      <div className="text-fg3 text-[7px] uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  )
}

export default function MobileFlightsHome({
  flights,
  filter,
  onFilterChange,
  selectedIcao,
  enrichCache,
  anomalies,
  trackHistory,
  openskyUsage,
  aeroSpend,
  region,
  backendOk,
  onSelect,
  onArrived,
  onDeparted,
}) {
  const { status: swimStatus, nasSummary } = useSwim()
  const tfms = swimStatus?.tfms || {}
  const notams = swimStatus?.notams || {}
  const anomCount = Object.keys(anomalies).length
  const health = nasSummary?.health

  return (
    <div className="h-full flex flex-col">
      {/* ── Filter row ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 bg-bg2/40 border-b border-border px-3 py-1.5 flex items-center gap-2">
        <span className="text-grn select-none text-[11px]">❯</span>
        <input
          className="bg-transparent border-none outline-none text-fg text-[11px] flex-1 caret-fg font-mono min-w-0 placeholder:text-fg3/30"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="callsign, icao, type, airport…"
        />
        {filter && (
          <button onClick={() => onFilterChange('')} className="text-fg3 hover:text-fg text-[10px] px-1">✕</button>
        )}
      </div>

      {/* ── Flight table — takes primary space ──────────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col">
        <FlightTable
          flights={flights}
          filter={filter}
          selectedIcao={selectedIcao}
          enrichCache={enrichCache}
          anomalies={anomalies}
          trackHistory={trackHistory}
          openskyUsage={openskyUsage}
          aeroSpend={aeroSpend}
          onSelect={onSelect}
          onArrived={onArrived}
          onDeparted={onDeparted}
        />
      </div>

      {/* ── Stats strip ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 bg-bg2/60 border-t border-border flex items-stretch divide-x divide-border">
        <StatCell
          label="anomalies"
          value={anomCount}
          color={anomCount > 0 ? 'text-red' : 'text-fg3'}
          pulse={anomCount > 0}
        />
        <StatCell
          label="gnd stops"
          value={tfms.active_gs ?? 0}
          color={tfms.active_gs > 0 ? 'text-red' : 'text-fg3'}
          pulse={tfms.active_gs > 0}
        />
        <StatCell
          label="gdps"
          value={tfms.active_gdps ?? 0}
          color={tfms.active_gdps > 0 ? 'text-ylw' : 'text-fg3'}
        />
        <StatCell
          label="tfrs"
          value={notams.active_tfrs ?? 0}
          color={notams.active_tfrs > 0 ? 'text-ylw' : 'text-fg3'}
        />
        <StatCell
          label="health"
          value={health != null ? health : '—'}
          color={health == null ? 'text-fg3' : health >= 80 ? 'text-grn' : health >= 50 ? 'text-ylw' : 'text-red'}
        />
      </div>
    </div>
  )
}
