import { useCallback, useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap } from 'react-leaflet'
import { divIcon } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import clsx from 'clsx'
import { fetchBusinessJetTracker } from '../services/dashboard'
import Loading from './Loading'

const REFRESH_MS = 30_000

function fmtAge(iso) {
  if (!iso) return 'never'
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (sec < 90) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 90) return `${min}m ago`
  return `${Math.round(min / 60)}h ago`
}

const SIGNAL_STATES = [
  { label: 'Within usual range', tone: 'text-fg2' },
  { label: 'Elevated', tone: 'text-ylw' },
  { label: 'Near upper range', tone: 'text-ylw' },
  { label: 'Outside observed range', tone: 'text-red' },
]

const CALIBRATING = {
  label: 'Building baseline',
  tone: 'text-fg2',
  calibrated: false,
}

function levelFromScore(score, baselineSamples) {
  if (score == null || baselineSamples < 30) {
    return { ...CALIBRATING, reason: `${baselineSamples || 0} of 30 comparable checkpoints` }
  }
  if (score >= 1) return { ...SIGNAL_STATES[3], calibrated: true, reason: 'above the observed range' }
  if (score >= 0.75) return { ...SIGNAL_STATES[2], calibrated: true, reason: 'near the upper range' }
  if (score >= 0.55) return { ...SIGNAL_STATES[1], calibrated: true, reason: 'above the usual range' }
  return { ...SIGNAL_STATES[0], calibrated: true, reason: 'within the usual range' }
}

function AutoFit({ points }) {
  const map = useMap()
  useEffect(() => {
    const fit = () => {
      map.invalidateSize({ pan: false })
      if (!points.length) return
      if (points.length === 1) {
        map.setView([points[0].lat, points[0].lon], 3)
        return
      }
      map.fitBounds(points.map(p => [p.lat, p.lon]), { padding: [28, 28], maxZoom: 4 })
    }
    fit()
    const retry = window.setTimeout(fit, 150)
    return () => window.clearTimeout(retry)
  }, [map, points])
  return null
}

function FocusAircraft({ point }) {
  const map = useMap()
  useEffect(() => {
    if (!point) return
    map.setView([point.lat, point.lon], Math.max(map.getZoom(), 6), { animate: true })
  }, [map, point])
  return null
}

function planeIcon(p, selected = false) {
  const hdg = Number.isFinite(Number(p.heading)) ? Number(p.heading) : 0
  return divIcon({
    className: 'bj-plane-icon-wrap',
    html: `<div class="bj-plane-icon${selected ? ' is-selected' : ''}" style="--hdg:${hdg}deg">✈</div>`,
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

function fmtTrendTick(iso, spanMs) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (spanMs >= 24 * 3600_000) return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
  return `${hh}:${mm}`
}

function TrendChart({ history, baselineCurve, current, mean, rangeHours = 12 }) {
  const sampleCount = Math.max(6, rangeHours * 2)
  const rows = (history || []).slice(-sampleCount)
  const values = rows.map(r => Number(r.airborne_count) || 0)
  const curve = (baselineCurve || []).slice(-sampleCount)
  const meanValues = curve.map(r => Number(r.mean)).filter(Number.isFinite)
  const meanLine = Number(mean)
  const max = Math.max(
    1,
    current || 0,
    ...values,
    ...meanValues,
    Number.isFinite(meanLine) ? meanLine : 0
  )
  const w = 520
  const h = 142
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
  const currentX = rows.length ? x(rows.length - 1) : pad.l
  const currentY = y(current || values[values.length - 1] || 0)

  const tickRows = rows.length ? rows : curve
  const firstAt = tickRows[0]?.sampled_at ? new Date(tickRows[0].sampled_at).getTime() : null
  const lastAt = tickRows[tickRows.length - 1]?.sampled_at ? new Date(tickRows[tickRows.length - 1].sampled_at).getTime() : null
  const spanMs = Number.isFinite(firstAt) && Number.isFinite(lastAt) ? Math.max(0, lastAt - firstAt) : 0
  const tickIndexes = tickRows.length <= 1
    ? [0]
    : Array.from(new Set([0, Math.floor((tickRows.length - 1) / 2), tickRows.length - 1]))
  const ticks = tickIndexes
    .map(i => ({ i, label: fmtTrendTick(tickRows[i]?.sampled_at, spanMs) }))
    .filter(t => t.label)

  return (
    <section className="private-trend" aria-label={`${rangeHours}-hour private aviation activity`}>
      <div className="private-trend__header">
        <span>Activity</span>
        <span>{rangeHours} hours</span>
      </div>
      <div className="private-trend__legend" aria-hidden="true">
        <span><i className="is-current" />current</span>
        <span><i className="is-usual" />usual</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="private-trend__chart" preserveAspectRatio="none">
        <line x1={pad.l} y1={pad.t + innerH} x2={w - pad.r} y2={pad.t + innerH} stroke="#30342f" strokeWidth="1" />
        {meanPath && (
          <path d={meanPath} fill="none" stroke="#7d8179" strokeWidth="1.2" strokeDasharray="3 4" />
        )}
        {path && <path d={path} fill="none" stroke="#f2f0e6" strokeWidth="2" />}
        {rows.length > 0 && <circle cx={currentX} cy={currentY} r="3.5" fill="#f2f0e6" stroke="#171918" strokeWidth="1" />}
      </svg>
      {ticks.length > 0 && (
        <div className="private-trend__ticks" style={{ gridTemplateColumns: `repeat(${ticks.length}, minmax(0, 1fr))` }}>
          {ticks.map((t, idx) => (
            <span
              key={`${t.i}-${t.label}`}
              className={idx === 0 ? 'text-left' : idx === ticks.length - 1 ? 'text-right' : 'text-center'}
            >
              {t.label}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function fmtClock(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
}

function fmtNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number).toLocaleString() : '—'
}

const CHANGE_LABELS = {
  newly_observed: 'Newly observed',
  continued: 'Continued',
  not_observed: 'Not observed',
}

function ChangeQueueRow({ record, selected, onSelect }) {
  const title = record.callsign || record.registration || record.icao
  const model = record.model || record.manufacturer || 'Aircraft type unavailable'
  return (
    <button
      type="button"
      className={clsx('private-change-row', selected && 'is-selected')}
      onClick={() => onSelect(record.icao)}
      aria-pressed={selected}
    >
      <span className="private-change-row__state">{CHANGE_LABELS[record.change] || 'Observed'}</span>
      <span className="private-change-row__aircraft">
        <strong>{title}</strong>
        <small>{model}</small>
      </span>
      <span className="private-change-row__registrant" title={record.owner || 'FAA registrant unavailable'}>
        {record.owner || 'FAA registrant unavailable'}
      </span>
      <span className="private-change-row__metric">{record.altitudeFt != null ? `${fmtNumber(record.altitudeFt)} ft` : '—'}</span>
      <span className="private-change-row__metric">{record.speedKt != null ? `${fmtNumber(record.speedKt)} kt` : '—'}</span>
    </button>
  )
}

function PrivateMap({ positions, selectedPosition, trailByIcao, onSelect }) {
  return (
    <section className="private-map-detail" aria-label="Position context">
      <div className="private-map-detail__header">
        <span>Position context</span>
        <span>{positions.length} observed</span>
      </div>
      <div className="private-map-detail__canvas">
        <MapContainer
          center={[39, -96]}
          zoom={2}
          scrollWheelZoom={false}
          zoomControl
          attributionControl={false}
          style={{ height: '100%', width: '100%', minHeight: 260, background: '#0d0d0d' }}
        >
          <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" opacity={0.58} />
          <AutoFit points={positions} />
          <FocusAircraft point={selectedPosition} />
          {positions.map(p => {
            const trail = trailForPlane(p, trailByIcao)
            return trail.length > 1 ? (
              <Polyline
                key={`${p.icao}-trail`}
                positions={trail}
                pathOptions={{ color: '#7d8179', opacity: 0.35, weight: 1.5, dashArray: '1 7' }}
              />
            ) : null
          })}
          {positions.map(p => (
            <Marker
              key={p.icao}
              position={[p.lat, p.lon]}
              icon={planeIcon(p, p.icao === selectedPosition?.icao)}
              eventHandlers={{ click: () => onSelect(p.icao) }}
            >
              <Tooltip direction="top">
                <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                  <b>{p.callsign || p.registration || p.icao}</b> {p.model || ''}<br />
                  {p.registration || p.icao}<br />
                  {p.owner || 'FAA registrant unavailable'}<br />
                  {p.altitudeFt != null ? `${fmtNumber(p.altitudeFt)}ft ` : ''}
                  {p.speedKt != null ? `${fmtNumber(p.speedKt)}kt ` : ''}
                  {p.heading != null ? `HDG ${Math.round(p.heading)}` : ''}
                </span>
              </Tooltip>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </section>
  )
}

function MethodCoverage({ data, snapshot, comparison }) {
  return (
    <details className="private-method">
      <summary>Method &amp; coverage</summary>
      <p>Public FAA registry cohort. Aircraft are sampled every 30 minutes and compared with prior, time-matched observations. A registrant is not necessarily an operator or passenger. An absent broadcast is not an inactivity finding.</p>
      <dl>
        <div><dt>Source</dt><dd>{snapshot?.source || data?.source || '—'}</dd></div>
        <div><dt>Cohort version</dt><dd>{data?.cohortVersion || '—'}</dd></div>
        <div><dt>Prior sample</dt><dd>{comparison?.previousSampledAt ? `${fmtAge(comparison.previousSampledAt)} · ${fmtClock(comparison.previousSampledAt)}` : 'Unavailable'}</dd></div>
      </dl>
    </details>
  )
}

export default function BusinessJetTracker({ backendOk }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [trailByIcao, setTrailByIcao] = useState({})
  const [rangeHours, setRangeHours] = useState(12)
  const [selectedIcao, setSelectedIcao] = useState(null)
  const [queueMode, setQueueMode] = useState('changes')
  const [showMap, setShowMap] = useState(false)
  const selectRecord = useCallback((icao) => {
    setSelectedIcao(icao)
    setShowMap(true)
  }, [])

  useEffect(() => {
    if (!backendOk) { setError('Backend unavailable'); return }
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
  const comparison = data?.comparison || null
  const comparisonRecords = comparison?.records || positions.map(position => ({ ...position, change: 'observed' }))
  const hasComparison = Boolean(comparison?.previousSampledAt)
  const changedRecords = useMemo(
    () => comparisonRecords.filter(record => record.change !== 'continued'),
    [comparisonRecords]
  )
  const queueRecords = useMemo(() => {
    if (queueMode === 'changes' && hasComparison) return changedRecords
    return positions.map(position => comparisonRecords.find(record => record.icao === position.icao) || { ...position, change: 'observed' })
  }, [changedRecords, comparisonRecords, hasComparison, positions, queueMode])
  const selectedRecord = useMemo(
    () => comparisonRecords.find(record => record.icao === selectedIcao) || null,
    [comparisonRecords, selectedIcao]
  )
  const selectedPosition = useMemo(() => positions.find(p => p.icao === selectedIcao) || null, [positions, selectedIcao])
  const hasVerifiedCheckpoint = Boolean(data && snapshot)
  const level = hasVerifiedCheckpoint
    ? levelFromScore(snapshot?.unusualScore, baseline.samples || 0)
    : { ...CALIBRATING, label: error ? 'Unavailable' : 'Loading', reason: error ? 'no verified checkpoint available' : 'waiting for a verified checkpoint' }
  const airborne = snapshot?.airborneCount ?? null
  const delta = airborne != null && Number.isFinite(Number(baseline.mean)) ? airborne - Number(baseline.mean) : null
  const comparableMean = Number.isFinite(Number(baseline.mean)) ? Number(baseline.mean).toFixed(1) : '—'
  const matchCoverage = snapshot?.matchedCount != null && data?.cohortSize != null
    ? `${snapshot.matchedCount.toLocaleString()} / ${data.cohortSize.toLocaleString()}`
    : '—'
  useEffect(() => {
    setQueueMode(hasComparison ? 'changes' : 'all')
  }, [hasComparison])
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
    <section className="private-jet-tracker">
      <header className="private-jet-titlebar">
        <div>
          <span className="private-jet-titlebar__index">U.S. FAA registry · public-record cohort</span>
          <h1>Corporate long-range activity</h1>
        </div>
        <div className="private-range" role="group" aria-label="Activity chart window">
          {[3, 12, 24].map(hours => (
            <button key={hours} className={rangeHours === hours ? 'is-active' : ''} onClick={() => setRangeHours(hours)} aria-pressed={rangeHours === hours}>
              {hours}h
            </button>
          ))}
        </div>
      </header>
      {error && (
        <div className={clsx('private-availability', data ? 'is-stale' : 'is-unavailable')} role="status">
          <strong>{data ? 'Data delayed' : 'Data unavailable'}</strong>
          <span>{data ? `Last verified ${fmtAge(snapshot?.sampledAt)}.` : 'Awaiting a verified checkpoint.'}</span>
        </div>
      )}
      <div className="private-jet-overview">
        <div><span>Observed</span><strong>{airborne == null ? '—' : airborne.toLocaleString()}</strong><small>aircraft</small></div>
        <div><span>Comparable mean</span><strong>{comparableMean}</strong><small>aircraft</small></div>
        <div><span>Delta</span><strong>{delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`}</strong><small>aircraft</small></div>
        <div><span>Matched / cohort</span><strong>{matchCoverage}</strong><small>this sample</small></div>
        <div className="private-jet-status"><span className={level.tone}>{level.label}</span><small>{level.calibrated ? level.reason : `${baseline.samples || 0} / 30 checkpoints`} · {snapshot ? `observed ${fmtAge(snapshot.sampledAt)}` : 'waiting'}</small></div>
      </div>

      <div className={clsx('private-jet-layout', selectedRecord && 'has-selection')}>
        <aside className="private-jet-analysis">
          <div className="private-change-queue">
            <div className="private-change-queue__header">
              <div>
                <span>Change queue</span>
                <small>{hasComparison ? `Since ${fmtClock(comparison.previousSampledAt)}` : 'Current sample'}</small>
              </div>
              <div className="private-queue-tabs" role="group" aria-label="Queue mode">
                {hasComparison && <button type="button" className={queueMode === 'changes' ? 'is-active' : ''} onClick={() => setQueueMode('changes')} aria-pressed={queueMode === 'changes'}>Changes {changedRecords.length}</button>}
                <button type="button" className={queueMode === 'all' ? 'is-active' : ''} onClick={() => setQueueMode('all')} aria-pressed={queueMode === 'all'}>Observed {positions.length}</button>
              </div>
            </div>
            {data ? (
              <div className="private-change-list" aria-label="Aircraft change queue">
                {queueRecords.length > 0 ? queueRecords.map(record => (
                  <ChangeQueueRow key={`${record.change}-${record.icao}`} record={record} selected={record.icao === selectedIcao} onSelect={selectRecord} />
                )) : <p className="private-change-empty">No records changed since the prior sample.</p>}
              </div>
            ) : <Loading label={error ? 'Activity unavailable' : 'Loading activity'} />}
          </div>
          {data && (
            <TrendChart
              history={data.history || []}
              baselineCurve={data.baselineCurve || []}
              current={airborne ?? 0}
              mean={baseline.mean}
              rangeHours={rangeHours}
            />
          )}
          {data && !selectedRecord && <MethodCoverage data={data} snapshot={snapshot} comparison={comparison} />}
        </aside>

        {selectedRecord && <section className="private-detail-panel" aria-label="Selected aircraft">
          <div className="private-detail-panel__header">
            <span>Selected record</span>
            {selectedRecord?.change && <small>{CHANGE_LABELS[selectedRecord.change]}</small>}
          </div>
          <div className="private-detail-identity">
                <strong>{selectedRecord.callsign || selectedRecord.registration || selectedRecord.icao}</strong>
                <span>{selectedRecord.model || selectedRecord.manufacturer || 'Aircraft type unavailable'} · {selectedRecord.registration || selectedRecord.icao}</span>
              </div>
              <dl className="private-detail-fields">
                <div><dt>FAA registrant</dt><dd>{selectedRecord.owner || 'Unavailable'}</dd></div>
                <div><dt>Altitude</dt><dd>{selectedRecord.altitudeFt != null ? `${fmtNumber(selectedRecord.altitudeFt)} ft` : '—'}</dd></div>
                <div><dt>Speed</dt><dd>{selectedRecord.speedKt != null ? `${fmtNumber(selectedRecord.speedKt)} kt` : '—'}</dd></div>
                <div><dt>Heading</dt><dd>{selectedRecord.heading != null ? `${Math.round(selectedRecord.heading)}°` : '—'}</dd></div>
              </dl>
              <div className="private-detail-actions">
                {selectedPosition && <button type="button" onClick={() => setShowMap(open => !open)} aria-expanded={showMap}>{showMap ? 'Hide map' : 'Map'}</button>}
                <a href={`#flight=${selectedRecord.icao}${selectedRecord.callsign ? `&cs=${encodeURIComponent(selectedRecord.callsign)}` : ''}`}>Open flight record</a>
              </div>
              {showMap && selectedPosition && <PrivateMap positions={positions} selectedPosition={selectedPosition} trailByIcao={trailByIcao} onSelect={selectRecord} />}
          <MethodCoverage data={data} snapshot={snapshot} comparison={comparison} />
        </section>}
      </div>
    </section>
  )
}
