import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'

export default function MobileHeader({ stats, region, anomalies, logEntries, backendOk, lastFetchAt, mobileTime, onOpenSettings, onOpenUsage }) {
  const { status: swimStatus } = useSwim()
  const feeds = swimStatus?.feeds || {}
  const anomCount = Object.keys(anomalies).length

  // Count recent errors/warnings
  const errCount = logEntries.filter(e => e.type === 'err').length
  const warnCount = logEntries.filter(e => e.type === 'warn').length

  return (
    <div className="bg-bg2 border-b border-border shrink-0">
      {/* Row 1: branding · counts · live dot · clock */}
      <div className="px-2.5 pt-1.5 pb-0.5 flex items-center gap-1.5 text-[10px]">
        <span className="text-acc font-bold text-[12px] tracking-tight">flightterm</span>
        <span className="text-border2">|</span>
        <span className="text-fg font-bold tabular-nums text-[11px]">{(stats.total ?? 0).toLocaleString()}</span>
        <span className="text-fg3 text-[7px] uppercase">ac</span>
        <span className="text-grn font-bold tabular-nums text-[11px]">{(stats.airborne ?? 0).toLocaleString()}</span>
        <span className="text-fg3 text-[7px] uppercase">air</span>

        <div className="flex-1" />

        {anomCount > 0 && (
          <span className="bg-red/15 text-red text-[8px] font-bold px-1 py-px rounded border border-red/40 animate-pulse">
            {anomCount}!
          </span>
        )}
        {errCount > 0 && (
          <span className="text-[8px] font-bold text-red">{errCount}e</span>
        )}
        {warnCount > 0 && (
          <span className="text-[8px] font-bold text-ylw">{warnCount}w</span>
        )}
        {backendOk && lastFetchAt ? (
          <span className="animate-blink text-grn text-[10px]">●</span>
        ) : (
          <span className={clsx('text-[10px]', backendOk ? 'text-ylw' : 'text-red')}>○</span>
        )}
        <button onClick={onOpenSettings} className="text-fg3 hover:text-fg2 text-[9px] px-1 cursor-pointer">⚙</button>
        <button onClick={onOpenUsage} className="text-fg3 hover:text-fg2 text-[9px] px-0.5 cursor-pointer">$</button>
        <span className="text-fg3 tabular-nums text-[9px]">{mobileTime}</span>
      </div>

      {/* Row 2: SWIM feeds · region */}
      <div className="px-2.5 pb-1.5 pt-0.5 flex items-center gap-1.5 text-[8px]">
        {/* SWIM feed dots */}
        <div className="flex items-center gap-1">
          {['fns', 'tfms', 'sfdps', 'itws', 'stdds'].map(name => {
            const f = feeds[name]
            const on = f?.connected
            return (
              <span key={name} className="flex items-center gap-0.5">
                <span className={clsx('inline-block w-1 h-1 rounded-full', on ? 'bg-grn' : f?.enabled ? 'bg-red' : 'bg-fg3/30')} />
                <span className={clsx('text-[7px] uppercase', on ? 'text-fg3' : 'text-fg3/30')}>{name}</span>
              </span>
            )
          })}
        </div>

        <span className="text-border2">|</span>

        {/* Region indicator */}
        <span className={clsx('text-[9px] font-bold uppercase tracking-wider', 'text-acc')}>
          {region}
        </span>
      </div>
    </div>
  )
}
