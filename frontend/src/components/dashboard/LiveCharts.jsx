import { useState, useEffect, useRef, useMemo } from 'react'
import {
  AreaChart, Area, BarChart, Bar, ScatterChart, Scatter,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import { detectPhase, PHASE } from '../../utils/anomaly'

const C = {
  acc: '#22d3ee', grn: '#4ade80', ylw: '#facc15', red: '#f87171',
  mag: '#c084fc', cyn: '#06b6d4', fg3: '#6b7280',
}

function Tip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-bg2 border border-border rounded px-2 py-1 text-[8px] shadow-lg">
      {label && <div className="text-fg3 mb-0.5">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || p.stroke }}>
          {p.name}: <span className="font-bold">{typeof p.value === 'number' ? p.value.toLocaleString() : p.value}</span>
        </div>
      ))}
    </div>
  )
}

// Stagger rendering so charts don't all mount at once
function useStaggered(max) {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    if (stage >= max) return
    const id = requestAnimationFrame(() => setStage(s => s + 1))
    return () => cancelAnimationFrame(id)
  }, [stage, max])
  return stage
}

export default function LiveCharts({ flights = [], trackHistory = {}, enrichCache = {} }) {
  const stage = useStaggered(2)

  const dist = useMemo(() => {
    if (!flights.length) return null
    const airborne = flights.filter(f => !f.grounded)

    // Altitude histogram
    const altBins = [{ fl: 'GND', min: -Infinity, max: 500, count: 0 }]
    for (let fl = 0; fl <= 500; fl += 20) altBins.push({ fl: `FL${fl}`, min: fl * 100, max: (fl + 20) * 100, count: 0 })
    for (const f of flights) {
      if (f.grounded) { altBins[0].count++; continue }
      if (f.alt == null) continue
      const ft = f.alt * 3.281
      for (const b of altBins) { if (ft >= b.min && ft < b.max) { b.count++; break } }
    }
    const altData = altBins.filter(b => b.count > 0)

    // Speed histogram
    const spdBins = []
    for (let s = 0; s <= 600; s += 25) spdBins.push({ spd: `${s}`, min: s, max: s + 25, count: 0 })
    for (const f of flights) {
      if (f.vel == null || f.grounded) continue
      const kt = f.vel * 1.944
      for (const b of spdBins) { if (kt >= b.min && kt < b.max) { b.count++; break } }
    }
    const spdData = spdBins.filter(b => b.count > 0)

    // Vertical rate distribution
    const vrBins = []
    for (let v = -4000; v <= 4000; v += 500) vrBins.push({ vr: `${v > 0 ? '+' : ''}${v}`, min: v, max: v + 500, count: 0 })
    for (const f of flights) {
      if (f.vertRate == null || f.grounded) continue
      const fpm = f.vertRate * 196.85
      for (const b of vrBins) { if (fpm >= b.min && fpm < b.max) { b.count++; break } }
    }
    const vrData = vrBins.filter(b => b.count > 0)

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
    const phaseData = Object.entries(phases).map(([name, count]) => ({ name, count }))

    // KPIs
    const withTfms = flights.filter(f => f.tfms).length
    const alts = airborne.filter(f => f.alt != null).map(f => f.alt * 3.281)
    const avgAlt = alts.length > 0 ? Math.round(alts.reduce((a, b) => a + b, 0) / alts.length) : 0

    return { altData, spdData, vrData, topRoutes, phaseData, total: flights.length, airborne: airborne.length, withTfms, avgAlt }
  }, [flights, trackHistory])

  if (!dist) return <div className="py-4 text-center text-fg3 text-[10px]">Waiting for flight data...</div>

  const PHASE_COLORS = { Climb: C.grn, Cruise: C.cyn, Descent: C.ylw, Approach: C.mag, Ground: C.fg3 }

  return (
    <div className="space-y-px bg-border">
      {/* KPIs */}
      <div className="grid grid-cols-4 gap-px bg-border">
        <KPI label="Tracked" value={dist.total.toLocaleString()} color="text-acc" />
        <KPI label="Airborne" value={dist.airborne.toLocaleString()} color="text-grn" />
        <KPI label="With Flight Plan" value={dist.withTfms.toLocaleString()} color="text-cyn" />
        <KPI label="Avg Altitude" value={`FL${Math.round(dist.avgAlt / 100)}`} color="text-ylw" />
      </div>

      {/* Row 1: Altitude distribution + speed distribution + phase breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">
        <div className="bg-bg1 p-2">
          <div className="text-[9px] text-fg3/50 uppercase mb-1">Altitude Distribution ({dist.airborne} airborne)</div>
          <ResponsiveContainer width="100%" height={130}>
            <AreaChart data={dist.altData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="fl" tick={{ fontSize: 7, fill: '#6b7280' }} interval={Math.max(1, Math.floor(dist.altData.length / 8))} />
              <YAxis tick={{ fontSize: 7, fill: '#6b7280' }} width={30} />
              <Tooltip content={<Tip />} />
              <Area type="monotone" dataKey="count" stroke={C.cyn} fill={C.cyn} fillOpacity={0.15} strokeWidth={1.5} name="Aircraft" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-bg1 p-2">
          <div className="text-[9px] text-fg3/50 uppercase mb-1">Speed Distribution</div>
          <ResponsiveContainer width="100%" height={130}>
            <AreaChart data={dist.spdData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="spd" tick={{ fontSize: 7, fill: '#6b7280' }} interval={3} unit="kt" />
              <YAxis tick={{ fontSize: 7, fill: '#6b7280' }} width={25} />
              <Tooltip content={<Tip />} />
              <Area type="monotone" dataKey="count" stroke={C.acc} fill={C.acc} fillOpacity={0.15} strokeWidth={1.5} name="Aircraft" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-bg1 p-2">
          <div className="text-[9px] text-fg3/50 uppercase mb-1">Flight Phase</div>
          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={dist.phaseData} barSize={20}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#9ca3af' }} />
              <YAxis tick={{ fontSize: 7, fill: '#6b7280' }} width={30} />
              <Tooltip content={<Tip />} />
              <Bar dataKey="count" name="Aircraft" radius={[3, 3, 0, 0]}>
                {dist.phaseData.map((d, i) => (
                  <rect key={i} fill={PHASE_COLORS[d.name] || C.fg3} fillOpacity={0.7} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Row 2: Vertical rate + busiest routes (staggered) */}
      {stage < 2 ? <div className="h-34 bg-bg1" /> :
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border">
        <div className="bg-bg1 p-2">
          <div className="text-[9px] text-fg3/50 uppercase mb-1">Vertical Rate Distribution</div>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={dist.vrData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="vr" tick={{ fontSize: 7, fill: '#6b7280' }} interval={2} />
              <YAxis tick={{ fontSize: 7, fill: '#6b7280' }} width={25} />
              <Tooltip content={<Tip />} />
              <ReferenceLine x="0" stroke={C.fg3} strokeDasharray="3 3" />
              <Area type="monotone" dataKey="count" stroke={C.grn} fill={C.grn} fillOpacity={0.15} strokeWidth={1.5} name="Aircraft" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-bg1 p-2">
          <div className="text-[9px] text-fg3/50 uppercase mb-1">Busiest Routes ({dist.withTfms} with TFMS)</div>
          {dist.topRoutes.length > 0 ? (
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={dist.topRoutes} layout="vertical" barSize={8}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis type="number" tick={{ fontSize: 7, fill: '#6b7280' }} />
                <YAxis dataKey="route" type="category" tick={{ fontSize: 7, fill: '#9ca3af' }} width={60} />
                <Tooltip content={<Tip />} />
                <Bar dataKey="count" name="Flights" fill={C.mag} fillOpacity={0.7} radius={[0, 2, 2, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-30 flex items-center justify-center text-fg3 text-[9px]">No TFMS data</div>}
        </div>
      </div>}
    </div>
  )
}

function KPI({ label, value, color }) {
  return (
    <div className="bg-bg1 px-2 py-1 text-center">
      <div className={`text-sm font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-[7px] text-fg3/50">{label}</div>
    </div>
  )
}
