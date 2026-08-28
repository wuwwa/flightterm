import { useCallback, useEffect, useMemo, useState } from 'react'
import { MapContainer, Marker, Polyline, Tooltip, useMap } from 'react-leaflet'
import { divIcon } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import clsx from 'clsx'
import { fetchBusinessJetTracker } from '../services/dashboard'
import OpenFreeMapLayer from './OpenFreeMapLayer'
import Loading from './Loading'

const REFRESH_MS = 30_000

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
    html: `<div class="bj-plane-icon${selected ? ' is-selected' : ''}${p.change === 'newly_observed' ? ' is-new' : ''}" style="--hdg:${hdg}deg">✈</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

function trailForPlane(p, trailByIcao) {
  const trail = trailByIcao[p.icao] || []
  if (trail.length > 1) return trail.map(t => [t.lat, t.lon])
  return []
}

function fmtTraceTick(iso, rangeHours) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  if (rangeHours >= 24) return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hh}:${mm}z`
  return `${hh}:${mm}z`
}

function timeValue(iso) {
  const value = new Date(iso).getTime()
  return Number.isFinite(value) ? value : null
}

function segmentedPath(points, x, y, field, maxGapMs = 95 * 60_000) {
  let previousAt = null
  let path = ''
  for (const point of points) {
    const value = Number(point[field])
    if (!Number.isFinite(point.at) || !Number.isFinite(value)) continue
    const command = previousAt == null || point.at - previousAt > maxGapMs ? 'M' : 'L'
    path += `${command}${x(point.at).toFixed(1)},${y(value).toFixed(1)} `
    previousAt = point.at
  }
  return path.trim()
}

function referenceBandPath(points, x, y) {
  const valid = points.filter(point => Number.isFinite(point.at) && Number.isFinite(Number(point.mean)) && Number.isFinite(Number(point.p90)))
  if (valid.length < 2) return ''
  const high = valid.map(point => `${x(point.at).toFixed(1)},${y(point.p90).toFixed(1)}`)
  const mean = [...valid].reverse().map(point => `${x(point.at).toFixed(1)},${y(point.mean).toFixed(1)}`)
  return `M${high.join(' L')} L${mean.join(' L')} Z`
}

function ActivityTrace({ history, baselineCurve, snapshot, rangeHours = 24 }) {
  const endAt = timeValue(snapshot?.sampledAt) || Date.now()
  const startAt = endAt - rangeHours * 3600_000
  const observed = (history || [])
    .map(row => ({ at: timeValue(row.sampled_at), airborne: Number(row.airborne_count) }))
    .filter(row => Number.isFinite(row.at) && row.at >= startAt && row.at <= endAt && Number.isFinite(row.airborne))
    .sort((a, b) => a.at - b.at)
  const snapshotAt = timeValue(snapshot?.sampledAt)
  const snapshotCount = Number(snapshot?.airborneCount)
  if (Number.isFinite(snapshotAt) && snapshotAt >= startAt && snapshotAt <= endAt && Number.isFinite(snapshotCount) && !observed.some(row => row.at === snapshotAt)) {
    observed.push({ at: snapshotAt, airborne: snapshotCount })
  }
  const reference = (baselineCurve || [])
    .map(row => ({ at: timeValue(row.sampled_at), mean: Number(row.mean), p90: Number(row.p90) }))
    .filter(row => Number.isFinite(row.at) && row.at >= startAt && row.at <= endAt)
    .sort((a, b) => a.at - b.at)

  const w = 620
  const h = 210
  const pad = { l: 35, r: 12, t: 18, b: 25 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const maxValue = Math.max(5, ...observed.map(row => row.airborne), ...reference.map(row => row.p90).filter(Number.isFinite))
  const axisMax = Math.ceil(maxValue / 5) * 5
  const x = at => pad.l + ((at - startAt) / (endAt - startAt)) * innerW
  const y = value => pad.t + innerH - (Math.max(0, Number(value) || 0) / axisMax) * innerH
  const observedPath = segmentedPath(observed, x, y, 'airborne')
  const meanPath = segmentedPath(reference, x, y, 'mean', Infinity)
  const p90Path = segmentedPath(reference, x, y, 'p90', Infinity)
  const referenceBand = referenceBandPath(reference, x, y)
  const latestReference = reference[reference.length - 1] || null
  const latestObserved = observed[observed.length - 1] || null
  const latestCount = latestObserved?.airborne ?? snapshot?.airborneCount ?? null
  const ticks = [startAt, startAt + (endAt - startAt) / 2, endAt]
  const hasReference = reference.length > 0
  const chartDescription = `${latestCount == null ? 'No current count is available' : `${fmtNumber(latestCount)} observed`}. ${observed.length} recorded sample${observed.length === 1 ? '' : 's'} in the selected window; lines do not cross missing intervals.`

  return (
    <section className="private-trace" aria-labelledby="private-trace-title">
      <div className="private-trace__header">
        <div>
          <h2 id="private-trace-title">{hasReference ? 'Observed activity vs reference' : 'Observed activity'}</h2>
        </div>
        <span>{rangeHours}h · UTC</span>
      </div>
      <dl className={clsx('private-trace__readout', hasReference && 'has-reference')}>
        <div><dt>Observed</dt><dd>{latestCount == null ? '—' : fmtNumber(latestCount)}</dd></div>
        <div><dt>Recorded samples</dt><dd>{observed.length || '—'}</dd></div>
        {hasReference && <>
          <div><dt>Reference mean</dt><dd>{Number.isFinite(latestReference?.mean) ? latestReference.mean.toFixed(1) : '—'}</dd></div>
          <div><dt>High reference (P90)</dt><dd>{Number.isFinite(latestReference?.p90) ? fmtNumber(latestReference.p90) : '—'}</dd></div>
        </>}
      </dl>
      <figure className="private-trace__figure">
        <figcaption>
          <span><i className="is-observed" />Observed</span>
          {hasReference && <>
            <span><i className="is-mean" />Time-matched mean</span>
            <span><i className="is-high" />Mean to P90 reference</span>
          </>}
        </figcaption>
        <svg viewBox={`0 0 ${w} ${h}`} className="private-trace__chart" preserveAspectRatio="none" role="img" aria-label={`Observed aircraft count against a time-matched reference. ${chartDescription}`}>
          <line x1={pad.l} y1={y(axisMax)} x2={w - pad.r} y2={y(axisMax)} stroke="#30342f" strokeWidth="1" />
          <line x1={pad.l} y1={y(axisMax / 2)} x2={w - pad.r} y2={y(axisMax / 2)} stroke="#30342f" strokeWidth="1" strokeDasharray="2 5" />
          <line x1={pad.l} y1={y(0)} x2={w - pad.r} y2={y(0)} stroke="#4b5049" strokeWidth="1" />
          {referenceBand && <path d={referenceBand} fill="#e2b45e" fillOpacity="0.12" />}
          {meanPath && <path d={meanPath} fill="none" stroke="#69a9b1" strokeWidth="1.5" strokeDasharray="4 4" />}
          {p90Path && <path d={p90Path} fill="none" stroke="#e2b45e" strokeWidth="1" />}
          {observedPath && <path d={observedPath} fill="none" stroke="#f2f0e6" strokeWidth="2" />}
          {observed.map(point => <circle key={point.at} cx={x(point.at)} cy={y(point.airborne)} r="3.4" fill="#f2f0e6" stroke="#171918" strokeWidth="1.3" />)}
          <text x={pad.l - 7} y={y(axisMax) + 3} textAnchor="end" fill="#7d8179" fontSize="9">{axisMax}</text>
          <text x={pad.l - 7} y={y(axisMax / 2) + 3} textAnchor="end" fill="#7d8179" fontSize="9">{axisMax / 2}</text>
          <text x={pad.l - 7} y={y(0) + 3} textAnchor="end" fill="#7d8179" fontSize="9">0</text>
        </svg>
        <div className="private-trace__ticks" style={{ gridTemplateColumns: `repeat(${ticks.length}, minmax(0, 1fr))` }}>
          {ticks.map((tick, index) => <span key={tick} className={index === 0 ? 'text-left' : index === ticks.length - 1 ? 'text-right' : 'text-center'}>{fmtTraceTick(new Date(tick).toISOString(), rangeHours)}</span>)}
        </div>
      </figure>
    </section>
  )
}

function fmtClock(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '—'
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}z`
}

function fmtSampleStamp(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '—'
  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()
  return `${day} ${month} · ${fmtClock(iso).toUpperCase()}`
}

function fmtNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number).toLocaleString() : '—'
}

const CHANGE_LABELS = {
  newly_observed: 'Appeared in sample',
  continued: 'Continued',
  not_observed: 'No longer observed',
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

function RecordInspector({ record, currentPosition, onClear }) {
  if (!record) {
    return (
      <section className="private-detail-panel" aria-labelledby="private-record-title">
        <div className="private-detail-panel__header"><h2 id="private-record-title">Record inspection</h2></div>
        <p className="private-detail-panel__empty">Select a record</p>
      </section>
    )
  }

  return (
    <section className="private-detail-panel" aria-labelledby="private-record-title">
      <div className="private-detail-panel__header">
        <h2 id="private-record-title">Record inspection</h2>
        <button type="button" onClick={onClear}>Clear</button>
      </div>
      <div className="private-detail-identity">
        <strong>{record.callsign || record.registration || record.icao}</strong>
        <span>{record.model || record.manufacturer || 'Aircraft type unavailable'} · {record.registration || record.icao}</span>
      </div>
      <dl className="private-detail-fields">
        <div><dt>Sample state</dt><dd>{CHANGE_LABELS[record.change] || 'Observed'}</dd></div>
        <div><dt>FAA registrant</dt><dd>{record.owner || 'Unavailable'}</dd></div>
        <div><dt>Altitude</dt><dd>{record.altitudeFt != null ? `${fmtNumber(record.altitudeFt)} ft` : '—'}</dd></div>
        <div><dt>Speed</dt><dd>{record.speedKt != null ? `${fmtNumber(record.speedKt)} kt` : '—'}</dd></div>
        <div><dt>Heading</dt><dd>{record.heading != null ? `${Math.round(record.heading)}°` : '—'}</dd></div>
        <div><dt>Position</dt><dd>{currentPosition ? 'Current sample' : 'Prior sample only'}</dd></div>
      </dl>
      <div className="private-detail-actions">
        <a href={`#flight=${record.icao}${record.callsign ? `&cs=${encodeURIComponent(record.callsign)}` : ''}`}>Open flight record</a>
      </div>
    </section>
  )
}

function PrivateMap({ positions, selectedPosition, trailByIcao, sampledAt, onSelect }) {
  const newlyObserved = positions.filter(position => position.change === 'newly_observed').length
  return (
    <section className="private-map-detail" aria-labelledby="private-map-title">
      <div className="private-map-detail__header">
        <div>
          <strong id="private-map-title">Spatial context</strong>
          <span>{sampledAt ? fmtSampleStamp(sampledAt) : 'No verified sample'}</span>
        </div>
        <span>{positions.length} observed{newlyObserved ? ` · ${newlyObserved} new` : ''}</span>
      </div>
      <div className="private-map-detail__canvas">
        <MapContainer
          center={[39, -96]}
          zoom={2}
          scrollWheelZoom={false}
          zoomControl
          attributionControl
          style={{ height: '100%', width: '100%', minHeight: 260, background: '#0d0d0d' }}
        >
          <OpenFreeMapLayer opacity={0.58} />
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
                  {p.change === 'newly_observed' ? 'New in this sample' : 'Observed in this sample'}<br />
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

function MethodCoverage({ comparison }) {
  return (
    <details className="private-method">
      <summary>Dataset</summary>
      <dl>
        <div><dt>Registry</dt><dd>FAA · registrant</dd></div>
        <div><dt>Coverage</dt><dd>Public broadcast</dd></div>
        <div><dt>Sampling</dt><dd>30 min</dd></div>
        <div><dt>Scope</dt><dd>Fixed registry cohort</dd></div>
        <div><dt>Prior sample</dt><dd>{comparison?.previousSampledAt ? fmtSampleStamp(comparison.previousSampledAt) : 'Unavailable'}</dd></div>
      </dl>
    </details>
  )
}

export default function BusinessJetTracker({ backendOk }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [trailByIcao, setTrailByIcao] = useState({})
  const [rangeHours, setRangeHours] = useState(24)
  const [selectedIcao, setSelectedIcao] = useState(null)
  const [queueMode, setQueueMode] = useState('changes')
  const selectRecord = useCallback((icao) => {
    setSelectedIcao(icao)
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
  const comparisonRecords = useMemo(
    () => comparison?.records || positions.map(position => ({ ...position, change: 'observed' })),
    [comparison, positions]
  )
  const currentPositions = useMemo(() => {
    const changes = new Map(comparisonRecords.map(record => [record.icao, record.change]))
    return positions.map(position => ({ ...position, change: changes.get(position.icao) || 'observed' }))
  }, [comparisonRecords, positions])
  const hasComparison = Boolean(comparison?.previousSampledAt)
  const changedRecords = useMemo(
    () => comparisonRecords.filter(record => record.change !== 'continued'),
    [comparisonRecords]
  )
  const queueRecords = useMemo(() => {
    if (queueMode === 'changes' && hasComparison) return changedRecords
    return currentPositions
  }, [changedRecords, currentPositions, hasComparison, queueMode])
  const selectedRecord = useMemo(
    () => comparisonRecords.find(record => record.icao === selectedIcao) || null,
    [comparisonRecords, selectedIcao]
  )
  const selectedPosition = useMemo(() => currentPositions.find(p => p.icao === selectedIcao) || null, [currentPositions, selectedIcao])
  const referenceReady = data?.calibrationStatus?.state === 'calibrated'
    && Number.isFinite(Number(baseline.mean))
    && (data?.baselineCurve || []).length > 1
  const airborne = snapshot?.airborneCount ?? null
  const delta = referenceReady && airborne != null ? airborne - Number(baseline.mean) : null
  const comparableMean = referenceReady ? Number(baseline.mean).toFixed(1) : '—'
  const matchCoverage = snapshot?.matchedCount != null && data?.cohortSize != null
    ? `${snapshot.matchedCount.toLocaleString()} / ${data.cohortSize.toLocaleString()}`
    : '—'
  useEffect(() => {
    setQueueMode(hasComparison ? 'changes' : 'all')
  }, [hasComparison])
  useEffect(() => {
    if (!currentPositions.length || !snapshot?.sampledAt) return
    setTrailByIcao(prev => {
      const active = new Set(currentPositions.map(p => p.icao))
      const next = {}
      for (const p of currentPositions) {
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
  }, [currentPositions, snapshot?.sampledAt])

  return (
    <section className="private-jet-tracker">
      <header className="private-jet-titlebar">
        <div>
          <span className="private-jet-titlebar__index">U.S. FAA registry · fixed public-record cohort</span>
          <h1>Private long-range activity</h1>
        </div>
        <div className="private-range" role="group" aria-label="Activity trace window">
          {[6, 24, 48].map(hours => (
            <button key={hours} className={rangeHours === hours ? 'is-active' : ''} onClick={() => setRangeHours(hours)} aria-pressed={rangeHours === hours}>
              {hours}h
            </button>
          ))}
        </div>
      </header>
      {error && (
        <div className={clsx('private-availability', data ? 'is-stale' : 'is-unavailable')} role="status">
          <strong>{data ? 'Data delayed' : 'Data unavailable'}</strong>
          <span>{data ? `Last verified ${fmtSampleStamp(snapshot?.sampledAt)}.` : 'No verified sample.'}</span>
        </div>
      )}
      <div className={clsx('private-jet-overview', referenceReady && 'has-reference')}>
        <div><span>Observed</span><strong>{airborne == null ? '—' : airborne.toLocaleString()}</strong><small>aircraft</small></div>
        <div><span>Observed / cohort</span><strong>{matchCoverage}</strong><small>latest sample</small></div>
        <div><span>Latest sample</span><strong>{fmtClock(snapshot?.sampledAt).toUpperCase()}</strong><small>{snapshot?.sampledAt ? fmtSampleStamp(snapshot.sampledAt).split(' · ')[0] : '—'}</small></div>
        {referenceReady && <>
          <div><span>Time-matched mean</span><strong>{comparableMean}</strong><small>aircraft</small></div>
          <div><span>Difference to mean</span><strong>{delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`}</strong><small>aircraft</small></div>
        </>}
      </div>

      <div className="private-jet-layout">
        <section className="private-jet-analysis" aria-label="Activity analysis">
          {data ? (
            <ActivityTrace
              history={data.history || []}
              baselineCurve={referenceReady ? data.baselineCurve || [] : []}
              snapshot={snapshot}
              rangeHours={rangeHours}
            />
          ) : <Loading label={error ? 'Activity unavailable' : 'Loading activity'} />}
          {data && (
            <div className="private-change-queue">
              <div className="private-change-queue__header">
                <div>
                  <span>Sample transitions</span>
                  <small>{hasComparison ? `Compared with ${fmtClock(comparison.previousSampledAt)}` : 'Current verified sample'}</small>
                </div>
                <div className="private-queue-tabs" role="group" aria-label="Transition queue mode">
                  {hasComparison && <button type="button" className={queueMode === 'changes' ? 'is-active' : ''} onClick={() => setQueueMode('changes')} aria-pressed={queueMode === 'changes'}>Transitions {changedRecords.length}</button>}
                  <button type="button" className={queueMode === 'all' ? 'is-active' : ''} onClick={() => setQueueMode('all')} aria-pressed={queueMode === 'all'}>Current {currentPositions.length}</button>
                </div>
              </div>
              <div className="private-change-list" aria-label="Aircraft transition queue">
                {queueRecords.length > 0 ? queueRecords.map(record => (
                  <ChangeQueueRow key={`${record.change}-${record.icao}`} record={record} selected={record.icao === selectedIcao} onSelect={selectRecord} />
                )) : <p className="private-change-empty">No records changed since the prior verified sample.</p>}
              </div>
            </div>
          )}
        </section>

        <aside className="private-spatial-context" aria-label="Spatial and record context">
          {data && currentPositions.length > 0 ? (
            <PrivateMap positions={currentPositions} selectedPosition={selectedPosition} trailByIcao={trailByIcao} sampledAt={snapshot?.sampledAt} onSelect={selectRecord} />
          ) : (
            <section className="private-map-empty" aria-label="Spatial context unavailable">No current positions are available for the latest verified sample.</section>
          )}
          <RecordInspector record={selectedRecord} currentPosition={selectedPosition} onClear={() => setSelectedIcao(null)} />
          {data && <MethodCoverage comparison={comparison} />}
        </aside>
      </div>
    </section>
  )
}
