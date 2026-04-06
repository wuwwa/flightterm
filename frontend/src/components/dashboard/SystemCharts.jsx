import { useMemo } from 'react'
import clsx from 'clsx'
import { BarChart, Bar, ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, PieChart, Pie } from 'recharts'
import { detectPhase, PHASE } from '../../utils/anomaly'

const C = {
  acc: '#22d3ee', grn: '#4ade80', ylw: '#facc15', red: '#f87171',
  mag: '#c084fc', cyn: '#06b6d4', fg3: '#6b7280', fg2: '#9ca3af',
}

const PHASE_COLORS = {
  [PHASE.GROUND]: C.fg3, [PHASE.CLIMB]: C.grn, [PHASE.CRUISE]: C.cyn,
  [PHASE.DESCENT]: C.ylw, [PHASE.APPROACH]: C.mag, [PHASE.UNKNOWN]: '#374151',
}
const PHASE_LABELS = {
  [PHASE.GROUND]: 'Ground', [PHASE.CLIMB]: 'Climbing', [PHASE.CRUISE]: 'Cruise',
  [PHASE.DESCENT]: 'Descending', [PHASE.APPROACH]: 'Approach', [PHASE.UNKNOWN]: 'Unknown',
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-bg2 border border-border rounded px-2 py-1 text-[9px] shadow-lg">
      {label && <div className="text-fg3 mb-0.5">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-fg2">{p.name}: {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}</span>
        </div>
      ))}
    </div>
  )
}

export default function SystemCharts({ backendOk, flights = [], trackHistory = {}, enrichCache = {} }) {
  const analysis = useMemo(() => {
    if (!flights.length) return null

    // ── Altitude distribution (flight levels) ───────────────────────────
    const altBands = [
      { label: 'GND', min: -Infinity, max: 100, count: 0 },
      { label: '<5K', min: 100, max: 5000, count: 0 },
      { label: '5-10K', min: 5000, max: 10000, count: 0 },
      { label: '10-18K', min: 10000, max: 18000, count: 0 },
      { label: 'FL180-250', min: 18000, max: 25000, count: 0 },
      { label: 'FL250-350', min: 25000, max: 35000, count: 0 },
      { label: 'FL350-410', min: 35000, max: 41000, count: 0 },
      { label: '>FL410', min: 41000, max: Infinity, count: 0 },
    ]
    for (const f of flights) {
      if (f.grounded) { altBands[0].count++; continue }
      if (f.alt == null) continue
      const ft = f.alt * 3.281
      for (const band of altBands) {
        if (ft >= band.min && ft < band.max) { band.count++; break }
      }
    }

    // ── Phase breakdown ─────────────────────────────────────────────────
    const phases = {}
    for (const f of flights) {
      const hist = trackHistory[f.icao]
      const phase = hist?.length >= 2 ? detectPhase(hist) : (f.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
      phases[phase] = (phases[phase] || 0) + 1
    }
    const phaseData = Object.entries(phases)
      .map(([phase, count]) => ({ phase, label: PHASE_LABELS[phase] || phase, count, color: PHASE_COLORS[phase] || C.fg3 }))
      .sort((a, b) => b.count - a.count)

    // ── Speed vs altitude scatter (sample for performance) ──────────────
    const scatter = []
    const step = Math.max(1, Math.floor(flights.length / 500))
    for (let i = 0; i < flights.length; i += step) {
      const f = flights[i]
      if (f.alt == null || f.vel == null || f.grounded) continue
      const altFt = Math.round(f.alt * 3.281)
      const spdKt = Math.round(f.vel * 1.944)
      if (altFt < 0 || spdKt < 0) continue
      scatter.push({ alt: altFt, spd: spdKt, icao: f.icao, cs: f.callsign })
    }

    // ── Top routes from TFMS ────────────────────────────────────────────
    const routeCounts = {}
    for (const f of flights) {
      const dep = f.tfms?.dep_arpt?.replace(/^K/, '')
      const arr = f.tfms?.arr_arpt?.replace(/^K/, '')
      if (dep && arr) {
        const key = `${dep}→${arr}`
        routeCounts[key] = (routeCounts[key] || 0) + 1
      }
    }
    const topRoutes = Object.entries(routeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([route, count]) => ({ route, count }))

    // ── Country distribution ────────────────────────────────────────────
    const countryCounts = {}
    for (const f of flights) {
      const c = f.country || 'Unknown'
      countryCounts[c] = (countryCounts[c] || 0) + 1
    }
    const topCountries = Object.entries(countryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([country, count]) => ({ country: country.length > 12 ? country.substring(0, 10) + '…' : country, count }))

    // ── KPIs ────────────────────────────────────────────────────────────
    const airborne = flights.filter(f => !f.grounded).length
    const grounded = flights.length - airborne
    const withTfms = flights.filter(f => f.tfms).length
    const military = flights.filter(f => f.mil).length
    const avgAlt = airborne > 0
      ? Math.round(flights.filter(f => !f.grounded && f.alt != null).reduce((s, f) => s + f.alt * 3.281, 0) / airborne)
      : 0
    const avgSpd = airborne > 0
      ? Math.round(flights.filter(f => !f.grounded && f.vel != null).reduce((s, f) => s + f.vel * 1.944, 0) / airborne)
      : 0

    return { altBands, phaseData, scatter, topRoutes, topCountries, airborne, grounded, withTfms, military, avgAlt, avgSpd }
  }, [flights, trackHistory])

  if (!analysis) {
    return <div className="py-4 text-center text-fg3 text-[10px]">Waiting for flight data...</div>
  }

  return (
    <div className="space-y-px bg-border">
      {/* KPI row */}
      <div className="grid grid-cols-6 gap-px bg-border">
        <KPI label="Tracked" value={flights.length.toLocaleString()} color="text-acc" />
        <KPI label="Airborne" value={analysis.airborne.toLocaleString()} color="text-grn" />
        <KPI label="On Ground" value={analysis.grounded.toLocaleString()} color="text-fg3" />
        <KPI label="With Flight Plan" value={analysis.withTfms.toLocaleString()} color="text-cyn" />
        <KPI label="Avg Altitude" value={`FL${Math.round(analysis.avgAlt / 100)}`} color="text-ylw" />
        <KPI label="Avg Speed" value={`${analysis.avgSpd}kt`} color="text-acc" />
      </div>

      {/* Charts row 1: Altitude distribution + Phase breakdown + Speed vs Alt */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">
        {/* Altitude distribution */}
        <div className="bg-bg1 p-2">
          <div className="text-[9px] text-fg3/50 uppercase mb-1">Altitude Distribution</div>
          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={analysis.altBands}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 8, fill: '#6b7280' }} />
              <YAxis tick={{ fontSize: 8, fill: '#6b7280' }} width={30} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="count" name="Aircraft" radius={[2, 2, 0, 0]}>
                {analysis.altBands.map((b, i) => (
                  <Cell key={i} fill={i === 0 ? C.fg3 : i < 3 ? C.grn : i < 5 ? C.cyn : C.ylw} fillOpacity={0.7} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Phase breakdown */}
        <div className="bg-bg1 p-2">
          <div className="text-[9px] text-fg3/50 uppercase mb-1">Flight Phase</div>
          <div className="flex items-center gap-2">
            <ResponsiveContainer width="50%" height={130}>
              <PieChart>
                <Pie data={analysis.phaseData} dataKey="count" nameKey="label" cx="50%" cy="50%" outerRadius={50} innerRadius={25} strokeWidth={0}>
                  {analysis.phaseData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-0.5">
              {analysis.phaseData.map(d => (
                <div key={d.phase} className="flex items-center gap-1.5 text-[9px]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
                  <span className="text-fg3 flex-1">{d.label}</span>
                  <span className="text-fg2 tabular-nums font-bold">{d.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Speed vs Altitude scatter */}
        <div className="bg-bg1 p-2">
          <div className="text-[9px] text-fg3/50 uppercase mb-1">Flight Envelope (speed vs altitude)</div>
          <ResponsiveContainer width="100%" height={130}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="spd" name="Speed" unit="kt" tick={{ fontSize: 8, fill: '#6b7280' }} />
              <YAxis dataKey="alt" name="Altitude" unit="ft" tick={{ fontSize: 8, fill: '#6b7280' }} width={40} tickFormatter={v => v >= 1000 ? `${Math.round(v/1000)}K` : v} />
              <Tooltip content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const d = payload[0]?.payload
                return (
                  <div className="bg-bg2 border border-border rounded px-2 py-1 text-[9px] shadow-lg">
                    <div className="text-acc font-bold">{d?.cs || d?.icao}</div>
                    <div className="text-fg2">{d?.alt?.toLocaleString()}ft / {d?.spd}kt</div>
                  </div>
                )
              }} />
              <Scatter data={analysis.scatter} fill={C.acc} fillOpacity={0.4} r={2} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Charts row 2: Top routes + Country distribution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border">
        {/* Top routes */}
        <div className="bg-bg1 p-2">
          <div className="text-[9px] text-fg3/50 uppercase mb-1">Busiest Routes (TFMS)</div>
          {analysis.topRoutes.length > 0 ? (
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={analysis.topRoutes} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 8, fill: '#6b7280' }} />
                <YAxis dataKey="route" type="category" tick={{ fontSize: 8, fill: '#9ca3af' }} width={70} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="count" name="Flights" fill={C.mag} fillOpacity={0.7} radius={[0, 2, 2, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-[130px] flex items-center justify-center text-fg3 text-[9px]">No TFMS route data</div>}
        </div>

        {/* Country distribution */}
        <div className="bg-bg1 p-2">
          <div className="text-[9px] text-fg3/50 uppercase mb-1">Registration Country</div>
          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={analysis.topCountries} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis type="number" tick={{ fontSize: 8, fill: '#6b7280' }} />
              <YAxis dataKey="country" type="category" tick={{ fontSize: 8, fill: '#9ca3af' }} width={75} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="count" name="Aircraft" fill={C.grn} fillOpacity={0.6} radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

function KPI({ label, value, color }) {
  return (
    <div className="bg-bg1 px-2 py-1 text-center">
      <div className={clsx('text-sm font-bold tabular-nums', color)}>{value}</div>
      <div className="text-[7px] text-fg3/50">{label}</div>
    </div>
  )
}
