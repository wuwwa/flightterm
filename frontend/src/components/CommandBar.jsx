import { useState, useEffect } from 'react'
import clsx from 'clsx'
import { useSwim } from '../contexts/SwimContext'

const REGIONS = ['global', 'usa', 'europe', 'asia', 'atlantic']

function Pill({ children, active, danger, onClick }) {
  return (
    <button
      className={clsx(
        'h-5 px-1.5 border text-[9px] leading-none uppercase tracking-wide transition-colors',
        'inline-flex items-center justify-center shrink-0',
        danger ? 'border-red/25 text-red/85 bg-red/5 hover:border-red/50 hover:text-red'
          : active ? 'border-acc/55 text-acc bg-acc/8'
          : 'border-border text-fg3 bg-bg1/40 hover:text-fg2 hover:border-border2',
      )}
      onClick={onClick}
    >{children}</button>
  )
}

function Metric({ value, label, tone = 'text-fg' }) {
  return (
    <span className="h-5 px-1.5 border border-border/80 bg-bg1/35 inline-flex items-center gap-1 shrink-0">
      <span className={clsx('tabular-nums text-[11px] leading-none', tone)}>{value}</span>
      <span className="text-fg3 text-[8px] uppercase tracking-wide leading-none">{label}</span>
    </span>
  )
}

export default function CommandBar({
  stats, backendOk, lastFetchAt, pollInterval,
  onClearLog, onOpenSettings, onOpenUsage,
  region, onRegionChange,
}) {
  const [time, setTime] = useState('')
  const [remaining, setRemaining] = useState(null)
  const { status: swimStatus } = useSwim()

  // UTC clock
  useEffect(() => {
    const tick = () => setTime(new Date().toISOString().substring(11, 19) + 'z')
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Poll countdown
  useEffect(() => {
    if (!lastFetchAt) { setRemaining(null); return }
    const intervalSec = Math.round((pollInterval || 45000) / 1000)
    const tick = () => setRemaining(Math.max(0, intervalSec - Math.floor((Date.now() - lastFetchAt) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [lastFetchAt, pollInterval])

  const tfms = swimStatus?.tfms
  const notams = swimStatus?.notams
  const feeds = swimStatus?.feeds || {}
  return (
    <div className="bg-bg2 border-b border-border px-1.5 sm:px-2 py-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[9px] shrink-0">
      {/* Left: branding + headline counts */}
      <span className="ft-chip ft-chip--accent">
        flightterm
      </span>
      <Metric value={(stats.total ?? 0).toLocaleString()} label="ac" />
      <span className="hidden sm:inline-flex">
        <Metric value={(stats.airborne ?? 0).toLocaleString()} label="air" tone="text-grn" />
      </span>

      {/* SWIM feed indicators — individual dots per feed */}
      <div className="hidden sm:flex items-center h-5 gap-1 px-1.5 border border-border/80 bg-bg1/35">
        {['fns', 'tfms', 'sfdps', 'itws', 'stdds'].map(name => {
          const f = feeds[name]
          const on = f?.connected
          return (
            <span key={name} className="flex items-center gap-1">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${on ? 'bg-grn' : f?.enabled ? 'bg-red' : 'bg-fg3/25'}`} />
              <span className={clsx('text-[8px] uppercase tracking-wide', on ? 'text-fg3' : 'text-fg3/30')}>{name}</span>
            </span>
          )
        })}
      </div>
      {tfms?.active_flights > 0 && (
        <span className="hidden sm:inline-flex">
          <Metric value={tfms.active_flights.toLocaleString()} label="flights" tone="text-fg2" />
        </span>
      )}
      {tfms?.active_gs > 0 && (
        <span className="h-5 px-1.5 bg-red/12 text-red text-[9px] uppercase inline-flex items-center border border-red/35 animate-pulse">
          {tfms.active_gs} GS
        </span>
      )}
      {tfms?.active_gdps > 0 && (
        <span className="h-5 px-1.5 bg-ylw/12 text-ylw text-[9px] uppercase inline-flex items-center border border-ylw/35">
          {tfms.active_gdps} GDP
        </span>
      )}
      {notams?.active_tfrs > 0 && (
        <span className="h-5 px-1.5 bg-red/10 text-red text-[9px] uppercase inline-flex items-center border border-red/30">
          {notams.active_tfrs} TFR
        </span>
      )}

      {/* Region selector */}
      <div className="flex gap-0.5 items-center">
        {REGIONS.map(r => (
          <Pill key={r} active={region === r} onClick={() => onRegionChange(r)}>{r}</Pill>
        ))}
      </div>

      {/* Controls */}
      <Pill onClick={onOpenSettings}>settings</Pill>
      <Pill onClick={onOpenUsage}>usage</Pill>
      <Pill danger onClick={onClearLog}>clear</Pill>

      {/* Right: live status + clock */}
      <div className="h-5 px-1.5 border border-border/80 bg-bg1/35 flex items-center gap-1.5 ml-auto shrink-0">
        {remaining != null && (
          <span className={clsx(
            'tabular-nums text-[9px]',
            remaining > 0 ? 'text-grn' : 'text-ylw animate-pulse'
          )}>
            {remaining > 0 ? `${remaining}s` : 'now'}
          </span>
        )}
        {backendOk && lastFetchAt ? (
          <span className="animate-blink text-grn">●</span>
        ) : (
          <span className={backendOk ? 'text-ylw' : 'text-red'}>○</span>
        )}
        <span className="text-fg3 tabular-nums text-[9px]">{time}</span>
      </div>
    </div>
  )
}
