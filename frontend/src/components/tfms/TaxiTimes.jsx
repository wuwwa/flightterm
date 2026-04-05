import { useMemo } from 'react'
import clsx from 'clsx'

function taxiColor(min) {
  if (min == null) return 'text-fg3'
  if (min > 20) return 'text-red'
  if (min >= 10) return 'text-ylw'
  return 'text-grn'
}

export default function TaxiTimes({ taxiData }) {
  const sorted = useMemo(() => {
    if (!taxiData || !taxiData.length) return []
    return [...taxiData]
      .sort((a, b) => (b.avgTaxiOutMin || 0) - (a.avgTaxiOutMin || 0))
      .slice(0, 10)
  }, [taxiData])

  return (
    <div className="h-full flex flex-col bg-bg1">
      <div className="px-2 py-0.5 text-[9px] bg-bg2 border-b border-border flex justify-between shrink-0">
        <span className="text-cyn font-bold">TAXI TIMES</span>
        <span className="text-fg3">{sorted.length} airports</span>
      </div>

      {sorted.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-fg3 text-[9px]">
          no taxi time data available
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Table header */}
          <div className="flex items-center gap-0 px-2 py-0.5 text-[8px] text-fg3 bg-bg2/50 border-b border-border sticky top-0">
            <span className="w-8 shrink-0">APT</span>
            <span className="w-12 text-right shrink-0" title="Average taxi out time">avg out</span>
            <span className="w-12 text-right shrink-0" title="Average taxi in time">avg in</span>
            <span className="w-12 text-right shrink-0" title="Maximum taxi out time">max out</span>
            <span className="w-12 text-right shrink-0" title="Maximum taxi in time">max in</span>
            <span className="w-10 text-right shrink-0" title="Number of samples">n</span>
          </div>

          {/* Table rows */}
          {sorted.map(ap => (
            <div
              key={ap.airport}
              className="flex items-center gap-0 px-2 py-0.5 text-[8px] border-b border-white/3 hover:bg-bg2 transition-colors"
              title={`${ap.airport}: avg out ${ap.avgTaxiOutMin?.toFixed(1) || '--'}m, avg in ${ap.avgTaxiInMin?.toFixed(1) || '--'}m, max out ${ap.maxTaxiOut || '--'}m, max in ${ap.maxTaxiIn || '--'}m, ${ap.samples || 0} samples`}
            >
              <span className="text-acc font-bold w-8 shrink-0" title={ap.airport}>
                {ap.airport?.replace(/^K/, '')}
              </span>
              <span className={clsx('w-12 text-right tabular-nums shrink-0', taxiColor(ap.avgTaxiOutMin))}>
                {ap.avgTaxiOutMin != null ? `${ap.avgTaxiOutMin.toFixed(1)}m` : '--'}
              </span>
              <span className={clsx('w-12 text-right tabular-nums shrink-0', taxiColor(ap.avgTaxiInMin))}>
                {ap.avgTaxiInMin != null ? `${ap.avgTaxiInMin.toFixed(1)}m` : '--'}
              </span>
              <span className={clsx('w-12 text-right tabular-nums shrink-0', taxiColor(ap.maxTaxiOut))}>
                {ap.maxTaxiOut != null ? `${Math.round(ap.maxTaxiOut)}m` : '--'}
              </span>
              <span className={clsx('w-12 text-right tabular-nums shrink-0', taxiColor(ap.maxTaxiIn))}>
                {ap.maxTaxiIn != null ? `${Math.round(ap.maxTaxiIn)}m` : '--'}
              </span>
              <span className="w-10 text-right text-fg3 tabular-nums shrink-0">
                {ap.samples || 0}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
