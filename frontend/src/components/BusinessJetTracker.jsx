import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap } from 'react-leaflet'
import { divIcon } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import clsx from 'clsx'
import { fetchBusinessJetTracker } from '../services/dashboard'

const REFRESH_MS = 30_000

function fmtAge(iso) {
  if (!iso) return 'never'
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (sec < 90) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 90) return `${min}m ago`
  return `${Math.round(min / 60)}h ago`
}

const LEVELS = [
  { n: 1, label: 'Quiet', tone: 'text-grn', border: 'border-grn/50', bg: 'bg-grn/12', bar: '#b5bd68' },
  { n: 2, label: 'Watch', tone: 'text-cyn', border: 'border-cyn/50', bg: 'bg-cyn/12', bar: '#8abeb7' },
  { n: 3, label: 'Elevated', tone: 'text-ylw', border: 'border-ylw/55', bg: 'bg-ylw/12', bar: '#f0c674' },
  { n: 4, label: 'High', tone: 'text-[#de935f]', border: 'border-[#de935f]/60', bg: 'bg-[#de935f]/12', bar: '#de935f' },
  { n: 5, label: 'Redline', tone: 'text-red', border: 'border-red/70', bg: 'bg-red/15', bar: '#cc6666' },
]

function levelFromScore(score, baselineSamples) {
  if (score == null || baselineSamples < 30) {
    return { ...LEVELS[0], calibrated: false, marker: 0.08, reason: 'quiet / not enough history yet' }
  }
  if (score >= 1) return { ...LEVELS[4], calibrated: true, marker: 1, reason: 'record breach' }
  if (score >= 0.75) return { ...LEVELS[3], calibrated: true, marker: score, reason: 'above p95/p99 band' }
  if (score >= 0.55) return { ...LEVELS[2], calibrated: true, marker: score, reason: 'above p90' }
  if (score >= 0.25) return { ...LEVELS[1], calibrated: true, marker: score, reason: 'above median' }
  return { ...LEVELS[0], calibrated: true, marker: Math.max(0, score), reason: 'at or below median' }
}

function confidence(samples = 0) {
  if (samples >= 100) return { label: 'high', tone: 'text-grn' }
  if (samples >= 30) return { label: 'medium', tone: 'text-ylw' }
  return { label: 'low', tone: 'text-fg3' }
}

function AutoFit({ points }) {
  const map = useMap()
  useEffect(() => {
    if (!points.length) return
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 3)
      return
    }
    map.fitBounds(points.map(p => [p.lat, p.lon]), { padding: [28, 28], maxZoom: 4 })
  }, [map, points])
  return null
}

function pointColor(p) {
  const alt = Number(p.altitudeFt) || 0
  if (alt >= 41000) return '#cc6666'
  if (alt >= 35000) return '#f0c674'
  if (alt >= 18000) return '#8abeb7'
  return '#81a2be'
}

function planeIcon(p) {
  const hdg = Number.isFinite(Number(p.heading)) ? Number(p.heading) : 0
  const color = pointColor(p)
  return divIcon({
    className: 'bj-plane-icon-wrap',
    html: `<div class="bj-plane-icon" style="--hdg:${hdg}deg;color:${color}">✈</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

function projectedTrail(p) {
  const lat = Number(p.lat)
  const lon = Number(p.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return []
  const hdg = Number.isFinite(Number(p.heading)) ? Number(p.heading) : 0
  const speed = Number.isFinite(Number(p.speedKt)) ? Number(p.speedKt) : 420
  const dist = Math.max(0.18, Math.min(0.9, speed / 650))
  const back = (hdg + 180) * Math.PI / 180
  const latScale = Math.cos(back) * dist
  const lonScale = Math.sin(back) * dist / Math.max(0.25, Math.cos(lat * Math.PI / 180))
  return [
    [lat + latScale, lon + lonScale],
    [lat + latScale * 0.55, lon + lonScale * 0.55],
    [lat, lon],
  ]
}

function trailForPlane(p, trailByIcao) {
  const trail = trailByIcao[p.icao] || []
  if (trail.length > 1) return trail.map(t => [t.lat, t.lon])
  return projectedTrail(p)
}

function MiniBars({ history }) {
  const bars = (history || []).slice(-48)
  const max = Math.max(1, ...bars.map(b => b.airborne_count || 0))
  return (
    <div className="h-12 flex items-end gap-px px-1 bg-bg/50 border border-border overflow-hidden">
      {bars.map((b, i) => {
        const h = Math.max(2, Math.round(((b.airborne_count || 0) / max) * 42))
        const score = b.unusual_score ?? 0
        const tone = score >= 1 ? 'bg-red' : score >= 0.7 ? 'bg-ylw' : 'bg-acc'
        return <div key={`${b.sampled_at}-${i}`} className={clsx('w-1.5 opacity-80', tone)} style={{ height: h }} title={`${b.sampled_at}: ${b.airborne_count}`} />
      })}
    </div>
  )
}

function TrendChart({ history, baselineCurve, current, mean, p99, height = 96 }) {
  const rows = (history || []).slice(-96)
  const values = rows.map(r => Number(r.airborne_count) || 0)
  const curve = (baselineCurve || []).slice(-96)
  const meanValues = curve.map(r => Number(r.mean)).filter(Number.isFinite)
  const p99Values = curve.map(r => Number(r.p99)).filter(Number.isFinite)
  const meanLine = Number(mean)
  const p99Line = Number(p99)
  const max = Math.max(
    1,
    current || 0,
    ...values,
    ...meanValues,
    ...p99Values,
    Number.isFinite(meanLine) ? meanLine : 0,
    Number.isFinite(p99Line) ? p99Line : 0
  )
  const w = 520
  const h = height
  const pad = { l: 8, r: 8, t: 8, b: 16 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const x = i => pad.l + (rows.length <= 1 ? innerW : (i / (rows.length - 1)) * innerW)
  const y = v => pad.t + innerH - ((Number(v) || 0) / max) * innerH
  const path = rows.length
    ? rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r.airborne_count).toFixed(1)}`).join(' ')
    : ''
  const curveX = i => pad.l + (curve.length <= 1 ? innerW : (i / (curve.length - 1)) * innerW)
  const meanPath = curve.length
    ? curve.map((r, i) => Number.isFinite(Number(r.mean)) ? `${i === 0 ? 'M' : 'L'}${curveX(i).toFixed(1)},${y(r.mean).toFixed(1)}` : '').filter(Boolean).join(' ')
    : ''
  const p99Path = curve.length
    ? curve.map((r, i) => Number.isFinite(Number(r.p99)) ? `${i === 0 ? 'M' : 'L'}${curveX(i).toFixed(1)},${y(r.p99).toFixed(1)}` : '').filter(Boolean).join(' ')
    : ''
  const area = rows.length
    ? `${path} L${x(rows.length - 1).toFixed(1)},${pad.t + innerH} L${pad.l},${pad.t + innerH} Z`
    : ''
  const currentX = rows.length ? x(rows.length - 1) : pad.l
  const currentY = y(current || values[values.length - 1] || 0)

  const historicalSamples = Math.max(0, ...curve.map(r => Number(r.samples) || 0), Number.isFinite(Number(baselineCurve?.[baselineCurve.length - 1]?.samples)) ? Number(baselineCurve[baselineCurve.length - 1].samples) : 0)

  return (
    <div className="bg-bg/60 border border-border p-1.5 min-w-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[8px] text-fg3 uppercase">history at this hour</span>
        <span className="text-[8px] text-fg3 tabular-nums">
          {historicalSamples >= 10 ? `${historicalSamples} samples` : 'warming up'}
        </span>
      </div>
      <div className="flex items-center gap-3 text-[8px] text-fg3 mb-1">
        <span><span className="inline-block w-2 h-2 bg-acc/70 mr-1" />airborne now</span>
        <span><span className="inline-block w-2 h-0.5 bg-cyn mr-1 align-middle" />average</span>
        <span><span className="inline-block w-2 h-0.5 bg-red mr-1 align-middle" />p99</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-20 block" preserveAspectRatio="none">
        <line x1={pad.l} y1={pad.t + innerH} x2={w - pad.r} y2={pad.t + innerH} stroke="#3a3a3a" strokeWidth="1" />
        {p99Path && (
          <path d={p99Path} fill="none" stroke="#cc6666" strokeWidth="1.6" strokeDasharray="5 4" />
        )}
        {meanPath && (
          <path d={meanPath} fill="none" stroke="#8abeb7" strokeWidth="1.2" strokeDasharray="3 4" />
        )}
        {area && <path d={area} fill="#81a2be" opacity="0.10" />}
        {path && <path d={path} fill="none" stroke="#81a2be" strokeWidth="2.2" />}
        {rows.length > 0 && <circle cx={currentX} cy={currentY} r="3.5" fill="#f0c674" stroke="#0d0d0d" strokeWidth="1" />}
      </svg>
      <div className="grid grid-cols-3 gap-2 text-[8px] mt-1 leading-tight">
        <span className="text-fg3">now <span className="text-fg tabular-nums">{current ?? 0}</span></span>
        <span className="text-fg3">avg <span className="text-cyn tabular-nums">{Number.isFinite(meanLine) ? meanLine : '...'}</span></span>
        <span className="text-fg3">p99 <span className="text-red tabular-nums">{Number.isFinite(p99Line) ? p99Line : '...'}</span></span>
      </div>
      {historicalSamples < 10 && (
        <div className="mt-0.5 text-[8px] text-ylw/80">
          Needs same-version half-hour samples before it can score the hour honestly.
        </div>
      )}
    </div>
  )
}

export default function BusinessJetTracker({ backendOk }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [trailByIcao, setTrailByIcao] = useState({})

  useEffect(() => {
    if (!backendOk) return
    let cancelled = false
    const refresh = async () => {
      try {
        const d = await fetchBusinessJetTracker()
        if (!cancelled) { setData(d); setError(null) }
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || err.message)
      }
    }
    refresh()
    const id = setInterval(refresh, REFRESH_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [backendOk])

  const snapshot = data?.snapshot
  const baseline = data?.baseline || {}
  const positions = useMemo(() => (data?.positions || []).filter(p => p.lat != null && p.lon != null), [data])
  const level = levelFromScore(snapshot?.unusualScore, baseline.samples || 0)
  const conf = confidence(baseline.samples || 0)
  const airborne = snapshot?.airborneCount ?? 0
  const cohortSize = snapshot?.cohortSize || data?.cohortSize || 0
  const p99 = baseline.p99 ?? '...'
  const max = baseline.max ?? '...'
  const mean = baseline.mean ?? '...'
  const audit = data?.audit || {}
  const calibration = data?.calibrationStatus || {}
  const topModels = audit.topModels || []
  const lookbackDays = Number(baseline.days) || 365
  const windowMinutes = Number(baseline.windowMinutes) || 45
  const comparisonWindow = `${windowMinutes * 2}-minute`
  const comparisonPhrase = `same weekday, +/-${windowMinutes} min`
  const sampleWindowMinutes = 30
  const signalQuestion = `How many private jets were airborne in the latest ${sampleWindowMinutes}-minute sample?`

  useEffect(() => {
    if (!positions.length || !snapshot?.sampledAt) return
    setTrailByIcao(prev => {
      const active = new Set(positions.map(p => p.icao))
      const next = {}
      for (const p of positions) {
        const prior = prev[p.icao] || []
        const last = prior[prior.length - 1]
        const point = { lat: Number(p.lat), lon: Number(p.lon), sampledAt: snapshot.sampledAt }
        const changed = !last
          || last.sampledAt !== point.sampledAt
          || Math.abs(last.lat - point.lat) > 0.01
          || Math.abs(last.lon - point.lon) > 0.01
        next[p.icao] = changed ? [...prior, point].slice(-8) : prior
      }
      for (const [icao, trail] of Object.entries(prev)) {
        if (!active.has(icao) && trail.length > 1) next[icao] = trail.slice(-4)
      }
      return next
    })
  }, [positions, snapshot?.sampledAt])

  return (
    <section className={clsx('bg-bg1 border-y', level.border)}>
      <div
        className="px-2.5 py-1 bg-bg2 border-b border-border flex flex-wrap lg:flex-nowrap items-center gap-x-2 gap-y-1 cursor-pointer hover:bg-bg2/80"
        role="button"
        tabIndex={0}
        onClick={() => setDetailsOpen(v => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setDetailsOpen(v => !v)
          }
        }}
        title={detailsOpen ? 'collapse doomsday signal details' : 'expand doomsday signal details'}
      >
        <div className="flex items-baseline gap-2 min-w-0 mr-1">
          <span className="ft-chip ft-chip--red">doomsday signal</span>
          <span className="hidden md:inline text-fg2 text-[10px] truncate">{signalQuestion}</span>
          {error && <span className="text-red text-[9px] truncate max-w-[240px]">{error}</span>}
          {data?.lastError && <span className="text-ylw text-[9px] truncate max-w-[260px]">{data.lastError}</span>}
        </div>

        <div className={clsx('flex items-baseline gap-1.5 px-1.5 py-0.5 border shrink-0', level.border, level.bg)}>
          <span className={clsx('text-[9px] tracking-wide', level.tone)}>level {level.n}</span>
          <span className={clsx('text-[12px] leading-none font-semibold', level.tone)}>{level.label}</span>
        </div>

        <div className="flex items-baseline gap-1 text-[10px] shrink-0">
          <span className="text-fg tabular-nums text-[15px] leading-none">{airborne.toLocaleString()}</span>
          <span className="text-fg3">airborne</span>
          <span className="text-fg3">/</span>
          <span className="text-fg3 tabular-nums">{cohortSize ? cohortSize.toLocaleString() : '...'}</span>
          <span className="text-fg3 hidden sm:inline">watched</span>
        </div>

        <div className="flex-1" />
        <span className="hidden md:inline text-[9px] text-fg3 tabular-nums">
          record <span className="text-red">{max}</span>
        </span>
        <span className="hidden lg:inline text-[9px] text-fg3">
          {calibration.label || 'calibration'} <span className={conf.tone}>{conf.label}</span>
        </span>
        <span className="md:hidden basis-full text-[9px] text-fg2 leading-snug">
          {signalQuestion}
        </span>
        <span className="text-[9px] text-fg3 tabular-nums">
          {snapshot ? `sample ${fmtAge(snapshot.sampledAt)}` : 'no sample yet'}
        </span>
        <span className="text-fg3 hover:text-fg text-[10px]">
          {detailsOpen ? '▾ less' : '▸ details'}
        </span>
      </div>

      {detailsOpen && (
        <div className="early-warning-details grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] lg:h-[300px] gap-px bg-border">
          <div className="bg-bg1 p-2 flex flex-col gap-2 min-h-0 overflow-y-auto">
            <div className="border border-border bg-bg/50 px-2 py-1.5">
              <div className="ft-chip ft-chip--accent">doomsday signal</div>
              <div className="text-[10px] text-fg2 leading-snug mt-1">
                This tracker asks one question: how many private jets were airborne in the latest 30-minute sample, and is that unusual for this time?
              </div>
              <div className="text-[8px] text-fg3 leading-snug mt-1">
                If private movement starts breaking its usual rhythm before the public picture changes, this is where it should show up.
              </div>
            </div>

            <TrendChart
              history={data?.history || []}
              baselineCurve={data?.baselineCurve || []}
              current={airborne}
              mean={baseline.mean}
              p99={baseline.p99}
              height={104}
            />

            <div className="border border-border bg-bg/50 p-2">
              <div className="flex items-end gap-2 mb-1.5">
                <div>
                  <div className="text-[8px] text-fg3 uppercase mb-0.5">level basis</div>
                  <span className={clsx('text-[34px] leading-none tabular-nums', level.tone)}>{level.n}</span>
                </div>
                <div className="mb-1 min-w-0">
                  <div className={clsx('text-[10px] uppercase leading-none', level.tone)}>{level.label}</div>
                  <div className="text-[8px] text-fg3 mt-0.5 leading-snug">
                    {level.n === 1
                      ? 'Level 1 means private-jet movement is quiet: nothing in this sample is pushing above its usual band.'
                      : level.reason}
                  </div>
                </div>
              </div>
              <div className="flex justify-between text-[9px] mb-1">
                <span className="text-grn">1 quiet</span>
                <span className={level.tone}>{level.reason}</span>
                <span className="text-red">5 redline</span>
              </div>
              <div className="relative h-3 bg-bg border border-border">
                <div className="absolute inset-y-0 left-0 bg-grn/25" style={{ width: '35%' }} />
                <div className="absolute inset-y-0 left-[35%] bg-acc/25" style={{ width: '35%' }} />
                <div className="absolute inset-y-0 left-[70%] bg-ylw/25" style={{ width: '20%' }} />
                <div className="absolute inset-y-0 right-0 bg-red/30" style={{ width: '10%' }} />
                <div
                  className="absolute -top-1 h-5 w-0.5 bg-fg shadow-[0_0_8px_rgba(255,255,255,0.4)]"
                  style={{ left: `${Math.max(0, Math.min(1, level.marker)) * 100}%` }}
                />
              </div>
              <div className="grid grid-cols-5 gap-px mt-1 text-[7px] text-center uppercase">
                {LEVELS.map(l => (
                  <span key={l.n} className={clsx('border border-border bg-bg/50 py-0.5 normal-case', l.n === level.n ? `${l.tone} border-current` : 'text-fg3')}>
                    {l.n} {l.label}
                  </span>
                ))}
              </div>
              <div className="mt-1 text-[8px] text-fg3 leading-snug">
                <span className="text-red">Level 5</span> is the redline: the latest 30-minute sample has more private jets airborne than this tracker has seen in the same-time comparison window: <span className="text-red tabular-nums">{max}</span>.
                {baseline.samples ? ` ${baseline.samples} comparable samples.` : ' History depth is not established yet.'}
              </div>
              <div className="mt-1 border border-red/30 bg-red/5 px-2 py-1 text-[8px] text-fg2 leading-snug">
                Here, "same time" means the same UTC weekday inside a {comparisonWindow} band ({comparisonPhrase}) across the trailing {lookbackDays} days. If today breaks that record, the app treats it as the highest alarm state.
              </div>
              {!level.calibrated && (
                <div className="mt-1 border border-ylw/25 bg-ylw/5 px-2 py-1 text-[8px] text-ylw/90 leading-snug">
                  The tracker still needs more same-time samples before the score is mature. Until then, it stays at Level 1 unless the live count clearly breaks out.
                </div>
              )}
              <div className="mt-1 border border-border bg-bg/50 px-2 py-1 text-[8px] text-fg3 leading-snug">
                Built from FAA registrations and live aircraft positions. Obvious managed, fractional, airline, cargo, government, medical, and blank-owner records are filtered out.
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1.5 text-[8px]">
              <div className="border border-border bg-bg/50 p-1.5">
                <div className="text-fg3 uppercase mb-1">watchlist</div>
                <div className="flex justify-between gap-2">
                  <span className="text-fg3">aircraft</span>
                  <span className="text-fg tabular-nums">{cohortSize ? cohortSize.toLocaleString() : '...'}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-fg3">invalid hex</span>
                  <span className="text-fg tabular-nums">{audit.integrity?.invalidHex ?? 0}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-fg3">blank owners kept</span>
                  <span className="text-fg tabular-nums">{audit.integrity?.unknownOwnerIncluded ?? 0}</span>
                </div>
              </div>
              <div className="border border-border bg-bg/50 p-1.5">
                <div className="text-fg3 uppercase mb-1">filtered out</div>
                <div className="flex justify-between gap-2">
                  <span className="text-fg3">blank owners</span>
                  <span className="text-fg tabular-nums">{audit.exclusions?.unknownOwnerExcluded ?? '...'}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-fg3">borderline models</span>
                  <span className="text-fg tabular-nums">{audit.exclusions?.borderlineModelExcluded ?? '...'}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-fg3">managed now</span>
                  <span className="text-fg tabular-nums">{audit.runtime?.managedOperatorExcluded ?? 0}</span>
                </div>
              </div>
            </div>
            <div className="border border-border bg-bg/50 p-1.5 text-[8px]">
              <div className="flex justify-between gap-2 mb-1">
                <span className="text-fg3 uppercase">aircraft types</span>
                <span className="text-fg3 tabular-nums">{audit.ruleVersion || 'strict-v4'}</span>
              </div>
              <div className="grid gap-1">
                {topModels.slice(0, 4).map(row => (
                  <div key={`${row.manufacturer}-${row.model}`} className="flex justify-between gap-2">
                    <span className="text-fg3 truncate">{row.model}</span>
                    <span className="text-fg tabular-nums">{row.count}</span>
                  </div>
                ))}
                {topModels.length === 0 && <span className="text-fg3">waiting for audit data</span>}
              </div>
            </div>
          </div>

          <div className="bg-bg1 min-h-[260px] lg:min-h-0 flex flex-col">
            <div className="px-2 py-1 text-[9px] text-fg3 bg-bg2/60 border-b border-border flex justify-between shrink-0">
              <span>latest private-jet positions</span>
              <span className="tabular-nums">{positions.length}</span>
            </div>
            <div className="relative flex-1 min-h-[230px]">
              <MapContainer
                center={[39, -96]}
                zoom={2}
                scrollWheelZoom={false}
                zoomControl={true}
                attributionControl={false}
                style={{ height: '100%', width: '100%', minHeight: 230, background: '#0d0d0d' }}
              >
                <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" opacity={0.58} />
                <AutoFit points={positions} />
                {positions.map(p => {
                  const trail = trailForPlane(p, trailByIcao)
                  return trail.length > 1 ? (
                    <Polyline
                      key={`${p.icao}-trail`}
                      positions={trail}
                      pathOptions={{ color: pointColor(p), opacity: 0.42, weight: 2.2, dashArray: '1 7' }}
                    />
                  ) : null
                })}
                {positions.map(p => (
                  <Marker
                    key={p.icao}
                    position={[p.lat, p.lon]}
                    icon={planeIcon(p)}
                  >
                    <Tooltip direction="top">
                      <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                        <b>{p.callsign || p.registration || p.icao}</b> {p.model || ''}<br />
                        {p.registration || p.icao}<br />
                        {p.owner || 'FAA watchlist'}<br />
                        {p.altitudeFt != null ? `${Math.round(p.altitudeFt).toLocaleString()}ft ` : ''}
                        {p.speedKt != null ? `${Math.round(p.speedKt)}kt ` : ''}
                        {p.heading != null ? `HDG ${Math.round(p.heading)}` : ''}
                      </span>
                    </Tooltip>
                  </Marker>
                ))}
              </MapContainer>
              {positions.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="bg-bg1/85 border border-border px-3 py-2 text-[10px] text-fg3">
                    waiting for matched private-jet positions
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
