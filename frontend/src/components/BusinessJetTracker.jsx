import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, Marker, Polyline, Tooltip, useMap } from 'react-leaflet'
import { divIcon } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import clsx from 'clsx'
import { fetchBusinessJetTracker, fetchPrivateFlightPath } from '../services/dashboard'
import OpenFreeMapLayer from './OpenFreeMapLayer'
import usePageVisible from '../hooks/usePageVisible'
import { sampleState, sampleAge, comparable } from '../utils/privateActivity'
import recording from '../data/privateRecording.json'
import { observedPaths, projectedPath, routePath } from '../utils/privateFlightPath'
import PrivateActivityChart from './PrivateActivityChart'

function AutoFit({ points }) {
  const map = useMap()
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || !points.length) return
    fitted.current = true
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

function FocusAircraft({ point, paths, pathKey }) {
  const map = useMap()
  const fitted = useRef(null)
  useEffect(() => {
    if (!point) { fitted.current = null; return }
    const key = `${point.icao}:${pathKey}`
    if (fitted.current === key) return
    fitted.current = key
    const points = [...paths.flat(), [point.lat, point.lon]]
    if (points.length > 1) map.fitBounds(points, { padding: [32, 32], maxZoom: 7, animate: true })
    else map.setView([point.lat, point.lon], 6, { animate: true })
  }, [map, point, paths, pathKey])
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

function ObservationTimeline({ history, snapshot, frames, frameIndex, onSelect }) {
  const listRef = useRef(null)
  useEffect(() => {
    const list = listRef.current
    const selected = list?.querySelector('[aria-pressed="true"]')
    if (!selected) return
    const left = selected.getBoundingClientRect().left - list.getBoundingClientRect().left
    const right = left + selected.getBoundingClientRect().width
    if (left < 0) list.scrollLeft += left
    else if (right > list.clientWidth) list.scrollLeft += right - list.clientWidth
  }, [frames, frameIndex])
  const samples = frames || [...(history || []).map(row => ({
    sampledAt: row.sampled_at, airborneCount: row.airborne_count,
  })), ...(snapshot ? [snapshot] : [])]
    .filter((sample, index, all) => sample.sampledAt && sample.airborneCount != null
      && all.findIndex(other => other.sampledAt === sample.sampledAt) === index)
    .sort((a, b) => new Date(a.sampledAt) - new Date(b.sampledAt))
    .slice(-12)
  if (!samples.length) return null
  return (
    <section className="private-samples" aria-label={frames ? 'Recorded samples' : 'Recent samples'}>
      <div className="private-samples__heading">
        <strong>{frames ? 'Session' : 'Recent samples'}</strong>
        <span>{frames ? '21 AUG 2026 · ' : ''}UTC</span>
      </div>
      <PrivateActivityChart samples={samples} selectedIndex={frames ? frameIndex : samples.length - 1}
        onSelect={frames ? onSelect : undefined} />
      <ol className="private-samples__list" ref={listRef}>
        {samples.map((sample, index) => {
          const previous = samples[index - 1]
          const gapMinutes = previous ? Math.round((new Date(sample.sampledAt) - new Date(previous.sampledAt)) / 60_000) : 0
          const content = <><time dateTime={sample.sampledAt}>{fmtClock(sample.sampledAt)}</time><strong>{fmtNumber(sample.airborneCount)}<small> observed</small></strong></>
          return <li key={sample.sampledAt}>
            {gapMinutes > 45 && <span className="private-samples__gap" title="No observations during this interval">{Math.round(gapMinutes / 60)}h gap</span>}
            {frames ? <button type="button" aria-pressed={index === frameIndex} aria-label={`${fmtSampleStamp(sample.sampledAt)}, ${sample.airborneCount} observed`} onClick={() => onSelect(index)}>{content}</button> :
              <div className="private-samples__item" title={fmtSampleStamp(sample.sampledAt)}>{content}</div>}
          </li>
        })}
      </ol>
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
  newly_observed: 'Newly seen',
  continued: 'Continued',
  not_observed: 'Not seen',
}

function ChangeQueueRow({ record, selected, onSelect, showChange }) {
  const title = record.callsign || record.registration || record.icao
  const model = record.model || record.manufacturer || 'Unknown type'
  return (
    <button
      type="button"
      className={clsx('private-change-row', selected && 'is-selected', !showChange && 'is-current')}
      onClick={() => onSelect(record.icao)}
      aria-pressed={selected}
    >
      {showChange && <span className="private-change-row__state">{CHANGE_LABELS[record.change] || 'Observed'}</span>}
      <span className="private-change-row__aircraft">
        <strong>{title}</strong>
        <small>{model}</small>
      </span>
      <span className="private-change-row__registrant" title={record.owner || 'Registrant unavailable'}>
        {record.owner || 'Registrant unavailable'}
      </span>
      <span className="private-change-row__metric">{record.altitudeFt != null ? `${fmtNumber(record.altitudeFt)} ft` : '—'}</span>
      <span className="private-change-row__metric">{record.speedKt != null ? `${fmtNumber(record.speedKt)} kt` : '—'}</span>
    </button>
  )
}

function RecordInspector({ record, currentPosition, onClear, recorded = false }) {
  if (!record) {
    return (
      <section className="private-detail-panel" aria-labelledby="private-record-title">
        <div className="private-detail-panel__header"><h2 id="private-record-title">Aircraft details</h2></div>
        <p className="private-detail-panel__empty">Select a record</p>
      </section>
    )
  }

  return (
    <section className="private-detail-panel" aria-labelledby="private-record-title">
      <div className="private-detail-panel__header">
        <h2 id="private-record-title">Aircraft details</h2>
        <button type="button" onClick={onClear}>Clear</button>
      </div>
      <div className="private-detail-identity">
        <strong>{record.callsign || record.registration || record.icao}</strong>
        <span>{record.model || record.manufacturer || 'Unknown type'} · {record.registration || record.icao}</span>
      </div>
      <dl className="private-detail-fields">
        <div title={record.change === 'not_observed' ? 'Missing from this sample; a landing is not confirmed.' : undefined}><dt>Sample state</dt><dd>{CHANGE_LABELS[record.change] || 'Observed'}</dd></div>
        <div title="Registered entity, not necessarily the operator or anyone aboard."><dt>FAA registrant</dt><dd>{record.owner || 'Unavailable'}</dd></div>
        <div><dt>Altitude</dt><dd>{record.altitudeFt != null ? `${fmtNumber(record.altitudeFt)} ft` : '—'}</dd></div>
        <div><dt>Speed</dt><dd>{record.speedKt != null ? `${fmtNumber(record.speedKt)} kt` : '—'}</dd></div>
        <div><dt>Heading</dt><dd>{record.heading != null ? `${Math.round(record.heading)}°` : '—'}</dd></div>
        <div><dt>Position</dt><dd>{currentPosition ? 'Current sample' : 'Prior sample only'}</dd></div>
      </dl>
      {!recorded && <div className="private-detail-actions">
        <a href={`#flight=${record.icao}${record.callsign ? `&cs=${encodeURIComponent(record.callsign)}` : ''}`}>Open flight record</a>
      </div>}
    </section>
  )
}

function PrivateMap({ positions, selectedPosition, flightPath, sampledAt, onSelect }) {
  const newlyObserved = positions.filter(position => position.change === 'newly_observed').length
  const paths = useMemo(() => [...flightPath.observed, ...(flightPath.expected.length ? [flightPath.expected] : [])], [flightPath])
  return (
    <section className="private-map-detail" aria-labelledby="private-map-title">
      <div className="private-map-detail__header">
        <div>
          <strong id="private-map-title">Map</strong>
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
          <FocusAircraft point={selectedPosition} paths={paths} pathKey={`${flightPath.observed.length > 0}:${flightPath.route?.destination || 'projection'}`} />
          {flightPath.expected.length > 1 && <Polyline positions={flightPath.expected}
            pathOptions={{ color: '#d9b66f', opacity: 0.85, weight: 2, dashArray: '6 6' }}>
            <Tooltip>{flightPath.expectedLabel}</Tooltip>
          </Polyline>}
          {flightPath.observed.map((path, index) => <Polyline key={index} positions={path}
            pathOptions={{ color: '#72c7ca', opacity: 0.95, weight: 3 }}><Tooltip>Observed track</Tooltip></Polyline>)}
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
                  {p.owner || 'Registrant unavailable'}<br />
                  {p.altitudeFt != null ? `${fmtNumber(p.altitudeFt)}ft ` : ''}
                  {p.speedKt != null ? `${fmtNumber(p.speedKt)}kt ` : ''}
                  {p.heading != null ? `HDG ${Math.round(p.heading)}` : ''}
                </span>
              </Tooltip>
            </Marker>
          ))}
        </MapContainer>
      </div>
      {selectedPosition && <div className="private-path-key" aria-label="Flight path legend">
        <span className={flightPath.observed.length ? 'private-path-key__observed' : ''}>{flightPath.observed.length ? 'Observed' : flightPath.loading ? 'Loading track…' : flightPath.failed ? 'Track unavailable' : 'No earlier positions'}</span>
        <span className={flightPath.expected.length ? 'private-path-key__expected' : ''}
          title={flightPath.route ? 'Approximate route through resolved filed fixes; procedures and airways may be incomplete.' : 'Ten-minute projection at the sampled ground speed and heading, not a filed route.'}>
          {flightPath.expected.length ? flightPath.expectedLabel : 'Route unavailable'}
        </span>
        {flightPath.route && <span className="private-path-key__airports">{flightPath.route.origin} → {flightPath.route.destination}</span>}
      </div>}
    </section>
  )
}

export default function BusinessJetTracker({ backendOk, onRecordedChange }) {
  const [liveData, setLiveData] = useState(null)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('live')
  const [frameIndex, setFrameIndex] = useState(recording.frames.length - 1)
  const [selectedIcao, setSelectedIcao] = useState(null)
  const [queueMode, setQueueMode] = useState('all')
  const [now, setNow] = useState(Date.now())
  const [retry, setRetry] = useState(0)
  const [pathDetail, setPathDetail] = useState(null)
  const visible = usePageVisible()
  const recorded = mode === 'recorded'
  useEffect(() => { onRecordedChange?.(recorded) }, [recorded, onRecordedChange])
  const selectRecord = useCallback(icao => setSelectedIcao(icao), [])

  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [visible])

  useEffect(() => {
    if (!backendOk || !visible || recorded) return
    let cancelled = false
    let busy = false
    const controller = new AbortController()
    const refresh = async () => {
      if (busy) return
      busy = true
      try {
        const next = await fetchBusinessJetTracker(controller.signal)
        if (!cancelled) { setLiveData(next); setError(null); setNow(Date.now()) }
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || err.message)
      } finally { busy = false }
    }
    refresh()
    const id = setInterval(refresh, 15_000)
    return () => { cancelled = true; controller.abort(); clearInterval(id) }
  }, [backendOk, visible, recorded, retry])

  const data = useMemo(() => {
    if (!recorded) return liveData
    const frame = recording.frames[frameIndex]
    const previous = recording.frames[frameIndex - 1]
    const canCompare = comparable(previous, frame)
    const prior = new Set(previous?.positions.map(p => p.icao) || [])
    const current = new Set(frame.positions.map(p => p.icao))
    return {
      snapshot: { ...frame, matchedCount: frame.airborneCount },
      cohortSize: frame.cohortSize,
      positions: frame.positions,
      history: recording.frames.slice(0, frameIndex + 1).map(f => ({ sampled_at: f.sampledAt, airborne_count: f.airborneCount })),
      comparison: canCompare ? { previousSampledAt: previous.sampledAt, records: [
        ...frame.positions.map(p => ({ ...p, change: prior.has(p.icao) ? 'continued' : 'newly_observed' })),
        ...previous.positions.filter(p => !current.has(p.icao)).map(p => ({ ...p, change: 'not_observed' })),
      ] } : null,
    }
  }, [recorded, liveData, frameIndex])

  const snapshot = data?.snapshot
  const state = recorded ? 'recorded' : snapshot && (!backendOk || error) ? 'saved' : sampleState(snapshot?.sampledAt, now)
  const comparison = data?.comparison
  const positions = useMemo(() => (data?.positions || []).filter(p => p.lat != null && p.lon != null), [data])
  const comparisonRecords = comparison?.records || positions
  const hasComparison = Boolean(comparison?.previousSampledAt)
  const changedRecords = comparisonRecords.filter(record => record.change && record.change !== 'continued')
  const records = queueMode === 'changes' && hasComparison ? changedRecords : positions
  const selectedRecord = comparisonRecords.find(p => p.icao === selectedIcao)
  const selectedPosition = positions.find(p => p.icao === selectedIcao)
  useEffect(() => {
    if (recorded || !selectedIcao || !backendOk || !visible) return
    const controller = new AbortController()
    fetchPrivateFlightPath(selectedIcao, controller.signal)
      .then(detail => { if (!controller.signal.aborted) setPathDetail(detail) })
      .catch(() => { if (!controller.signal.aborted) setPathDetail(previous => ({
        icao: selectedIcao, sampledAt: snapshot?.sampledAt,
        track: previous?.icao === selectedIcao ? previous.track : [], failed: true,
      })) })
    return () => controller.abort()
  }, [recorded, selectedIcao, backendOk, visible, snapshot?.sampledAt, retry])

  const flightPath = useMemo(() => {
    const detail = !recorded && pathDetail?.icao === selectedIcao ? pathDetail : null
    const track = recorded ? recording.frames.slice(0, frameIndex + 1).flatMap(frame =>
      frame.positions.filter(p => p.icao === selectedIcao).map(p => ({ ...p, sampledAt: frame.sampledAt }))) : detail?.track || []
    const observed = observedPaths([...track, ...(selectedPosition ? [selectedPosition] : [])], snapshot?.sampledAt, recorded ? 45 : 20)
    const route = detail && detail.sampledAt === snapshot?.sampledAt ? detail.route : null
    const expected = route ? routePath(route.points, selectedPosition?.lon) : projectedPath(selectedPosition)
    return { observed, expected, route, expectedLabel: route?.label || 'Projected · 10 min', loading: !recorded && !detail && backendOk, failed: detail?.failed }
  }, [recorded, pathDetail, selectedIcao, selectedPosition, frameIndex, snapshot?.sampledAt, backendOk])
  const waiting = !recorded && (!backendOk || !snapshot)
  const changeMode = next => { setMode(next); setSelectedIcao(null); setQueueMode('all') }

  return (
    <section className="private-jet-tracker">
      <header className="private-jet-titlebar">
        <div>
          <span className="private-jet-titlebar__index">Long-range jets</span>
          <h1>Private aircraft</h1>
        </div>
        <div className="private-controls">
          {snapshot?.sampledAt && <time className="private-sample-time" dateTime={snapshot.sampledAt} title={sampleAge(snapshot.sampledAt, now)}>{fmtSampleStamp(snapshot.sampledAt)}</time>}
          {!recorded && (error || !backendOk || state === 'saved') && <span className="private-attention" role="status">{error || !backendOk ? 'Reconnecting…' : 'Delayed'}</span>}
          <div className="private-mode" role="group" aria-label="Observation mode">
            <button aria-pressed={!recorded} onClick={() => changeMode('live')}>Current</button>
            <button aria-pressed={recorded} onClick={() => changeMode('recorded')}>Recorded</button>
          </div>
          {!recorded && <button className="private-refresh" onClick={() => setRetry(n => n + 1)} disabled={!backendOk}>Refresh</button>}
        </div>
      </header>

      <div className="private-summary">
        <strong>{snapshot?.airborneCount == null ? '—' : fmtNumber(snapshot.airborneCount)} <span>observed</span></strong>
      </div>

      <div className="private-jet-layout">
        <section className="private-jet-analysis" aria-label="Observed aircraft">
          <div className="private-change-queue">
            <div className="private-change-queue__header">
              <div><strong>Aircraft</strong>{queueMode === 'changes' && hasComparison && <small>Since {fmtClock(comparison.previousSampledAt)}</small>}</div>
              <div className="private-queue-tabs" role="group" aria-label="Aircraft list">
                <button aria-pressed={queueMode === 'all' || !hasComparison} className={queueMode === 'all' || !hasComparison ? 'is-active' : ''} onClick={() => setQueueMode('all')}>All {positions.length}</button>
                {hasComparison && <button aria-pressed={queueMode === 'changes'} className={queueMode === 'changes' ? 'is-active' : ''} onClick={() => setQueueMode('changes')}>Changes {changedRecords.length}</button>}
              </div>
            </div>
            <div className="private-change-list" aria-label="Aircraft observations">
              {records.map(record => <ChangeQueueRow key={record.icao} record={record} showChange={queueMode === 'changes' && hasComparison} selected={record.icao === selectedIcao} onSelect={selectRecord} />)}
              {!records.length && <p className="private-change-empty">{waiting ? 'Waiting for a sample…' : queueMode === 'changes' && hasComparison ? 'No changes.' : snapshot ? 'No aircraft observed.' : 'No saved sample.'}</p>}
            </div>
          </div>
        </section>
        <aside className="private-spatial-context" aria-label="Map and aircraft details">
          {positions.length > 0 ? <PrivateMap key={mode} positions={positions} selectedPosition={selectedPosition || selectedRecord} flightPath={flightPath} sampledAt={snapshot?.sampledAt} onSelect={selectRecord} /> :
            <section className="private-map-empty">No positions yet.</section>}
          {selectedRecord ? <RecordInspector record={selectedRecord} currentPosition={selectedPosition} recorded={recorded} onClear={() => setSelectedIcao(null)} /> :
            <p className="private-selection-hint">Select an aircraft</p>}
        </aside>
      </div>

      <ObservationTimeline history={data?.history} snapshot={snapshot}
        frames={recorded ? recording.frames : null} frameIndex={frameIndex}
        onSelect={index => { setFrameIndex(index); setSelectedIcao(icao => recording.frames[index].positions.some(p => p.icao === icao) ? icao : null) }} />
      <footer className="private-source-note">
        <span>Public flight data · FAA registry</span>
      </footer>
    </section>
  )
}
