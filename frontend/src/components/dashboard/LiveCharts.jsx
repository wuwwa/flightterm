import { useMemo } from 'react'
import clsx from 'clsx'
import { detectPhase, PHASE } from '../../utils/anomaly'

// Terminal-style stats panel — same data the old recharts version computed,
// rendered as compact text rows instead of graphs.

export default function LiveCharts({ flights = [], trackHistory = {} }) {
  const dist = useMemo(() => {
    if (!flights.length) return null
    const airborne = flights.filter(f => !f.grounded)

    // Altitude bands (ft)
    const altBands = [
      { label: 'GND',        min: -Infinity, max: 500,    count: 0 },
      { label: '<FL100',     min: 500,       max: 10000,  count: 0 },
      { label: 'FL100-200',  min: 10000,     max: 20000,  count: 0 },
      { label: 'FL200-300',  min: 20000,     max: 30000,  count: 0 },
      { label: 'FL300-400',  min: 30000,     max: 40000,  count: 0 },
      { label: 'FL400+',     min: 40000,     max: Infinity, count: 0 },
    ]
    for (const f of flights) {
      if (f.grounded) { altBands[0].count++; continue }
      if (f.alt == null) continue
      const ft = f.alt * 3.281
      for (const b of altBands) { if (ft >= b.min && ft < b.max) { b.count++; break } }
    }

    // Speed bands (kt)
    const spdBands = [
      { label: '<100',     min: 0,   max: 100,   count: 0 },
      { label: '100-200',  min: 100, max: 200,   count: 0 },
      { label: '200-300',  min: 200, max: 300,   count: 0 },
      { label: '300-400',  min: 300, max: 400,   count: 0 },
      { label: '400-500',  min: 400, max: 500,   count: 0 },
      { label: '500+',     min: 500, max: Infinity, count: 0 },
    ]
    for (const f of flights) {
      if (f.vel == null || f.grounded) continue
      const kt = f.vel * 1.944
      for (const b of spdBands) { if (kt >= b.min && kt < b.max) { b.count++; break } }
    }

    // Vertical rate bands (fpm)
    const vrBands = [
      { label: 'descending', min: -Infinity, max: -200,    count: 0, color: 'text-ylw' },
      { label: 'level',      min: -200,      max: 200,     count: 0, color: 'text-fg2' },
      { label: 'climbing',   min: 200,       max: Infinity, count: 0, color: 'text-grn' },
    ]
    for (const f of flights) {
      if (f.vertRate == null || f.grounded) continue
      const fpm = f.vertRate * 196.85
      for (const b of vrBands) { if (fpm >= b.min && fpm < b.max) { b.count++; break } }
    }

    // Top routes from TFMS
    const rc = {}
    for (const f of flights) {
      const d = f.tfms?.dep_arpt?.replace(/^K/, ''), a = f.tfms?.arr_arpt?.replace(/^K/, '')
      if (d && a) { const k = `${d}→${a}`; rc[k] = (rc[k] || 0) + 1 }
    }
    const topRoutes = Object.entries(rc).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([r, c]) => ({ route: r, count: c }))

    // Phase counts
    const phases = { Climb: 0, Cruise: 0, Descent: 0, Approach: 0, Ground: 0 }
    for (const f of flights) {
      const hist = trackHistory[f.icao]
      const p = hist?.length >= 2 ? detectPhase(hist) : (f.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
      if (p === PHASE.CLIMB) phases.Climb++
      else if (p === PHASE.CRUISE) phases.Cruise++
      else if (p === PHASE.DESCENT) phases.Descent++
      else if (p === PHASE.APPROACH) phases.Approach++
      else if (p === PHASE.GROUND) phases.Ground++
    }

    // KPIs
    const withTfms = flights.filter(f => f.tfms).length
    const alts = airborne.filter(f => f.alt != null).map(f => f.alt * 3.281)
    const avgAlt = alts.length > 0 ? Math.round(alts.reduce((a, b) => a + b, 0) / alts.length) : 0

    return { altBands, spdBands, vrBands, topRoutes, phases, total: flights.length, airborne: airborne.length, withTfms, avgAlt }
  }, [flights, trackHistory])

  if (!dist) return <div className="py-4 text-center text-fg3 text-[10px]">Waiting for flight data...</div>

  return (
    <div className="bg-bg1">
      {/* KPIs */}
      <div className="grid grid-cols-4 gap-px bg-border">
        <KPI label="Tracked"         value={dist.total.toLocaleString()}     color="text-acc" />
        <KPI label="Airborne"        value={dist.airborne.toLocaleString()}  color="text-grn" />
        <KPI label="With Flight Plan" value={dist.withTfms.toLocaleString()} color="text-cyn" />
        <KPI label="Avg Altitude"    value={`FL${Math.round(dist.avgAlt / 100)}`} color="text-ylw" />
      </div>

      {/* Stats grid: phase / altitude / speed / vertical rate */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border-t border-border">
        <StatColumn title="Phase">
          <StatRow label="Climb"    value={dist.phases.Climb}    color="text-grn" />
          <StatRow label="Cruise"   value={dist.phases.Cruise}   color="text-cyn" />
          <StatRow label="Descent"  value={dist.phases.Descent}  color="text-ylw" />
          <StatRow label="Approach" value={dist.phases.Approach} color="text-mag" />
          <StatRow label="Ground"   value={dist.phases.Ground}   color="text-fg3" />
        </StatColumn>

        <StatColumn title={`Altitude (${dist.airborne} airborne)`}>
          {dist.altBands.map(b => (
            <StatRow key={b.label} label={b.label} value={b.count} color="text-fg2" />
          ))}
        </StatColumn>

        <StatColumn title="Speed (kt)">
          {dist.spdBands.map(b => (
            <StatRow key={b.label} label={b.label} value={b.count} color="text-fg2" />
          ))}
        </StatColumn>

        <StatColumn title="Vertical Rate">
          {dist.vrBands.map(b => (
            <StatRow key={b.label} label={b.label} value={b.count} color={b.color} />
          ))}
        </StatColumn>
      </div>

      {/* Top routes */}
      <div className="bg-bg1 border-t border-border px-2 py-1">
        <div className="text-[8px] text-fg3/50 uppercase tracking-wide mb-0.5">
          Busiest Routes <span className="text-fg3/30">({dist.withTfms} with TFMS)</span>
        </div>
        {dist.topRoutes.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-0">
            {dist.topRoutes.map(r => (
              <div key={r.route} className="flex items-baseline justify-between text-[9px] tabular-nums border-b border-white/3 py-0.5">
                <span className="text-fg2 truncate">{r.route}</span>
                <span className="text-mag font-bold ml-2">{r.count}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-fg3/40 text-[9px] py-1">No TFMS route data</div>
        )}
      </div>
    </div>
  )
}

function StatColumn({ title, children }) {
  return (
    <div className="bg-bg1 px-2 py-1">
      <div className="text-[8px] text-fg3/50 uppercase tracking-wide mb-0.5">{title}</div>
      <div className="space-y-0">{children}</div>
    </div>
  )
}

function StatRow({ label, value, color }) {
  const empty = !value
  return (
    <div className="flex items-baseline justify-between text-[9px] tabular-nums border-b border-white/3 py-0.5">
      <span className="text-fg3">{label}</span>
      <span className={clsx('font-bold', empty ? 'text-fg3/30' : color)}>{value}</span>
    </div>
  )
}

function KPI({ label, value, color }) {
  const isEmpty = value === '0' || value === 0 || value === '—' || value == null
  return (
    <div className="bg-bg1 px-2 py-1 text-center">
      <div className={`text-sm font-bold tabular-nums ${isEmpty ? 'text-fg3/30' : color}`}>{isEmpty ? '—' : value}</div>
      <div className="text-[7px] text-fg3/50">{label}</div>
    </div>
  )
}
