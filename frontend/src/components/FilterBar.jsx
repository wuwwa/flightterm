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
  // ── Group dimensions (v5.7) ────────────────────────────────────────────────
  // Chip id is the full group tag so applyFilters() just does an .includes().
  airline: {
    label: 'Airline',
    options: [
      { id: 'airline:ual', label: 'UAL',  color: 'text-cyn',  desc: 'United Airlines' },
      { id: 'airline:dal', label: 'DAL',  color: 'text-cyn',  desc: 'Delta Air Lines' },
      { id: 'airline:aal', label: 'AAL',  color: 'text-cyn',  desc: 'American Airlines' },
      { id: 'airline:swa', label: 'SWA',  color: 'text-cyn',  desc: 'Southwest Airlines' },
      { id: 'airline:jbu', label: 'JBU',  color: 'text-cyn',  desc: 'JetBlue Airways' },
      { id: 'airline:asa', label: 'ASA',  color: 'text-cyn',  desc: 'Alaska Airlines' },
      { id: 'airline:nks', label: 'NKS',  color: 'text-cyn',  desc: 'Spirit Airlines' },
      { id: 'airline:fft', label: 'FFT',  color: 'text-cyn',  desc: 'Frontier Airlines' },
      { id: 'airline:fdx', label: 'FDX',  color: 'text-grn',  desc: 'FedEx Express' },
      { id: 'airline:ups', label: 'UPS',  color: 'text-grn',  desc: 'UPS Airlines' },
      { id: 'airline:atn', label: 'ATN',  color: 'text-grn',  desc: 'Atlas Air Transport Intl' },
      { id: 'airline:eja', label: 'EJA',  color: 'text-mag',  desc: 'NetJets' },
    ],
  },
  family: {
    label: 'Aircraft',
    options: [
      { id: 'family:b737',    label: 'B737',    color: 'text-cyn',  desc: 'Boeing 737 family' },
      { id: 'family:a320',    label: 'A320',    color: 'text-cyn',  desc: 'Airbus A320 family' },
      { id: 'family:b777',    label: 'B777',    color: 'text-ylw',  desc: 'Boeing 777' },
      { id: 'family:b787',    label: 'B787',    color: 'text-ylw',  desc: 'Boeing 787' },
      { id: 'family:a330',    label: 'A330',    color: 'text-ylw',  desc: 'Airbus A330' },
      { id: 'family:b747',    label: 'B747',    color: 'text-mag',  desc: 'Boeing 747' },
      { id: 'family:e-jet',   label: 'E-jet',   color: 'text-grn',  desc: 'Embraer regional' },
      { id: 'family:crj',     label: 'CRJ',     color: 'text-grn',  desc: 'Bombardier CRJ' },
      { id: 'class:widebody', label: 'Wide',    color: 'text-mag',  desc: 'All widebodies' },
      { id: 'class:bizjet',   label: 'BizJet',  color: 'text-mag',  desc: 'Business jets' },
      { id: 'class:helo',     label: 'Helo',    color: 'text-grn',  desc: 'Helicopters' },
      { id: 'role:cargo',     label: 'Cargo',   color: 'text-grn',  desc: 'Dedicated freighters' },
    ],
  },
  agency: {
    label: 'Agency',
    options: [
      { id: 'gov:military',     label: 'MIL',    color: 'text-red',  desc: 'Any military flag' },
      { id: 'gov:usaf',         label: 'USAF',   color: 'text-red',  desc: 'US Air Force' },
      { id: 'gov:usn',          label: 'Navy',   color: 'text-red',  desc: 'US Navy' },
      { id: 'gov:usmc',         label: 'USMC',   color: 'text-red',  desc: 'US Marines' },
      { id: 'gov:uscg',         label: 'USCG',   color: 'text-cyn',  desc: 'Coast Guard' },
      { id: 'gov:cbp',          label: 'CBP',    color: 'text-ylw',  desc: 'Customs & Border' },
      { id: 'gov:police',       label: 'Police', color: 'text-ylw',  desc: 'State/local LE' },
      { id: 'gov:firefighting', label: 'Fire',   color: 'text-mag',  desc: 'Firefighting' },
    ],
  },
  // v5.7 — FAA registry entity types. Populated by nightly MASTER.txt ingest
  // (see backend/scripts/ingest-faa-registry.js). US-registered aircraft only;
  // counts stay at 0 until the first ingest has run against the local DB.
  entity: {
    label: 'Entity',
    options: [
      { id: 'entity:individual',  label: 'Indiv',   color: 'text-fg3',  desc: 'Individual owner (FAA type 1)' },
      { id: 'entity:corp',        label: 'Corp',    color: 'text-cyn',  desc: 'Corporation (FAA type 3)' },
      { id: 'entity:llc',         label: 'LLC',     color: 'text-ylw',  desc: 'Limited Liability Co (FAA type 7)' },
      { id: 'entity:government',  label: 'Govt',    color: 'text-red',  desc: 'Government (FAA type 5)' },
      { id: 'entity:trust',       label: 'Trust',   color: 'text-mag',  desc: 'Owner name contains TRUST / TRUSTEE' },
      { id: 'entity:noncitizen',  label: 'NonUS',   color: 'text-grn',  desc: 'Non-Citizen Corp (FAA types 8/9)' },
    ],
  },
}

// ── Smart presets (compound filters) ─────────────────────────────────────────

export const PRESETS = [
  { id: 'emergencies', label: 'Emergencies', color: 'text-red',  icon: '!',  desc: 'Emergency squawk or critical anomaly' },
  { id: 'anomalies',   label: 'Anomalies',   color: 'text-red',  icon: '!',  desc: 'All detected anomalies' },
  { id: 'military',    label: 'Military',     color: 'text-mag',  icon: 'M',  desc: 'Military aircraft' },
  { id: 'heavymetal',  label: 'Heavy',        color: 'text-mag',  icon: 'H',  desc: 'Large/heavy/B757 aircraft' },
  { id: 'diversions',  label: 'Diversions',   color: 'text-ylw',  icon: 'D',  desc: 'Route deviation >50km' },
  { id: 'approach',    label: 'Approach',     color: 'text-mag',  icon: 'A',  desc: 'On approach or descent' },
  { id: 'groundops',   label: 'Ground',       color: 'text-fg3',  icon: 'G',  desc: 'Aircraft on ground' },
  { id: 'vfr',         label: 'VFR',          color: 'text-cyn',  icon: 'V',  desc: 'Squawk 1200 VFR traffic' },
  // v5.7 — group-based presets (compound across airlines/families).
  { id: 'majors',      label: 'Majors',       color: 'text-cyn',  icon: 'M',  desc: 'UA/DL/AA/WN/B6/AS mainline' },
  { id: 'cargo',       label: 'Cargo',        color: 'text-grn',  icon: 'C',  desc: 'FedEx/UPS/Atlas/Kalitta/ABX' },
]

// ── Preset-to-group-tags mapping (used by applyPreset + counts) ──────────────
const PRESET_GROUPS = {
  majors: ['airline:ual', 'airline:dal', 'airline:aal', 'airline:swa', 'airline:jbu', 'airline:asa'],
  cargo:  ['airline:fdx', 'airline:ups', 'airline:atn', 'airline:cks', 'airline:abx', 'airline:gti'],
}

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
    // v5.7 group dimensions
    airline: [],
    family: [],
    agency: [],
    entity: [],
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

  // v5.7 group dimensions — each chip id IS the full group tag. OR within
  // dim, AND across dims (handled by each block returning false on mismatch).
  const groups = f.groups
  if (filters.airline.length > 0) {
    if (!groups || !filters.airline.some(t => groups.includes(t))) return false
  }
  if (filters.family.length > 0) {
    if (!groups || !filters.family.some(t => groups.includes(t))) return false
  }
  if (filters.agency.length > 0) {
    if (!groups || !filters.agency.some(t => groups.includes(t))) return false
  }
  if (filters.entity.length > 0) {
    if (!groups || !filters.entity.some(t => groups.includes(t))) return false
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
    case 'majors':
    case 'cargo': {
      const tags = PRESET_GROUPS[preset]
      return Array.isArray(f.groups) && tags.some(t => f.groups.includes(t))
    }
    default:
      return true
  }
}

// ── Count flights matching each filter option (for badges) ───────────────────

export function computeFilterCounts(flights, { anomalies, trackHistory, enrichCache, detectPhase, PHASE }) {
  const counts = {
    phase: {}, altBand: {}, speed: {}, vrate: {}, acClass: {}, status: {}, data: {},
    airline: {}, family: {}, agency: {}, entity: {},
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

    // v5.7 — tally chip counts by direct group-tag match.
    if (Array.isArray(f.groups)) {
      for (const tag of f.groups) {
        if (tag.startsWith('airline:')) counts.airline[tag] = (counts.airline[tag] || 0) + 1
        else if (tag.startsWith('family:') || tag.startsWith('class:') || tag.startsWith('role:')) {
          counts.family[tag] = (counts.family[tag] || 0) + 1
        } else if (tag.startsWith('gov:')) counts.agency[tag] = (counts.agency[tag] || 0) + 1
        else if (tag.startsWith('entity:')) counts.entity[tag] = (counts.entity[tag] || 0) + 1
      }
      // Preset compounds
      if (PRESET_GROUPS.majors.some(t => f.groups.includes(t))) counts.presets.majors = (counts.presets.majors || 0) + 1
      if (PRESET_GROUPS.cargo.some(t => f.groups.includes(t)))  counts.presets.cargo  = (counts.presets.cargo  || 0) + 1
    }
  }

  return counts
}

// ── FilterBar component ──────────────────────────────────────────────────────

// Active state uses a filled background tied to the pill's color so it's
// unmistakable at a glance. Inactive (but has matches) is outline-only, dim.
// Disabled (no matches) is bare gray.
const ACTIVE_BG = {
  'text-red':  'bg-red/20 border-red text-red font-bold',
  'text-ylw':  'bg-ylw/20 border-ylw text-ylw font-bold',
  'text-grn':  'bg-grn/20 border-grn text-grn font-bold',
  'text-cyn':  'bg-cyn/20 border-cyn text-cyn font-bold',
  'text-mag':  'bg-mag/20 border-mag text-mag font-bold',
  'text-acc':  'bg-acc/20 border-acc text-acc font-bold',
  'text-fg3':  'bg-fg3/15 border-fg3 text-fg2 font-bold',
}

function FilterPill({ label, count, active, color, onClick, onAuxClick, title }) {
  const handleClick = (e) => {
    if ((e.shiftKey || e.metaKey || e.ctrlKey) && onAuxClick) {
      e.preventDefault()
      onAuxClick()
      return
    }
    if (onClick) onClick()
  }
  return (
    <button
      className={clsx(
        'text-[9px] cursor-pointer font-mono px-1.5 py-0 rounded border whitespace-nowrap transition-colors',
        active
          ? (ACTIVE_BG[color] || 'bg-acc/20 border-acc text-acc font-bold')
          : count > 0
            ? `bg-transparent border-border ${color} opacity-70 hover:opacity-100 hover:border-current`
            : 'bg-transparent border-border text-fg3/30 cursor-default'
      )}
      onClick={count > 0 || active ? handleClick : undefined}
      title={title}
    >
      {label}{count != null ? ` ${count}` : ''}
    </button>
  )
}

// Groups are discoverable via shift-click; a chip id like "airline:ual" is
// already a valid /api/groups/:groupId, so we just drop it into the URL hash.
function openGroupDossier(groupId) {
  if (!groupId || !groupId.includes(':')) return
  window.location.hash = 'group=' + encodeURIComponent(groupId)
}
const GROUP_DIMS = new Set(['airline', 'family', 'agency', 'entity'])

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
                {def.options.map(opt => {
                  const isGroup = GROUP_DIMS.has(dim)
                  const baseTitle = opt.desc || opt.label
                  const title = isGroup ? `${baseTitle} — shift-click for group dossier` : baseTitle
                  return (
                    <FilterPill
                      key={opt.id}
                      label={opt.label}
                      count={counts[dim]?.[opt.id] || 0}
                      active={(filters[dim] || []).includes(opt.id)}
                      color={opt.color}
                      onClick={() => toggleDim(dim, opt.id)}
                      onAuxClick={isGroup ? () => openGroupDossier(opt.id) : undefined}
                      title={title}
                    />
                  )
                })}
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
