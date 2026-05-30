// ── Aircraft classifier (v5.7.7) ──────────────────────────────────────────
// Multi-signal classifier that returns a `{ tags, category, confidence }`
// bundle for any flight. Pulls from:
//
//   1. classifyByHex()      — backend/data/known-aircraft.json (curated)
//   2. classifyByType()     — ICAO type designator → size/use class
//   3. classifyByOperator() — regex patterns on adsbdb operator name
//   4. classifyCallsign()   — existing callsign prefix tagger
//
// Composition rules:
//   - Hex match wins (curated, highest confidence).
//   - Operator pattern is high confidence (operator name is ground-truth
//     when present).
//   - Type gives the size/use *category*, doesn't conflict with tags.
//   - Helicopter use refinement: combine helicopter type + (callsign or
//     operator) signal to upgrade `helicopter` → `helicopter_news`,
//     `helicopter_ems`, etc.
//
// All inputs are optional — function tolerates partial data and returns
// what it can infer. No throws.

const fs = require('fs')
const path = require('path')
const { categoryFor } = require('../data/aircraft-types')
const { classifyCallsign } = require('./callsign')

// ── Load curated hex list ─────────────────────────────────────────────────
let _knownAircraft = {}
try {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'known-aircraft.json'), 'utf8')
  const parsed = JSON.parse(raw)
  // Strip _meta / _imports keys; only ICAO entries remain.
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith('_')) continue
    _knownAircraft[k.toLowerCase()] = v
  }
  console.log(`aircraft classifier: loaded ${Object.keys(_knownAircraft).length} known-aircraft entries`)
} catch (err) {
  console.warn('aircraft classifier: known-aircraft.json load failed:', err.message)
}

// ── Operator-name patterns ────────────────────────────────────────────────
// Order matters — first match wins for the dominant tag, but we collect all.
// Each regex tested case-insensitively on the trimmed operator string.
const OPERATOR_PATTERNS = [
  // Charter / fractional ownership
  { re: /\b(netjets|net\s*jets)\b/i,                     tag: 'charter_fractional', confidence: 0.95 },
  { re: /\b(flexjet|flex\s*jet)\b/i,                     tag: 'charter_fractional', confidence: 0.95 },
  { re: /\b(vista\s*jet|vistajet)\b/i,                   tag: 'charter_fractional', confidence: 0.95 },
  { re: /\b(wheels\s*up|wheelsup)\b/i,                   tag: 'charter_fractional', confidence: 0.90 },
  { re: /\b(jet\s*linx|jetlinx|nicholas\s*air)\b/i,      tag: 'charter_fractional', confidence: 0.90 },
  { re: /\b(executive\s*jet)\b/i,                        tag: 'charter_fractional', confidence: 0.85 },

  // Cargo / freight
  { re: /\b(fedex|federal\s*express)\b/i,                tag: 'cargo_freighter',    confidence: 0.99 },
  { re: /\b(ups|united\s*parcel)\b/i,                    tag: 'cargo_freighter',    confidence: 0.99 },
  { re: /\b(atlas\s*air|polar\s*air)\b/i,                tag: 'cargo_freighter',    confidence: 0.95 },
  { re: /\b(dhl|ase\s*air|kalitta|amerijet|cargolux)\b/i, tag: 'cargo_freighter',   confidence: 0.95 },
  { re: /\b(air\s*transport\s*international|ati)\b/i,    tag: 'cargo_freighter',    confidence: 0.85 },
  { re: /\bamazon\s*(air|prime)\b/i,                     tag: 'cargo_freighter',    confidence: 0.95 },

  // News / media
  { re: /\b(news|broadcast|television|tv\s*station)\b/i, tag: 'news_media',         confidence: 0.85 },
  { re: /\b(helicopters?\s*inc)\b/i,                     tag: 'news_media',         confidence: 0.50 }, // common newshelo lessor
  { re: /^(WABC|WCBS|WNBC|WPIX|WNYW|KCAL|KTLA|KABC|KCBS|KNBC|KTTV|WJLA|WUSA|WTTG|WSB|WXIA|WAGA|WHDH|WCVB|WBBM|WLS|WMAQ|WGN|WTSP|WTVF|WSVN|WPLG|WFAA|KHOU|KGO|KRON|WTVT|WFTV|WFLA)\b/i,
                                                         tag: 'news_media',         confidence: 0.95 },

  // Government civil. Note: avoid bare "DOT" — it matches private operators
  // like "DOT AVIATION LLC". Require the full agency phrase or the agency
  // initialism in a clear gov context.
  { re: /\b(nasa|noaa|usgs|nws|usda)\b/i,                tag: 'government_civil',   confidence: 0.95 },
  { re: /\b(department\s*of\s*transportation|us\s*dot|federal\s*aviation)\b/i,
                                                         tag: 'government_civil',   confidence: 0.95 },
  { re: /\b(department\s*of\s*homeland|dhs)\b/i,         tag: 'government_civil',   confidence: 0.90 },
  { re: /\b(customs\s*and\s*border|cbp)\b/i,             tag: 'government_civil',   confidence: 0.95 },
  { re: /\b(fbi|drug\s*enforcement|dea\b|atf\b)\b/i,     tag: 'law_enforcement',    confidence: 0.95 },

  // Major US airlines (commercial / public)
  { re: /\b(american\s*airlines|delta\s*air|united\s*airlines|southwest\s*airlines|alaska\s*airlines|jetblue|spirit\s*airlines|frontier\s*airlines|hawaiian\s*airlines|allegiant)\b/i,
                                                         tag: 'airline_commercial', confidence: 0.99 },
  { re: /\b(envoy\s*air|skywest|republic\s*airways|psa\s*airlines|piedmont\s*airlines|mesa\s*airlines|gojet|endeavor\s*air|horizon\s*air)\b/i,
                                                         tag: 'airline_regional',   confidence: 0.95 },

  // EMS helicopter operators
  { re: /\b(life\s*flight|life\s*line|airmed|air\s*evac|med\s*flight|medical\s*center|hospital|metro\s*aviation|airbus\s*emergency|ems\b)\b/i,
                                                         tag: 'helicopter_ems',     confidence: 0.85 },

  // Police / sheriff helicopters by operator
  { re: /\b(sheriff|police\s*department|highway\s*patrol|state\s*patrol|department\s*of\s*public\s*safety|dps)\b/i,
                                                         tag: 'law_enforcement',    confidence: 0.85 },

  // Offshore / oil & gas helicopters
  { re: /\b(bristow|era\s*helicopters|phi\s*air|offshore)\b/i,
                                                         tag: 'helicopter_offshore', confidence: 0.80 },
]

function classifyByHex(icao24) {
  if (!icao24) return null
  const entry = _knownAircraft[String(icao24).toLowerCase()]
  if (!entry) return null
  return {
    tags: entry.tags || [],
    operator: entry.operator,
    registration: entry.registration,
    notes: entry.notes,
    source: 'known-aircraft',
    confidence: 0.99,
  }
}

function classifyByType(acType) {
  const cat = categoryFor(acType)
  if (!cat) return null
  return { category: cat, source: 'aircraft-type', confidence: 0.95 }
}

function classifyByOperator(operator) {
  if (!operator) return []
  const op = String(operator).trim()
  if (!op) return []
  const hits = []
  for (const { re, tag, confidence } of OPERATOR_PATTERNS) {
    if (re.test(op)) hits.push({ tag, confidence, source: 'operator' })
  }
  return hits
}

// Combine all signals and return a flat list of unique tags with confidence
// + a category (size/use class). Caller can use `.tags` like a flat tag set
// or inspect `.signals` for provenance.
function classifyAircraft({ icao, acType, operator, callsign } = {}) {
  const signals = []

  const hexHit = classifyByHex(icao)
  if (hexHit) {
    for (const t of hexHit.tags) signals.push({ tag: t, confidence: hexHit.confidence, source: 'hex' })
  }

  const typeHit = classifyByType(acType)
  // type contributes a `category`, not a tag

  const opHits = classifyByOperator(operator)
  signals.push(...opHits)

  const csHits = classifyCallsign(callsign).map(h => ({ ...h, source: 'callsign' }))
  signals.push(...csHits)

  // Helicopter use refinement: if base type is helicopter AND we have
  // a media/EMS/LE signal, surface a more specific tag.
  if (typeHit?.category === 'helicopter') {
    const has = (t) => signals.some(s => s.tag === t)
    if (has('news_media')      && !has('helicopter_news'))     signals.push({ tag: 'helicopter_news',     confidence: 0.95, source: 'compound' })
    if (has('law_enforcement') && !has('helicopter_police'))   signals.push({ tag: 'helicopter_police',   confidence: 0.90, source: 'compound' })
    if (has('medevac')         && !has('helicopter_ems'))      signals.push({ tag: 'helicopter_ems',      confidence: 0.95, source: 'compound' })
    // If we know it's a helicopter but have no other tag, mark `helicopter`
    // explicitly so it can still be filtered.
    if (signals.length === 0)  signals.push({ tag: 'helicopter', confidence: 0.95, source: 'type' })
  }

  // Private vs commercial split for business jets: if it's a business jet
  // and the operator doesn't match an airline/cargo/charter pattern, tag
  // it as private. This is a "negative" inference — we believe it's private
  // because we couldn't classify it as anything else — so confidence is low.
  if (typeHit?.category === 'business_jet') {
    const known = signals.some(s => /^(airline_|cargo_|charter_|government_|law_|head_of_state|news_)/.test(s.tag))
    if (!known) {
      signals.push({ tag: 'private_jet', confidence: 0.55, source: 'inference' })
    }
  }

  // Dedup tags — keep highest confidence per tag.
  const byTag = new Map()
  for (const s of signals) {
    const cur = byTag.get(s.tag)
    if (!cur || s.confidence > cur.confidence) byTag.set(s.tag, s)
  }
  const tags = [...byTag.values()].sort((a, b) => b.confidence - a.confidence)

  return {
    tags,
    category: typeHit?.category || null,
    hexInfo: hexHit ? { operator: hexHit.operator, registration: hexHit.registration, notes: hexHit.notes } : null,
  }
}

module.exports = {
  classifyAircraft,
  classifyByHex,
  classifyByType,
  classifyByOperator,
}
