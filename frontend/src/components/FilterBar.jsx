import { useState, useMemo } from 'react'
import clsx from 'clsx'

// ── Filter dimension definitions ────────────────────────────────────────────

export const FILTER_DIMS = {
  phase: {
    label: 'Phase',
    options: [
      { id: 'ground',   label: 'GND',     color: 'text-fg3' },
      { id: 'climb',    label: 'CLB',      color: 'text-grn' },
      { id: 'cruise',   label: 'CRZ',      color: 'text-cyn' },
      { id: 'descent',  label: 'DES',      color: 'text-ylw' },
      { id: 'approach', label: 'APR',      color: 'text-mag' },
    ],
  },
  altBand: {
    label: 'Alt Band',
    options: [
      { id: 'ground',   label: 'GND',      color: 'text-fg3',  desc: 'On ground' },
      { id: 'low',      label: '<5K',       color: 'text-grn',  desc: 'Below 5,000ft' },
      { id: 'terminal', label: '5K-18K',    color: 'text-cyn',  desc: '5,000-18,000ft' },
      { id: 'enroute',  label: 'FL180-410', color: 'text-ylw',  desc: 'FL180-FL410' },
      { id: 'high',     label: '>FL410',    color: 'text-mag',  desc: 'Above FL410' },
    ],
  },
  speed: {
    label: 'Speed',
    options: [
      { id: 'taxi',   label: '<30kt',    color: 'text-fg3',  desc: 'Taxi' },
      { id: 'slow',   label: '30-100',   color: 'text-grn',  desc: 'Slow' },
      { id: 'normal', label: '100-300',  color: 'text-cyn',  desc: 'Normal' },
      { id: 'fast',   label: '>300kt',   color: 'text-ylw',  desc: 'Fast' },
    ],
  },
  vrate: {
    label: 'V/Rate',
    options: [
      { id: 'climbing',   label: 'CLB',     color: 'text-grn',  desc: '>500 fpm' },
      { id: 'level',      label: 'LVL',     color: 'text-fg3',  desc: '±500 fpm' },
      { id: 'descending', label: 'DES',     color: 'text-cyn',  desc: '<-500 fpm' },
      { id: 'rapid',      label: 'RAPID',   color: 'text-red',  desc: '>2000 fpm' },
    ],
  },
  acClass: {
    label: 'Class',
    options: [
      { id: 'light',   label: 'Light',   color: 'text-fg3',  desc: 'A1 <15,500lb' },
      { id: 'small',   label: 'Small',   color: 'text-cyn',  desc: 'A2 15K-75K lb' },
      { id: 'large',   label: 'Large',   color: 'text-ylw',  desc: 'A3 75K-300K lb' },
      { id: 'b757',    label: 'B757',    color: 'text-ylw',  desc: 'A4 High-vortex' },
      { id: 'heavy',   label: 'Heavy',   color: 'text-mag',  desc: 'A5 >300,000lb' },
      { id: 'hiperf',  label: 'HiPerf',  color: 'text-red',  desc: 'A6 >5g / >400kt' },
      { id: 'rotor',   label: 'Rotor',   color: 'text-grn',  desc: 'A7 Rotorcraft' },
    ],
  },
  status: {
    label: 'Status',
    options: [
      { id: 'emergency',  label: 'EMER',     color: 'text-red',  desc: '7700/7500/7600' },
      { id: 'anomaly',    label: 'ANOM',     color: 'text-red',  desc: 'Anomaly detected' },
      { id: 'diversion',  label: 'DVRN',     color: 'text-ylw',  desc: 'Off-route >50km' },
      { id: 'airborne',   label: 'AIR',      color: 'text-grn',  desc: 'In flight' },
      { id: 'grounded',   label: 'GND',      color: 'text-fg3',  desc: 'On ground' },
      { id: 'mil',        label: 'MIL',      color: 'text-red',  desc: 'Military' },
    ],
  },
  data: {
    label: 'Data',
    options: [
      { id: 'tfms',     label: 'TFMS',     color: 'text-cyn',  desc: 'Has flight plan' },
      { id: 'route',    label: 'Route',    color: 'text-grn',  desc: 'Has route info' },
      { id: 'enriched', label: 'Enrich',   color: 'text-mag',  desc: 'Has aircraft data' },
    ],
  },
}

// ── Smart presets (compound filters) ─────────────────────────────────────────

export const PRESETS = [
  { id: 'emergencies', label: 'Emergencies', color: 'text-red',  icon: '!',  desc: 'Emergency squawk or critical anomaly' },
  { id: 'anomalies',   label: 'Anomalies',   color: 'text-red',  icon: '!',  desc: 'All detected anomalies' },
  { id: 'military',    label: 'Military',     color: 'text-red',  icon: 'M',  desc: 'Military aircraft' },
  { id: 'heavymetal',  label: 'Heavy',        color: 'text-mag',  icon: 'H',  desc: 'Large/heavy/B757 aircraft' },
  { id: 'diversions',  label: 'Diversions',   color: 'text-ylw',  icon: 'D',  desc: 'Route deviation >50km' },
  { id: 'approach',    label: 'Approach',     color: 'text-mag',  icon: 'A',  desc: 'On approach or descent' },
  { id: 'groundops',   label: 'Ground',       color: 'text-fg3',  icon: 'G',  desc: 'Aircraft on ground' },
  { id: 'vfr',         label: 'VFR',          color: 'text-cyn',  icon: 'V',  desc: 'Squawk 1200 VFR traffic' },
]

// ── Empty filter state ───────────────────────────────────────────────────────

export function emptyFilters() {
  return {
    phase: [],
    altBand: [],
    speed: [],
    vrate: [],
    acClass: [],
    status: [],
    data: [],
    airport: '',        // ICAO code for dep OR arr
    preset: null,       // active preset ID (clears dimension filters)
  }
}

export function isFiltersActive(filters) {
  if (filters.preset) return true
  if (filters.airport) return true
  for (const dim of Object.keys(FILTER_DIMS)) {
    if (filters[dim]?.length > 0) return true
  }
  return false
}

// ── Category mapping from ADS-B emitter category ─────────────────────────────

function classifyAircraft(f, enrichCache) {
  // Try the emitter category from enrichment or flight data
  const cat = f.category || enrichCache[f.icao]?.adsbfi?.category || enrichCache[f.icao]?.apl?.category || null
  if (!cat) return null
  const c = String(cat).toUpperCase()
  if (c === 'A1') return 'light'
  if (c === 'A2') return 'small'
  if (c === 'A3') return 'large'
  if (c === 'A4') return 'b757'
  if (c === 'A5') return 'heavy'
  if (c === 'A6') return 'hiperf'
  if (c === 'A7') return 'rotor'
  return null
}

// ── Altitude band classification ──────────────────────────────────────────────

function altBand(f) {
  if (f.grounded) return 'ground'
  if (f.alt == null) return null
  const ft = f.alt * 3.281 // m → ft
  if (ft < 5000) return 'low'
  if (ft < 18000) return 'terminal'
  if (ft <= 41000) return 'enroute'
  return 'high'
}

// ── Speed band classification ─────────────────────────────────────────────────

function speedBand(f) {
  if (f.vel == null) return null
  const kt = f.vel * 1.944 // m/s → knots
  if (kt < 30) return 'taxi'
  if (kt < 100) return 'slow'
  if (kt <= 300) return 'normal'
  return 'fast'
}

// ── Vertical rate classification ──────────────────────────────────────────────

function vrateBand(f) {
  const vr = f.vertRate != null ? f.vertRate * 196.85 : null // m/s → ft/min
  if (vr == null) return null
  if (Math.abs(vr) > 2000) return 'rapid'
  if (vr > 500) return 'climbing'
  if (vr < -500) return 'descending'
  return 'level'
}

// ── Apply all filters to a flight ────────────────────────────────────────────

export function applyFilters(f, filters, { anomalies, trackHistory, enrichCache, detectPhase, PHASE }) {
  // Preset filters (compound)
  if (filters.preset) {
    return applyPreset(f, filters.preset, { anomalies, trackHistory, enrichCache, detectPhase, PHASE })
  }

  // Dimension filters (AND across dimensions, OR within dimension)

  // Phase
  if (filters.phase.length > 0) {
    const hist = trackHistory[f.icao]
    const phase = hist?.length >= 2 ? detectPhase(hist) : (f.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
    if (!filters.phase.includes(phase)) return false
  }

  // Altitude band
  if (filters.altBand.length > 0) {
    const band = altBand(f)
    if (!band || !filters.altBand.includes(band)) return false
  }

  // Speed band
  if (filters.speed.length > 0) {
    const band = speedBand(f)
    if (!band || !filters.speed.includes(band)) return false
  }

  // Vertical rate
  if (filters.vrate.length > 0) {
    const band = vrateBand(f)
    if (!band || !filters.vrate.includes(band)) return false
  }

  // Aircraft class
  if (filters.acClass.length > 0) {
    const cls = classifyAircraft(f, enrichCache)
    if (!cls || !filters.acClass.includes(cls)) return false
  }

  // Status
  if (filters.status.length > 0) {
    const match = filters.status.some(s => {
      switch (s) {
        case 'emergency': return f.squawk === '7700' || f.squawk === '7500' || f.squawk === '7600'
        case 'anomaly':   return !!anomalies[f.icao]
        case 'diversion': return (f.routeDeviation || 0) > 50
        case 'airborne':  return !f.grounded
        case 'grounded':  return !!f.grounded
        case 'mil':       return !!f.mil
        default: return false
      }
    })
    if (!match) return false
  }

  // Data availability
  if (filters.data.length > 0) {
    const match = filters.data.every(d => {
      switch (d) {
        case 'tfms':     return !!f.tfms
        case 'route':    return !!(f.tfms?.dep_arpt || enrichCache[f.icao]?.flightroute)
        case 'enriched': return !!(enrichCache[f.icao]?.adsbfi || enrichCache[f.icao]?.aircraft || f.acType)
        default: return false
      }
    })
    if (!match) return false
  }

  // Airport (matches dep or arr)
  if (filters.airport) {
    const q = filters.airport.toUpperCase()
    const dep = (f.tfms?.dep_arpt || '').toUpperCase()
    const arr = (f.tfms?.arr_arpt || '').toUpperCase()
    const enrichDep = (enrichCache[f.icao]?.flightroute?.origin?.icao_code || '').toUpperCase()
    const enrichArr = (enrichCache[f.icao]?.flightroute?.destination?.icao_code || '').toUpperCase()
    if (!dep.includes(q) && !arr.includes(q) && !enrichDep.includes(q) && !enrichArr.includes(q)) return false
  }

  return true
}

// ── Preset filter logic ──────────────────────────────────────────────────────

function applyPreset(f, preset, { anomalies, trackHistory, enrichCache, detectPhase, PHASE }) {
  switch (preset) {
    case 'emergencies':
      return f.squawk === '7700' || f.squawk === '7500' || f.squawk === '7600' ||
        anomalies[f.icao]?.severity === 'CRITICAL'
    case 'anomalies':
      return !!anomalies[f.icao]
    case 'military':
      return !!f.mil
    case 'heavymetal':
      return ['large', 'b757', 'heavy'].includes(classifyAircraft(f, enrichCache))
    case 'diversions':
      return (f.routeDeviation || 0) > 50 || anomalies[f.icao]?.category === 'DIVERSION'
    case 'approach': {
      const hist = trackHistory[f.icao]
      const phase = hist?.length >= 2 ? detectPhase(hist) : (f.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
      return phase === PHASE.APPROACH || phase === PHASE.DESCENT
    }
    case 'groundops':
      return !!f.grounded
    case 'vfr':
      return f.squawk === '1200'
    default:
      return true
  }
}

// ── Count flights matching each filter option (for badges) ───────────────────

export function computeFilterCounts(flights, { anomalies, trackHistory, enrichCache, detectPhase, PHASE }) {
  const counts = {
    phase: {}, altBand: {}, speed: {}, vrate: {}, acClass: {}, status: {}, data: {},
    presets: {},
  }

  for (const f of flights) {
    // Phase
    const hist = trackHistory[f.icao]
    const phase = hist?.length >= 2 ? detectPhase(hist) : (f.grounded ? PHASE.GROUND : PHASE.UNKNOWN)
    counts.phase[phase] = (counts.phase[phase] || 0) + 1

    // Alt band
    const ab = altBand(f)
    if (ab) counts.altBand[ab] = (counts.altBand[ab] || 0) + 1

    // Speed band
    const sb = speedBand(f)
    if (sb) counts.speed[sb] = (counts.speed[sb] || 0) + 1

    // Vrate band
    const vb = vrateBand(f)
    if (vb) counts.vrate[vb] = (counts.vrate[vb] || 0) + 1

    // Aircraft class
    const cls = classifyAircraft(f, enrichCache)
    if (cls) counts.acClass[cls] = (counts.acClass[cls] || 0) + 1

    // Status (multi-match)
    if (f.squawk === '7700' || f.squawk === '7500' || f.squawk === '7600') counts.status.emergency = (counts.status.emergency || 0) + 1
    if (anomalies[f.icao]) counts.status.anomaly = (counts.status.anomaly || 0) + 1
    if ((f.routeDeviation || 0) > 50) counts.status.diversion = (counts.status.diversion || 0) + 1
    if (!f.grounded) counts.status.airborne = (counts.status.airborne || 0) + 1
    if (f.grounded) counts.status.grounded = (counts.status.grounded || 0) + 1
    if (f.mil) counts.status.mil = (counts.status.mil || 0) + 1

    // Data
    if (f.tfms) counts.data.tfms = (counts.data.tfms || 0) + 1
    if (f.tfms?.dep_arpt || enrichCache[f.icao]?.flightroute) counts.data.route = (counts.data.route || 0) + 1
    if (enrichCache[f.icao]?.adsbfi || enrichCache[f.icao]?.aircraft || f.acType) counts.data.enriched = (counts.data.enriched || 0) + 1

    // Presets
    if (f.squawk === '7700' || f.squawk === '7500' || f.squawk === '7600' || anomalies[f.icao]?.severity === 'CRITICAL')
      counts.presets.emergencies = (counts.presets.emergencies || 0) + 1
    if (anomalies[f.icao]) counts.presets.anomalies = (counts.presets.anomalies || 0) + 1
    if (f.mil) counts.presets.military = (counts.presets.military || 0) + 1
    if (['large', 'b757', 'heavy'].includes(cls)) counts.presets.heavymetal = (counts.presets.heavymetal || 0) + 1
    if ((f.routeDeviation || 0) > 50 || anomalies[f.icao]?.category === 'DIVERSION') counts.presets.diversions = (counts.presets.diversions || 0) + 1
    if (phase === PHASE.APPROACH || phase === PHASE.DESCENT) counts.presets.approach = (counts.presets.approach || 0) + 1
    if (f.grounded) counts.presets.groundops = (counts.presets.groundops || 0) + 1
    if (f.squawk === '1200') counts.presets.vfr = (counts.presets.vfr || 0) + 1
  }

  return counts
}

// ── FilterBar component ──────────────────────────────────────────────────────

function FilterPill({ label, count, active, color, onClick, title }) {
  return (
    <button
      className={clsx(
        'text-[9px] cursor-pointer font-mono px-1.5 py-0 rounded border whitespace-nowrap transition-colors',
        active
          ? `bg-white/8 border-current ${color}`
          : count > 0
            ? `bg-transparent border-border ${color} opacity-60 hover:opacity-100`
            : 'bg-transparent border-border text-fg3/40 cursor-default'
      )}
      onClick={count > 0 || active ? onClick : undefined}
      title={title}
    >
      {label}{count != null ? ` ${count}` : ''}
    </button>
  )
}

export default function FilterBar({ filters, onChange, counts, totalFiltered, totalFlights }) {
  const [expanded, setExpanded] = useState(false)
  const active = isFiltersActive(filters)

  const toggleDim = (dim, id) => {
    const prev = filters[dim] || []
    const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    onChange({ ...filters, [dim]: next, preset: null })
  }

  const setPreset = (id) => {
    if (filters.preset === id) {
      onChange(emptyFilters())
    } else {
      onChange({ ...emptyFilters(), preset: id })
    }
  }

  const clearAll = () => onChange(emptyFilters())

  return (
    <div className="bg-bg border-b border-border text-[10px]">
      {/* Toggle row */}
      <div className="flex items-center gap-1 px-1.5 sm:px-2.5 py-0.5">
        <button
          className={clsx(
            'text-[10px] cursor-pointer font-mono px-1.5 py-0 rounded border',
            expanded
              ? 'bg-acc/10 border-acc/40 text-acc'
              : active
                ? 'bg-acc/10 border-acc/40 text-acc'
                : 'bg-transparent border-border text-fg3 hover:text-fg2'
          )}
          onClick={() => setExpanded(e => !e)}
        >
          filters {active ? `(${totalFiltered}/${totalFlights})` : ''}
          <span className="ml-1 text-[8px]">{expanded ? '▲' : '▼'}</span>
        </button>

        {/* Quick presets — always visible */}
        <div className="flex gap-0.5 items-center overflow-x-auto no-scrollbar flex-1">
          {PRESETS.map(p => (
            <FilterPill
              key={p.id}
              label={p.label}
              count={counts.presets?.[p.id] || 0}
              active={filters.preset === p.id}
              color={p.color}
              onClick={() => setPreset(p.id)}
              title={p.desc}
            />
          ))}
        </div>

        {active && (
          <button
            className="text-[9px] text-red cursor-pointer font-mono px-1 py-0 border border-red/30 rounded hover:bg-red/10"
            onClick={clearAll}
          >
            clear
          </button>
        )}
      </div>

      {/* Expanded filter dimensions */}
      {expanded && (
        <div className="px-1.5 sm:px-2.5 pb-1.5 space-y-1 border-t border-white/3 pt-1">
          {Object.entries(FILTER_DIMS).map(([dim, def]) => (
            <div key={dim} className="flex items-center gap-1">
              <span className="text-fg3 text-[9px] w-12 shrink-0 text-right">{def.label}</span>
              <div className="flex gap-0.5 flex-wrap">
                {def.options.map(opt => (
                  <FilterPill
                    key={opt.id}
                    label={opt.label}
                    count={counts[dim]?.[opt.id] || 0}
                    active={(filters[dim] || []).includes(opt.id)}
                    color={opt.color}
                    onClick={() => toggleDim(dim, opt.id)}
                    title={opt.desc || opt.label}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Airport filter */}
          <div className="flex items-center gap-1">
            <span className="text-fg3 text-[9px] w-12 shrink-0 text-right">Airport</span>
            <input
              className="bg-bg2 border border-border text-fg text-[10px] font-mono px-1.5 py-0 rounded w-20 outline-none focus:border-acc/50"
              value={filters.airport}
              onChange={e => onChange({ ...filters, airport: e.target.value, preset: null })}
              placeholder="KJFK"
              maxLength={4}
            />
            {filters.airport && (
              <span className="text-fg3 text-[9px]">dep or arr</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
