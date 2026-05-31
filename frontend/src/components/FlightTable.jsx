import { useState, useMemo, useRef, useEffect } from 'react'
import clsx from 'clsx'
import { squawkLabel, squawkColor } from '../utils/squawk'
import { detectPhase, PHASE } from '../utils/anomaly'
import FilterBar, { emptyFilters, isFiltersActive, applyFilters, computeFilterCounts } from './FilterBar'
import AircraftSearchBox from './AircraftSearchBox'
import Loading from './Loading'

// Column layout (desktop): 8 essential columns. Older "operator", "country",
// "eta", "squawk", "hdg", "src" are folded into other cells or shown via tooltips
// to keep the table scannable. Mobile uses a subset via hideMobile.
const COLS = [
  { key: 'icao',     label: 'icao24' },
  { key: 'callsign', label: 'callsign' },
  { key: 'type',     label: 'type', hideMobile: true },
  { key: 'route',    label: 'route', hideMobile: true },
  { key: 'alt',      label: 'alt' },
  { key: 'vel',      label: 'spd' },
  { key: 'vrate',    label: 'v/r', hideMobile: true },
  { key: 'phase',    label: 'phase' },
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
  [PHASE.CLIMB]:    'text-grn',
  [PHASE.CRUISE]:   'text-cyn',
  [PHASE.DESCENT]:  'text-ylw',
  [PHASE.APPROACH]: 'text-mag',
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

export default function FlightTable({ flights, filter, onFilterChange, selectedIcao, enrichCache, anomalies = {}, trackHistory = {}, openskyUsage, aeroSpend, trackedIcaos, onToggleTrack, onSelect, onArrived, onDeparted, onSync, isSyncing }) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 580
  const PAGE_SIZE = isMobile ? 25 : 50
  const [sortKey, setSortKey] = useState('takeoff')
  const [sortDir, setSortDir] = useState(1)
  const [page, setPage] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [filters, setFilters] = useState(emptyFilters)
  const [newIcaos, setNewIcaos] = useState(new Set())
  const prevIcaosRef = useRef(new Set())
  const prevFlightsRef = useRef(new Map())
  const initialLoad = useRef(true)

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

  // ── compute filter counts for badges ──────────────────────────────────────
  const filterCtx = { anomalies, trackHistory, enrichCache, detectPhase, PHASE }
  const filterCounts = useMemo(
    () => computeFilterCounts(flights, filterCtx),
    [flights, anomalies, trackHistory, enrichCache]
  )

  // ── apply text filter + dimension filters ─────────────────────────────────
  const filtered = useMemo(() => {
    setPage(0) // reset to first page on filter change
    let list = flights.filter(f =>
      f.callsign.toLowerCase().includes(q) ||
      f.country.toLowerCase().includes(q) ||
      f.icao.toLowerCase().includes(q) ||
      (f.acOperator || '').toLowerCase().includes(q) ||
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
        va = a.vertRate ?? null
        vb = b.vertRate ?? null
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

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const displayed = showAll ? sorted : sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const handleSort = key => {
    if (sortKey === key) setSortDir(d => d * -1)
    else { setSortKey(key); setSortDir(1) }
  }

  if (!flights.length) {
    return (
      <div className="flex flex-col bg-bg flex-1 min-h-0">
        <div className="flex justify-between items-center py-0.5 px-2.5 bg-bg2 border-b border-border text-[11px] text-fg3 shrink-0">
          <span className="flex items-center gap-1.5">
            <span className="ft-chip ft-chip--muted">flight records</span>
            <span className="text-fg2">0</span> records
          </span>
          <AircraftSearchBox
            filter={filter}
            onFilterChange={onFilterChange}
            className="ml-2 flex-1 max-w-xl"
          />
          <button
            className={clsx(
              'h-5 px-1.5 border text-[9px] uppercase transition-colors',
              isSyncing ? 'border-ylw/45 text-ylw cursor-wait' : 'border-border text-fg3 hover:text-fg2 hover:border-border2'
            )}
            onClick={onSync}
            disabled={isSyncing}
            title="refresh flight records now"
          >
            {isSyncing ? 'syncing' : 'sync'}
          </button>
        </div>
        <div className="p-8 flex flex-col items-center justify-center gap-2 text-center text-fg3">
          <Loading label={isSyncing ? 'syncing' : 'awaiting first poll'} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col bg-bg flex-1 min-h-0">
      {/* Filter bar */}
      <FilterBar
        filters={filters}
        onChange={setFilters}
        counts={filterCounts}
        totalFiltered={filtered.length}
        totalFlights={flights.length}
      />

      <div className="shrink-0 bg-bg2 border-b border-border text-[10px] sm:text-[11px] text-fg3">
        {/* Row 1: records, pagination, sort */}
        <div className="flex flex-wrap items-center py-0.5 px-1.5 sm:px-2.5 gap-1.5">
          <span className="flex items-center gap-1.5 sm:gap-2 min-w-0 shrink-0">
            <span className="ft-chip ft-chip--muted">flight records</span>
            <span className="flex items-baseline gap-1">
              <span className="text-fg tabular-nums text-[13px]">{filtered.length.toLocaleString()}</span>
              <span className="text-fg3 text-[9px] uppercase tracking-wide">records</span>
            </span>
            {isFiltersActive(filters) && (
              <span className="bg-acc/15 text-acc text-[8px] uppercase px-1 py-px rounded border border-acc/30">filtered</span>
            )}
            {!showAll && totalPages > 1 && (
              <span className="flex items-center gap-0.5">
                <button
                  className="bg-transparent border border-border text-fg3 hover:text-fg2 hover:border-fg3 text-[10px] cursor-pointer px-1 py-0 font-mono rounded disabled:opacity-30 disabled:cursor-default"
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                >
                  ‹
                </button>
                <span className="text-fg3 text-[10px] tabular-nums">{safePage + 1}/{totalPages}</span>
                <button
                  className="bg-transparent border border-border text-fg3 hover:text-fg2 hover:border-fg3 text-[10px] cursor-pointer px-1 py-0 font-mono rounded disabled:opacity-30 disabled:cursor-default"
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                >
                  ›
                </button>
              </span>
            )}
            {filtered.length > PAGE_SIZE && (
              <button
                className="bg-transparent border-none text-acc text-[10px] cursor-pointer p-0 font-mono hover:underline"
                onClick={() => { setShowAll(s => !s); setPage(0) }}
              >
                {showAll ? `page (${PAGE_SIZE})` : `show all`}
              </button>
            )}
            {newIcaos.size > 0 && <span className="bg-grn/15 text-grn text-[8px] uppercase px-1 py-px rounded border border-grn/30 ml-1">+{newIcaos.size} new</span>}
          </span>
          <AircraftSearchBox
            filter={filter}
            onFilterChange={onFilterChange}
            className="order-last sm:order-none w-full sm:flex-1 sm:min-w-72"
          />
          <div className="flex gap-1 items-center w-full sm:w-auto ml-auto">
            <button
              className={clsx(
                'text-[10px] sm:text-[11px] cursor-pointer font-mono px-1.5 py-0.5 sm:py-0 border flex-1 sm:flex-none text-center uppercase',
                isSyncing
                  ? 'bg-ylw/10 border-ylw/35 text-ylw cursor-wait'
                  : 'bg-transparent border-border text-fg3 hover:text-fg2 hover:border-fg3'
              )}
              onClick={onSync}
              disabled={isSyncing}
              title="Refresh flight records now"
            >
              {isSyncing ? 'syncing' : 'sync'}
            </button>
            <button
              className={clsx(
                'text-[10px] sm:text-[11px] cursor-pointer font-mono px-1.5 py-0.5 sm:py-0 rounded border flex-1 sm:flex-none text-center',
                sortKey === 'takeoff'
                  ? 'bg-acc/15 border-acc/40 text-acc'
                  : 'bg-transparent border-border text-fg3 hover:text-fg2 hover:border-fg3'
              )}
              onClick={() => {
                if (sortKey === 'takeoff') setSortDir(d => d * -1)
                else { setSortKey('takeoff'); setSortDir(1) }
              }}
              title="Sort by takeoff proximity (ground → climb → cruise)"
            >
              {sortKey === 'takeoff' ? `takeoff ${sortDir > 0 ? '▲' : '▼'}` : 'takeoff'}
            </button>
          </div>
        </div>
        {/* Row 2: API usage */}
        {(openskyUsage || (aeroSpend && aeroSpend.source !== 'unconfigured')) && (
          <div className="flex gap-3 items-center py-0.5 px-1.5 sm:px-2.5 border-t border-white/3">
            {openskyUsage && (
              <span>
                <span className="text-acc">opensky</span>{' '}
                <span
                  className={openskyUsage.remaining < 400 ? 'text-red' : openskyUsage.remaining < 1000 ? 'text-ylw' : 'text-grn'}
                  title={`estimated remaining (${openskyUsage.remaining_source || 'db_estimate'}): db ${Math.round(openskyUsage.db_remaining ?? openskyUsage.remaining)}, header ${openskyUsage.header_remaining ?? 'n/a'}`}
                >
                  {Math.round(openskyUsage.remaining).toLocaleString()}
                </span>
                <span className="text-fg2">/{openskyUsage.daily_limit.toLocaleString()}</span>
              </span>
            )}
            {aeroSpend && aeroSpend.source !== 'unconfigured' && (
              <span>
                <span className="text-mag">aero</span>{' '}
                <span className={aeroSpend.cap_reached ? 'text-red' : aeroSpend.cap_remaining < 1 ? 'text-ylw' : 'text-grn'}>
                  ${aeroSpend.cap_remaining.toFixed(2)}
                </span>
                <span className="text-fg2">/${aeroSpend.cap.toFixed(2)}</span>
                {aeroSpend.cap_reached && <span className="text-red ml-1">CAP</span>}
              </span>
            )}
          </div>
        )}
      </div>
      {/* ── Mobile card list (< sm) — 2-line rows with all key data ────────── */}
      <div className="overflow-auto flex-1 min-h-0 sm:hidden">
        {displayed.length === 0 && (
          <div className="text-center py-8 text-fg3 text-[11px]">
            {isFiltersActive(filters) ? 'no flights match current filters' : 'waiting for poller — first data arrives in ~45s'}
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
          const vr = f.vertRate != null ? Math.round(f.vertRate * 196.85) : (enrich?.adsbfi?.baroRate ?? null)
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
                'px-2 py-1 border-b cursor-pointer active:bg-bg2',
                anomaly
                  ? 'bg-red/8 border-b-red/20 border-l-2 border-l-red'
                  : isNew
                    ? 'animate-row-arrive border-white/3'
                    : isSel
                      ? 'bg-acc/8 border-l-2 border-l-acc border-white/3'
                      : 'border-white/3'
              )}
              onClick={() => onSelect(f)}
            >
              {/* Single-line dense row: callsign type route | alt spd v/r phase */}
              <div className="flex items-baseline gap-1 text-[9px] tabular-nums">
                {anomaly && <span className="text-red">{anomaly.confirmed ? '!!' : '!'}</span>}
                <span className="text-ylw text-[10px]">{f.callsign}</span>
                {f.mil && <span className="text-red text-[7px]">mil</span>}
                {acType && <span className="text-fg3">{acType}</span>}
                {route && <span className="text-fg3/60">{route}</span>}
                {squawkLabel(f.squawk) && <span className={clsx('text-[7px]', squawkColor(f.squawk))}>{squawkLabel(f.squawk)}</span>}
                <span className="flex-1" />
                <span className={f.grounded ? 'text-ylw' : 'text-cyn'}>{altFt != null ? altFt.toLocaleString() : ''}</span>
                <span className="text-fg2">{spdKt ?? ''}</span>
                {vr != null && <span className={clsx(Math.abs(vr) > 2000 ? 'text-ylw' : vr > 0 ? 'text-grn' : vr < 0 ? 'text-cyn' : 'text-fg3')}>{vr > 0 ? '+' : ''}{vr}</span>}
                <span className={clsx('font-bold', PHASE_COLOR[phase])}>{PHASE_LABEL[phase]}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Desktop table (≥ sm) — standard 8-column layout ──────────────── */}
      <div className="overflow-auto flex-1 min-h-0 hidden sm:block">
      <table className="w-full border-separate border-spacing-0">
        <thead className="sticky top-0 z-1">
          <tr>
            {COLS.map(col => {
              const isActive = sortKey === col.key
              return (
                <th
                  key={col.key}
                  className={clsx(
                    'group py-0.5 px-2.5 text-left font-normal text-[11px] cursor-pointer select-none whitespace-nowrap font-mono bg-bg2 border-b border-border',
                    isActive ? 'text-acc' : 'text-fg3 hover:text-fg2'
                  )}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  {isActive ? (
                    <span className="ml-1 text-[9px]">{sortDir > 0 ? '▲' : '▼'}</span>
                  ) : (
                    <span className="ml-1 text-[9px] opacity-0 group-hover:opacity-40">▲</span>
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {displayed.length === 0 && (
            <tr>
              <td colSpan={COLS.length} className="text-center py-8 text-fg3 text-[11px]">
                {isFiltersActive(filters)
                  ? 'no flights match current filters'
                  : 'waiting for poller — first data arrives in ~45s'}
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
            const vr = f.vertRate != null ? Math.round(f.vertRate * 196.85) : (enrich?.adsbfi?.baroRate ?? null)
            const cat = f.category || enrich?.adsbfi?.category || enrich?.apl?.category || null
            return (
              <tr
                key={f.icao + f.callsign}
                className={clsx(
                  'border-b cursor-pointer',
                  anomaly
                    ? 'bg-red/8 border-b-red/20 border-l-2 border-l-red'
                    : trackedIcaos?.has(f.icao)
                      ? 'border-l border-l-ylw/30 border-white/3'
                      : isNew
                        ? 'animate-row-arrive border-white/3'
                        : isSel
                          ? 'bg-acc/8 border-l-2 border-l-acc border-white/3'
                          : 'hover:bg-bg2 border-white/3'
                )}
                onClick={() => onSelect(f)}
              >
                <td className="py-0.5 px-2.5 whitespace-nowrap text-xs text-fg3 tabular-nums">
                  {onToggleTrack && (
                    <span
                      className={clsx(
                        'mr-1.5 cursor-pointer inline-block text-[10px] tracking-tight',
                        trackedIcaos?.has(f.icao) ? 'text-ylw' : 'text-fg3/15 hover:text-fg3/40'
                      )}
                      title={trackedIcaos?.has(f.icao) ? 'Untrack from map' : 'Track on map'}
                      onClick={(e) => { e.stopPropagation(); onToggleTrack(f.icao) }}
                    >
                      {trackedIcaos?.has(f.icao) ? '\u25CF' : '\u00b7'}
                    </span>
                  )}
                  {anomaly && (
                    <span
                      className="mr-1 text-red"
                      title={`[${anomaly.score}] ${anomaly.phase} — ${anomaly.reasons.join('; ')}`}
                    >
                      {anomaly.confirmed ? '!!' : '!'}
                    </span>
                  )}
                  {f.icao}
                  {squawkLabel(f.squawk) && (
                    <span className={clsx('ml-1 text-[9px]', squawkColor(f.squawk))} title={`squawk ${f.squawk}`}>
                      {squawkLabel(f.squawk)}
                    </span>
                  )}
                </td>
                <td
                  className="py-0.5 px-2.5 whitespace-nowrap text-xs text-ylw"
                  title={[f.acOperator, acReg, f.country].filter(Boolean).join(' · ')}
                >
                  {f.callsign}
                  {f.mil && <span className="text-red text-[9px] ml-1">[mil]</span>}
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
                          {new Date(f.tfms.eta).toISOString().substring(11, 16)}z
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
                  ) : null}
                </td>
                <td className={clsx('py-0.5 px-2.5 whitespace-nowrap text-xs tabular-nums', f.grounded ? 'text-ylw' : 'text-cyn')}>
                  {f.alt != null ? Math.round(f.alt * 3.281).toLocaleString() : ''}
                </td>
                <td className="py-0.5 px-2.5 whitespace-nowrap text-xs text-fg2 tabular-nums">
                  {f.vel != null ? Math.round(f.vel * 1.944) : ''}
                </td>
                <td className={clsx('py-0.5 px-2.5 whitespace-nowrap text-xs tabular-nums',
                  vr == null ? 'text-fg3/40' : Math.abs(vr) > 2000 ? 'text-ylw' : vr > 0 ? 'text-grn' : vr < 0 ? 'text-cyn' : 'text-fg3'
                )}>
                  {vr != null ? `${vr > 0 ? '+' : ''}${vr}` : ''}
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
