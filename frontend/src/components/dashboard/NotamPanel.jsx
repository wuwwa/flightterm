import clsx from 'clsx'
import { useSwim } from '../../contexts/SwimContext'

const KW_COLORS = {
  RWY: 'text-red', TWY: 'text-ylw', APRON: 'text-ylw',
  AIRSPACE: 'text-red', SVC: 'text-cyn', NAV: 'text-cyn', OBST: 'text-mag',
}

function Badge({ keyword }) {
  if (!keyword) return null
  return (
    <span className={clsx('text-[7px] border px-0.5 rounded leading-none', KW_COLORS[keyword] || 'text-fg3', 'border-current/30')}>
      {keyword}
    </span>
  )
}

export default function NotamPanel({ backendOk }) {
  const { status, tfrs, notamAirports: airports } = useSwim()

  const fns = status?.feeds?.fns
  const connected = fns?.connected

  return (
    <div className="bg-bg1 h-full min-h-0 flex flex-col">
      <div className="py-0.5 px-2 text-[9px] text-fg3 bg-bg2 border-b border-border flex justify-between shrink-0">
        <span>NOTAMs</span>
        <span className="flex items-center gap-1">
          {fns ? (
            <>
              <span className={clsx('inline-block w-1 h-1 rounded-full', connected ? 'bg-grn' : 'bg-red')} />
              <span className={connected ? 'text-grn' : 'text-red'}>{connected ? 'live' : 'off'}</span>
            </>
          ) : <span className="text-fg3">—</span>}
        </span>
      </div>

      <div className="px-2 py-0.5 flex gap-2 text-[9px] border-b border-white/5 shrink-0">
        <span className="text-fg3">TFRs:</span>
        {tfrs.length === 0 ? (
          <span className="text-grn">none</span>
        ) : (
          <span className="text-red font-bold">{tfrs.length} active</span>
        )}
        {airports.length > 0 && (
          <span className="text-fg3">{airports.length} apt</span>
        )}
      </div>

      {tfrs.length > 0 && (
        <div className="border-b border-border max-h-10 overflow-y-auto shrink-0">
          {tfrs.slice(0, 3).map((tfr, i) => (
            <div key={tfr.id || i} className="flex gap-1 py-0.5 px-2 text-[8px] border-b border-white/3" title={tfr.text || 'TFR active'}>
              <span className="text-red font-bold shrink-0">TFR</span>
              <span className="text-acc shrink-0">{tfr.location || '—'}</span>
              <span className="text-fg2 truncate flex-1">{tfr.text?.substring(0, 40) || 'restriction active'}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {airports.map((ap, i) => {
          const badges = [ap.rwy && 'RWY', ap.twy && 'TWY', ap.apron && 'APRON', ap.airspace && 'AIRSPACE', ap.svc && 'SVC', ap.obst && 'OBST'].filter(Boolean)
          return (
            <div key={ap.location || i} className="flex items-center gap-1 py-0.5 px-2 text-[8px] border-b border-white/3" title={`${ap.location}: ${ap.count} NOTAMs (${badges.join(', ')})`}>
              <span className="text-acc font-bold w-7 shrink-0">{ap.location}</span>
              <span className="text-fg3 w-3 text-right shrink-0">{ap.count}</span>
              <div className="flex gap-0.5 flex-1 overflow-hidden">
                {badges.map(kw => <Badge key={kw} keyword={kw} />)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
