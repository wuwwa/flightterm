import { useState, useMemo, useRef, useEffect } from 'react'
import clsx from 'clsx'
import { squawkLabel, squawkColor } from '../utils/squawk'
import { detectPhase, PHASE } from '../utils/anomaly'
import { formatLocalTime } from '../utils/time'
import FilterBar, { emptyFilters, isFiltersActive, applyFilters } from './FilterBar'
import AircraftSearchBox from './AircraftSearchBox'
import Loading from './Loading'
import PulseMark from './PulseMark'

// Column layout (desktop): 8 essential columns. Older "operator", "country",
// "eta", "squawk", "hdg", "src" are folded into other cells or shown via tooltips
// to keep the table scannable. Mobile uses a subset via hideMobile.
const COLS = [
  { key: 'callsign', label: 'Flight' },
  { key: 'type',     label: 'Type', hideMobile: true },
  { key: 'route',    label: 'Route', hideMobile: true },
  { key: 'alt',      label: 'Altitude / ft', numeric: true },
  { key: 'vel',      label: 'Speed / kt', numeric: true },
  { key: 'vrate',    label: 'V-rate / fpm', hideMobile: true, numeric: true },
  { key: 'phase',    label: 'Phase' },
]

const REGIONS = [
  ['usa', 'US'],
  ['global', 'Global'],
  ['europe', 'Europe'],
  ['asia', 'Asia'],
  ['atlantic', 'Atlantic'],
]

// Abbreviate common country names to 2-3 chars
const COUNTRY_SHORT = {
  'united states': 'US', 'canada': 'CA', 'united kingdom': 'UK', 'germany': 'DE',
  'france': 'FR', 'italy': 'IT', 'spain': 'ES', 'netherlands': 'NL', 'belgium': 'BE',
  'switzerland': 'CH', 'austria': 'AT', 'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK',
  'finland': 'FI', 'ireland': 'IE', 'portugal': 'PT', 'poland': 'PL', 'greece': 'GR',
  'turkey': 'TR', 'russia': 'RU', 'china': 'CN', 'japan': 'JP', 'south korea': 'KR',
  'india': 'IN', 'australia': 'AU', 'new zealand': 'NZ', 'brazil': 'BR', 'mexico': 'MX',
  'argentina': 'AR', 'colombia': 'CO', 'chile': 'CL', 'israel': 'IL', 'egypt': 'EG',
  'south africa': 'ZA', 'saudi arabia': 'SA', 'united arab emirates': 'AE',
  'thailand': 'TH', 'singapore': 'SG', 'malaysia': 'MY', 'indonesia': 'ID',
  'philippines': 'PH', 'taiwan': 'TW', 'hong kong': 'HK', 'czech republic': 'CZ',
  'czechia': 'CZ', 'romania': 'RO', 'hungary': 'HU', 'iceland': 'IS', 'luxembourg': 'LU',
  'unknown': '—',
}
function shortCountry(c) {
  if (!c) return '—'
  return COUNTRY_SHORT[c.toLowerCase()] || c.slice(0, 3).toUpperCase()
}

const PHASE_LABEL = {
  [PHASE.CLIMB]:    'CLB',
  [PHASE.CRUISE]:   'CRZ',
  [PHASE.DESCENT]:  'DES',
  [PHASE.APPROACH]: 'APR',
  [PHASE.GROUND]:   'GND',
  [PHASE.UNKNOWN]:  '—',
}

const PHASE_COLOR = {
  [PHASE.CLIMB]:    'text-fg2',
  [PHASE.CRUISE]:   'text-fg2',
  [PHASE.DESCENT]:  'text-fg2',
  [PHASE.APPROACH]: 'text-fg2',
  [PHASE.GROUND]:   'text-fg3',
  [PHASE.UNKNOWN]:  'text-fg3',
}

// priority for takeoff sort — airborne first, then by phase
const TAKEOFF_RANK = {
  [PHASE.CLIMB]:    0,
  [PHASE.APPROACH]: 1,
  [PHASE.DESCENT]:  2,
  [PHASE.CRUISE]:   3,
  [PHASE.UNKNOWN]:  4,
  [PHASE.GROUND]:   5,
}

// ── ADS-B emitter category labels ────────────────────────────────────────────
const CAT_LABEL = {
  A1: 'Light', A2: 'Small', A3: 'Large', A4: 'B757', A5: 'Heavy',
  A6: 'HiPerf', A7: 'Rotor', B1: 'Glider', B2: 'Balloon', B4: 'Ultra',
  B6: 'UAV', C1: 'EmVeh', C2: 'SvcVeh',
}

// ── Data source indicator ────────────────────────────────────────────────────
function srcIndicator(f, enrichCache) {
  const parts = []
  if (f.tfms) parts.push('T')
  if (enrichCache[f.icao]?.adsbfi || enrichCache[f.icao]?.apl) parts.push('E')
  if (f.routeDeviation != null) parts.push('R')
  return parts.join('') || '—'
}

function verticalRateFpm(f, enrichCache) {
  if (f.vertRate != null) return Math.round(f.vertRate * 196.85)
  return enrichCache[f.icao]?.adsbfi?.baroRate ?? null
}

function SyncButton({ isSyncing, onSync }) {
  return (
    <button
      className={clsx(
        'flight-sync-button h-5 px-2 border text-[10px] transition-colors shrink-0',
        isSyncing ? 'border-ylw/45 text-ylw cursor-wait' : 'border-border text-fg3 hover:text-fg2 hover:border-border2'
      )}
      onClick={onSync}
      disabled={isSyncing}
      title={isSyncing ? 'Refreshing flight records' : 'Refresh flight records now'}
      aria-label={isSyncing ? 'Refreshing flight records' : 'Refresh flight records now'}
    >
      {isSyncing && <PulseMark state="loading" tone="ylw" className="flight-sync-button__mark" />}
      <span>{isSyncing ? 'Refreshing' : 'Refresh'}</span>
    </button>
  )
}

function FlightIndexSkeleton() {
  return (
    <div className="flight-index-skeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div className="flight-index-skeleton__row" key={row}>
          <i className="flight-index-skeleton__cell is-flight" />
          <i className="flight-index-skeleton__cell is-type" />
          <i className="flight-index-skeleton__cell is-route" />
          <i className="flight-index-skeleton__cell is-number" />
          <i className="flight-index-skeleton__cell is-number" />
          <i className="flight-index-skeleton__cell is-phase" />
        </div>
      ))}
    </div>
  )
}

export default function FlightTable({ flights, filter, onFilterChange, filters, onFiltersChange, selectedIcao, enrichCache, anomalies = {}, trackHistory = {}, onSelect, onArrived, onDeparted, onSync, isSyncing, dataStatus = 'loading', dataError, lastUpdatedAt, region = 'usa', onRegionChange, showMilitary = false, onShowMilitaryChange, signalsOpen = false, onToggleSignals }) {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 1023px)').matches)
  const PAGE_SIZE = isMobile ? 25 : 50
  const [sortKey, setSortKey] = useState('callsign')
  const [sortDir, setSortDir] = useState(1)
  const [page, setPage] = useState(0)
  const [newIcaos, setNewIcaos] = useState(new Set())
  const prevIcaosRef = useRef(new Set())
  const prevFlightsRef = useRef(new Map())
  const initialLoad = useRef(true)
  const lastSelectionRef = useRef(null)
  const pendingRevealRef = useRef(false)

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)')
    const update = () => setIsMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  // ── diff flights on each update ───────────────────────────────────────────
  useEffect(() => {
    const currentIcaos = new Set(flights.map(f => f.icao))
    const prevIcaos = prevIcaosRef.current

    if (initialLoad.current) {
      initialLoad.current = false
      prevIcaosRef.current = currentIcaos
      const flightMap = new Map()
      flights.forEach(f => flightMap.set(f.icao, f))
      prevFlightsRef.current = flightMap
      return
    }

    // new arrivals
    const arrived = new Set()
    for (const icao of currentIcaos) {
      if (!prevIcaos.has(icao)) arrived.add(icao)
    }

    // departed — collect callsigns for the log
    const departedList = []
    for (const icao of prevIcaos) {
      if (!currentIcaos.has(icao)) {
        const prev = prevFlightsRef.current.get(icao)
        departedList.push(prev?.callsign || icao)
      }
    }

    // update refs
    prevIcaosRef.current = currentIcaos
    const flightMap = new Map()
    flights.forEach(f => flightMap.set(f.icao, f))
    prevFlightsRef.current = flightMap

    // notify parent of arrivals
    if (arrived.size > 0 && onArrived) {
      const arrivedList = []
      for (const icao of arrived) {
        const f = flightMap.get(icao)
        arrivedList.push(f?.callsign || icao)
      }
      onArrived(arrivedList)
    }

    // notify parent of departures
    if (departedList.length > 0 && onDeparted) {
      onDeparted(departedList)
    }

    // highlight arrivals
    if (arrived.size > 0) {
      setNewIcaos(arrived)
    }

    const timer = arrived.size > 0
      ? setTimeout(() => setNewIcaos(new Set()), 2500)
      : null
    return () => { if (timer) clearTimeout(timer) }
  }, [flights])

  const q = filter.toLowerCase()

  const filterCtx = { anomalies, trackHistory, enrichCache, detectPhase, PHASE }

  // ── apply text filter + dimension filters ─────────────────────────────────
  const filtered = useMemo(() => {
    let list = flights.filter(f =>
      (f.callsign || '').toLowerCase().includes(q) ||
      (f.country || '').toLowerCase().includes(q) ||
      (f.icao || '').toLowerCase().includes(q) ||
      (f.acOperator || '').toLowerCase().includes(q) ||
      (f.acReg || '').toLowerCase().includes(q) ||
      (f.owner || f.acOwner || '').toLowerCase().includes(q) ||
      (f.acType || '').toLowerCase().includes(q) ||
      (f.airline?.name || '').toLowerCase().includes(q) ||
      (f.airline?.icao || '').toLowerCase().includes(q) ||
      (f.tfms?.dep_arpt || '').toLowerCase().includes(q) ||
      (f.tfms?.arr_arpt || '').toLowerCase().includes(q)
    )

    // Apply structured filters
    if (isFiltersActive(filters)) {
      list = list.filter(f => applyFilters(f, filters, filterCtx))
    }

    return list
  }, [flights, q, filters, anomalies, trackHistory, enrichCache])
  const hasActiveConstraints = isFiltersActive(filters) || Boolean(filter.trim())

  useEffect(() => { setPage(0) }, [q, filters])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      // special takeoff sort: ground/climb first, then by altitude ascending
      if (sortKey === 'takeoff') {
        const aHist = trackHistory[a.icao]
        const bHist = trackHistory[b.icao]
        const aPhase = aHist?.length >= 2 ? detectPhase(aHist) : (a.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
        const bPhase = bHist?.length >= 2 ? detectPhase(bHist) : (b.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
        const aRank = TAKEOFF_RANK[aPhase] ?? 5
        const bRank = TAKEOFF_RANK[bPhase] ?? 5
        if (aRank !== bRank) return (aRank - bRank) * sortDir
        const aAlt = a.alt ?? 99999
        const bAlt = b.alt ?? 99999
        return (aAlt - bAlt) * sortDir
      }

      // computed columns
      let va, vb
      if (sortKey === 'phase') {
        const aHist = trackHistory[a.icao]
        const bHist = trackHistory[b.icao]
        va = TAKEOFF_RANK[aHist?.length >= 2 ? detectPhase(aHist) : (a.grounded ? PHASE.GROUND : PHASE.UNKNOWN)] ?? 5
        vb = TAKEOFF_RANK[bHist?.length >= 2 ? detectPhase(bHist) : (b.grounded ? PHASE.GROUND : PHASE.UNKNOWN)] ?? 5
      } else if (sortKey === 'vrate') {
        va = verticalRateFpm(a, enrichCache)
        vb = verticalRateFpm(b, enrichCache)
      } else if (sortKey === 'type') {
        va = enrichCache[a.icao]?.adsbfi?.type || enrichCache[a.icao]?.aircraft?.icao_type || a.acType || ''
        vb = enrichCache[b.icao]?.adsbfi?.type || enrichCache[b.icao]?.aircraft?.icao_type || b.acType || ''
      } else if (sortKey === 'operator') {
        va = a.acOperator || a.country || ''
        vb = b.acOperator || b.country || ''
      } else if (sortKey === 'country') {
        va = shortCountry(a.country)
        vb = shortCountry(b.country)
      } else if (sortKey === 'route') {
        va = (a.tfms?.dep_arpt || '') + (a.tfms?.arr_arpt || '')
        vb = (b.tfms?.dep_arpt || '') + (b.tfms?.arr_arpt || '')
      } else if (sortKey === 'eta') {
        va = a.tfms?.eta || ''
        vb = b.tfms?.eta || ''
      } else if (sortKey === 'src') {
        va = srcIndicator(a, enrichCache)
        vb = srcIndicator(b, enrichCache)
      } else {
        va = a[sortKey]; vb = b[sortKey]
      }
      if (va == null) va = sortDir > 0 ? Infinity : -Infinity
      if (vb == null) vb = sortDir > 0 ? Infinity : -Infinity
      return va < vb ? -sortDir : va > vb ? sortDir : 0
    })
  }, [filtered, sortKey, sortDir, anomalies, trackHistory, enrichCache])

  const airborneCount = useMemo(
    () => filtered.reduce((total, flight) => total + (flight.grounded ? 0 : 1), 0),
    [filtered]
  )
  const sampleTime = lastUpdatedAt ? new Date(lastUpdatedAt) : null
  const sampleTimestamp = sampleTime && Number.isFinite(sampleTime.getTime())
    ? formatLocalTime(sampleTime, { seconds: true })
    : null

  const selectedIndex = selectedIcao ? sorted.findIndex(f => f.icao === selectedIcao) : -1
  const selectedExists = selectedIcao ? flights.some(f => f.icao === selectedIcao) : false
  const lastPageSizeRef = useRef(PAGE_SIZE)
  useEffect(() => {
    const pageSizeChanged = lastPageSizeRef.current !== PAGE_SIZE
    lastPageSizeRef.current = PAGE_SIZE
    if (!selectedIcao) { lastSelectionRef.current = null; return }
    if (lastSelectionRef.current !== selectedIcao || pageSizeChanged) {
      lastSelectionRef.current = selectedIcao
      if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / PAGE_SIZE))
    }
  }, [selectedIcao, selectedIndex, PAGE_SIZE])

  useEffect(() => {
    if (!pendingRevealRef.current || selectedIndex < 0) return
    pendingRevealRef.current = false
    setPage(Math.floor(selectedIndex / PAGE_SIZE))
  }, [selectedIndex, PAGE_SIZE])

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const selectedPage = selectedIndex >= 0 ? Math.floor(selectedIndex / PAGE_SIZE) : -1
  const displayed = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const handleSort = key => {
    if (sortKey === key) setSortDir(d => d * -1)
    else { setSortKey(key); setSortDir(1) }
    setPage(0)
  }

  const handleLiveSearchSelect = result => {
    const liveFlight = flights.find(f => f.icao === result.icao)
    if (!liveFlight) return false
    onFilterChange('')
    onSelect(liveFlight)
    return true
  }

  if (!flights.length) {
    const emptyMessage = dataStatus === 'live'
      ? 'No flights in this region.'
      : dataStatus === 'unavailable'
        ? 'Live data unavailable.'
      : dataStatus === 'stale'
          ? 'Live data delayed.'
          : 'Loading flights.'
    return (
      <div className="flex flex-col bg-bg flex-1 min-h-0">
        <div className="flex justify-between items-center py-0.5 px-2.5 bg-bg2 border-b border-border text-[11px] text-fg3 shrink-0">
          <span className="flex items-center gap-1.5">
            <span className="ft-chip ft-chip--muted">live traffic</span>
            <span className="text-fg2">0</span> records
          </span>
          <AircraftSearchBox
            filter={filter}
            onFilterChange={onFilterChange}
            onLiveSelect={handleLiveSearchSelect}
            className="flight-search ml-2 flex-1 max-w-xl"
          />
          {onRegionChange && (
            <label className="flight-region">
              <span className="sr-only">Flight region</span>
              <select value={region} onChange={event => onRegionChange(event.target.value)} aria-label="Flight region">
                {REGIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          )}
          <SyncButton isSyncing={isSyncing} onSync={onSync} />
        </div>
        <div className="flight-empty-state">
          {dataStatus === 'loading' || isSyncing ? (
            <>
              <div className="flight-empty-state__loading" role="status" aria-live="polite">
                <Loading inline label={isSyncing ? 'Updating the flight index' : 'Loading'} />
                <span>{isSyncing ? 'Updating the flight index' : 'Loading'}</span>
              </div>
              <FlightIndexSkeleton />
            </>
          ) : <span className="text-[12px] text-fg2">{emptyMessage}</span>}
          {dataError && <span className="text-[11px] text-ylw">{dataError}</span>}
          {(dataStatus === 'unavailable' || dataStatus === 'stale') && <button className="border border-border2 px-2 py-1 text-[11px] hover:border-acc hover:text-acc" onClick={onSync}>Retry</button>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col bg-bg flex-1 min-h-0">
      {dataStatus === 'stale' && (
        <div className="flight-data-status" role="status">
          <span>Live data delayed{sampleTimestamp ? ` · ${sampleTimestamp}` : ''}</span>
          <span>{dataError || 'Refresh unavailable.'}</span>
          <button onClick={onSync}>Retry</button>
        </div>
      )}
      <div className="shrink-0 bg-bg2 border-b border-border text-[10px] sm:text-[11px] text-fg3">
        {/* Row 1: records, pagination, sort */}
        <div className="flight-toolbar">
          <AircraftSearchBox
            filter={filter}
            onFilterChange={onFilterChange}
            onLiveSelect={handleLiveSearchSelect}
            className="flight-search"
          />
          <span className="flight-toolbar__count">
            {filtered.length.toLocaleString()} flights<span className="flight-toolbar__airborne"> · {airborneCount.toLocaleString()} airborne</span>
          </span>
          {totalPages > 1 && (
            <nav className="flight-toolbar__pagination" aria-label="Flight pages">
              <button
                className="flight-pagination-button"
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={safePage === 0}
                aria-label="Previous page"
              >
                ‹
              </button>
              <span>{safePage + 1}/{totalPages}</span>
              <button
                className="flight-pagination-button"
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={safePage >= totalPages - 1}
                aria-label="Next page"
              >
                ›
              </button>
            </nav>
          )}
          {onRegionChange && (
            <label className="flight-region">
              <span className="sr-only">Flight region</span>
              <select value={region} onChange={event => onRegionChange(event.target.value)} aria-label="Flight region">
                {REGIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          )}
          <SyncButton isSyncing={isSyncing} onSync={onSync} />
          {onToggleSignals && (
            <button
              className={clsx(
                'flight-signals-button h-5 px-2 border text-[10px] transition-colors shrink-0',
                signalsOpen ? 'border-fg2 text-fg bg-fg/8' : 'border-border text-fg3 hover:text-fg2 hover:border-border2'
              )}
              onClick={onToggleSignals}
              aria-pressed={signalsOpen}
              aria-label={signalsOpen ? 'Close signal queue' : 'Open signal queue'}
            >
              Signals
            </button>
          )}
        </div>
      </div>
      <FilterBar
        filters={filters}
        onChange={onFiltersChange}
        queryActive={Boolean(filter.trim())}
        onClearQuery={() => onFilterChange('')}
        showMilitary={showMilitary}
        onShowMilitaryChange={onShowMilitaryChange}
      />
      {selectedIcao && !selectedExists && (
        <div className="flight-selection-notice" role="status">
          <span>Flight left the live index.</span>
          <button onClick={() => onSelect(null)}>Close record</button>
        </div>
      )}
      {selectedIcao && selectedExists && selectedIndex < 0 && (
        <div className="flight-selection-notice" role="status">
          <span>Hidden by current filters.</span>
          <button onClick={() => { pendingRevealRef.current = true; onFiltersChange(emptyFilters()); onFilterChange('') }}>Clear filters</button>
        </div>
      )}
      {selectedIndex >= 0 && selectedPage !== safePage && (
        <div className="flight-selection-notice" role="status">
          <span>Selected flight · page {selectedPage + 1}</span>
          <button onClick={() => setPage(selectedPage)}>Return to selected</button>
        </div>
      )}
      {/* ── Compact records (< lg) — 2-line rows with all key data ─────────── */}
      <div className="overflow-auto flex-1 min-h-0 lg:hidden">
        {displayed.length === 0 && (
          <div className="text-center py-8 text-fg3 text-[11px]">
            {hasActiveConstraints ? 'No records match the current search or filters.' : 'Loading flights.'}
          </div>
        )}
        {displayed.map(f => {
          const isSel = f.icao === selectedIcao
          const enrich = enrichCache[f.icao]
          const isNew = newIcaos.has(f.icao)
          const anomaly = anomalies[f.icao]
          const hist = trackHistory[f.icao]
          const phase = hist?.length >= 2 ? detectPhase(hist) : (f.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
          const acType = enrich?.adsbfi?.type || enrich?.aircraft?.icao_type || f.acType || null
          const vr = verticalRateFpm(f, enrichCache)
          const altFt = f.alt != null ? Math.round(f.alt * 3.281) : null
          const spdKt = f.vel != null ? Math.round(f.vel * 1.944) : null
          const route = f.tfms?.dep_arpt && f.tfms?.arr_arpt
            ? `${f.tfms.dep_arpt.replace(/^K/, '')}→${f.tfms.arr_arpt.replace(/^K/, '')}`
            : enrich?.flightroute?.origin?.icao_code && enrich?.flightroute?.destination?.icao_code
              ? `${enrich.flightroute.origin.icao_code.replace(/^K/, '')}→${enrich.flightroute.destination.icao_code.replace(/^K/, '')}`
              : null
          return (
            <div
              key={f.icao + f.callsign}
              className={clsx(
                'flight-record-row px-2 py-1 border-b cursor-pointer active:bg-bg2',
                isSel
                  ? 'flight-record-row--selected bg-fg/8 border-l-2 border-l-fg border-white/3'
                  : anomaly
                    ? 'flight-record-row--anomaly bg-red/8 border-b-red/20 border-l-2 border-l-red'
                  : isNew
                    ? 'flight-record-row--new animate-row-arrive border-white/3'
                    : 'flight-record-row--plain border-white/3'
              )}
              onClick={() => onSelect(f)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(f)
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`Open ${f.callsign || f.icao} flight details`}
            >
              <div className="min-h-11 flex flex-col justify-center gap-0.5 text-[10px] tabular-nums">
                <div className="min-w-0 flex items-baseline gap-1">
                  {anomaly && <span className="text-red shrink-0">{anomaly.confirmed ? '!!' : '!'}</span>}
                  <span className="text-fg shrink-0">{f.callsign || f.icao}</span>
                  {showMilitary && f.mil && <span className="text-red text-[8px] shrink-0">MIL</span>}
                  {acType && <span className="text-fg3 truncate">{acType}</span>}
                  {route && <span className="text-fg3/60 truncate">{route}</span>}
                  {squawkLabel(f.squawk) && <span className={clsx('text-[8px] shrink-0', squawkColor(f.squawk))}>{squawkLabel(f.squawk)}</span>}
                </div>
                <div className="flex items-baseline gap-2 text-[9px]">
                  <span className={f.grounded ? 'text-fg3' : 'text-fg2'}>{altFt != null ? `${altFt.toLocaleString()} ft` : '—'}</span>
                  <span className="text-fg2">{spdKt != null ? `${spdKt} kt` : '—'}</span>
                  {vr != null && <span className={Math.abs(vr) > 2000 ? 'text-ylw' : 'text-fg3'}>{vr > 0 ? '+' : ''}{vr} fpm</span>}
                  <span className={clsx('ml-auto font-bold', PHASE_COLOR[phase])}>{PHASE_LABEL[phase]}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Desktop table (≥ lg) — standard 8-column layout ──────────────── */}
      <div className="overflow-auto flex-1 min-h-0 hidden lg:block">
      <table className="w-full border-separate border-spacing-0">
        <thead className="sticky top-0 z-1">
          <tr>
            {COLS.map(col => {
              const isActive = sortKey === col.key
              return (
                <th
                  key={col.key}
                  className={clsx(
                    'group p-0 font-normal text-[11px] select-none whitespace-nowrap bg-bg2 border-b border-border',
                    col.numeric ? 'text-right font-mono' : 'text-left',
                    isActive ? 'text-acc' : 'text-fg3 hover:text-fg2'
                  )}
                  aria-sort={isActive ? (sortDir > 0 ? 'ascending' : 'descending') : 'none'}
                >
                  <button
                    className={clsx('w-full py-1 px-2.5 border-0 bg-transparent text-inherit text-[11px]', col.numeric ? 'text-right' : 'text-left')}
                    onClick={() => handleSort(col.key)}
                    aria-label={`Sort by ${col.label}${isActive ? (sortDir > 0 ? ', ascending' : ', descending') : ''}`}
                  >
                    {col.label}
                    {isActive ? (
                      <span className="ml-1 text-[9px]">{sortDir > 0 ? '▲' : '▼'}</span>
                    ) : null}
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {displayed.length === 0 && (
            <tr>
              <td colSpan={COLS.length} className="text-center py-8 text-fg3 text-[11px]">
                {hasActiveConstraints
                  ? 'No records match the current search or filters.'
                  : 'Loading flights.'}
              </td>
            </tr>
          )}
          {displayed.map(f => {
            const isSel = f.icao === selectedIcao
            const enrich = enrichCache[f.icao]
            const isNew = newIcaos.has(f.icao)
            const anomaly = anomalies[f.icao]
            const hist = trackHistory[f.icao]
            const phase = hist?.length >= 2 ? detectPhase(hist) : (f.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
            const acType = enrich?.adsbfi?.type || enrich?.aircraft?.icao_type || f.acType || null
            const acReg = enrich?.adsbfi?.reg || enrich?.aircraft?.registration || f.acReg || null
            const vr = verticalRateFpm(f, enrichCache)
            const cat = f.category || enrich?.adsbfi?.category || enrich?.apl?.category || null
            return (
              <tr
                key={f.icao + f.callsign}
                className={clsx(
                  'flight-table__row border-b cursor-pointer',
                  isSel
                    ? 'flight-table__row--selected bg-fg/8 border-l-2 border-l-fg border-white/3'
                  : anomaly
                      ? 'flight-table__row--anomaly bg-red/8 border-b-red/20 border-l-2 border-l-red'
                    : isNew
                        ? 'flight-table__row--new animate-row-arrive border-white/3'
                        : 'flight-table__row--plain border-white/3'
                )}
                onClick={() => onSelect(f)}
                title={`Open ${f.callsign || f.icao} flight details`}
              >
                <td
                  className="py-1 px-2.5 whitespace-nowrap text-xs tabular-nums"
                  title={[f.acOperator, acReg, f.country].filter(Boolean).join(' · ')}
                >
                  {anomaly && (
                    <span
                      className="mr-1 text-red"
                      title={`[${anomaly.score}] ${anomaly.phase} — ${anomaly.reasons.join('; ')}`}
                    >
                      {anomaly.confirmed ? '!!' : '!'}
                    </span>
                  )}
                  <button
                    className="border-0 bg-transparent p-0 text-left hover:text-acc focus-visible:outline focus-visible:outline-2 focus-visible:outline-acc"
                    onClick={(event) => { event.stopPropagation(); onSelect(f) }}
                    aria-label={`Open ${f.callsign || f.icao} flight details`}
                    aria-current={isSel ? 'true' : undefined}
                  >
                    <span className="text-fg">{f.callsign || f.icao}</span>
                    <span className="ml-1.5 text-[9px] text-fg3">{f.icao}</span>
                  </button>
                  {showMilitary && f.mil && <span className="text-red text-[9px] ml-1">MIL</span>}
                  {squawkLabel(f.squawk) && (
                    <span className={clsx('ml-1 text-[9px]', squawkColor(f.squawk))} title={`squawk ${f.squawk}`}>
                      {squawkLabel(f.squawk)}
                    </span>
                  )}
                </td>
                <td
                  className="py-0.5 px-2.5 whitespace-nowrap text-xs text-fg3"
                  title={[f.acDesc || acType, cat ? CAT_LABEL[cat?.toUpperCase()] || cat : null, f.country].filter(Boolean).join(' · ')}
                >
                  {acType ? (
                    <>
                      <span className="text-fg2">{acType}</span>
                      {cat && <span className="text-fg3/50 text-[8px] ml-0.5">{CAT_LABEL[cat?.toUpperCase()] || cat}</span>}
                    </>
                  ) : (
                    <span className="text-fg3/40">{shortCountry(f.country) || '—'}</span>
                  )}
                </td>
                <td className="py-0.5 px-2.5 whitespace-nowrap text-xs tabular-nums" title={f.tfms?.route || ''}>
                  {f.tfms?.dep_arpt && f.tfms?.arr_arpt ? (
                    <span>
                      <span className="text-fg2">{f.tfms.dep_arpt.replace(/^K/, '')}</span>
                      <span className="text-fg3/40 mx-0.5">→</span>
                      <span className="text-fg2">{f.tfms.arr_arpt.replace(/^K/, '')}</span>
                      {f.tfms?.eta && (
                        <span className="text-fg3/60 text-[9px] ml-1.5">
                          {formatLocalTime(f.tfms.eta)}
                        </span>
                      )}
                      {f.routeDeviation > 50 && (
                        <span className={clsx('ml-1 text-[8px]', f.routeDeviation > 100 ? 'text-red' : 'text-ylw')} title={`${f.routeDeviation}km off ${f.routeDeviationMode === 'polyline' ? 'filed waypoints' : 'great-circle path'}`}>
                          {f.routeDeviation}km{f.routeDeviationMode === 'polyline' ? '*' : ''}
                        </span>
                      )}
                    </span>
                  ) : enrich?.flightroute ? (
                    <span className="text-fg3/60">
                      {enrich.flightroute.origin?.icao_code?.replace(/^K/, '') || '?'}
                      <span className="text-fg3/30 mx-0.5">→</span>
                      {enrich.flightroute.destination?.icao_code?.replace(/^K/, '') || '?'}
                    </span>
                  ) : <span className="text-fg3/40">—</span>}
                </td>
                <td className={clsx('py-0.5 px-2.5 whitespace-nowrap text-xs text-right tabular-nums', f.grounded ? 'text-fg3' : 'text-fg2')}>
                  {f.alt != null ? Math.round(f.alt * 3.281).toLocaleString() : <span className="text-fg3/40">—</span>}
                </td>
                <td className="py-0.5 px-2.5 whitespace-nowrap text-xs text-right text-fg2 tabular-nums">
                  {f.vel != null ? Math.round(f.vel * 1.944) : <span className="text-fg3/40">—</span>}
                </td>
                <td className={clsx('py-0.5 px-2.5 whitespace-nowrap text-xs text-right tabular-nums',
                  vr == null ? 'text-fg3/40' : Math.abs(vr) > 2000 ? 'text-ylw' : 'text-fg3'
                )}>
                  {vr != null ? `${vr > 0 ? '+' : ''}${vr}` : '—'}
                </td>
                <td
                  className={clsx('py-0.5 px-2.5 whitespace-nowrap text-xs', PHASE_COLOR[phase])}
                  title={f.hdg != null ? `heading ${f.hdg}°` : ''}
                >
                  {PHASE_LABEL[phase]}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}
