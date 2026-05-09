const axios = require('axios')
const zlib = require('zlib')
const db = require('./db')

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000
const SNAPSHOT_INTERVAL_MS = Number(process.env.BUSINESS_JET_TRACKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS
const MIN_SAMPLE_INTERVAL_MS = Math.max(DEFAULT_INTERVAL_MS, SNAPSHOT_INTERVAL_MS)
const SNAPSHOT_URL = process.env.BUSINESS_JET_HEATMAP_URL || process.env.ADSB_HEATMAP_URL || ''
const HISTORY_URL_TEMPLATE = process.env.BUSINESS_JET_HISTORY_URL_TEMPLATE || process.env.ADSB_HISTORY_URL_TEMPLATE || ''
const BASELINE_DAYS = Number(process.env.BUSINESS_JET_BASELINE_DAYS) || 365
const BASELINE_WINDOW_MINUTES = Number(process.env.BUSINESS_JET_BASELINE_WINDOW_MINUTES) || 45
const COHORT_MAX_SEATS = Number(process.env.BUSINESS_JET_COHORT_MAX_SEATS) || 32
const MIN_CALIBRATION_SAMPLES = 30
const MANAGED_OPERATOR_CALLSIGN_PREFIXES = ['EJA', 'EJM', 'LXJ', 'TWY', 'LJY', 'EDG']

let timer = null
let running = false
let inFlight = null
let lastError = null
let lastSampleAt = null
let lastRuntimeAudit = {
  managedOperatorExcluded: 0,
  managedOperatorPrefixes: MANAGED_OPERATOR_CALLSIGN_PREFIXES,
}

function toNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function feetFromMeters(m) {
  const n = toNumber(m)
  return n == null ? null : Math.round(n * 3.28084)
}

function ktFromMs(ms) {
  const n = toNumber(ms)
  return n == null ? null : Math.round(n * 1.94384)
}

function normalizeAircraft(ac) {
  const hex = String(ac.hex || ac.icao || ac.icao24 || '').trim().toLowerCase()
  if (!/^[0-9a-f]{6}$/.test(hex)) return null

  const grounded = ac.ground === true || ac.grounded === true || ac.alt_baro === 'ground'
  const lat = toNumber(ac.lat)
  const lon = toNumber(ac.lon)
  const altFt = ac.alt_baro != null && ac.alt_baro !== 'ground'
    ? toNumber(ac.alt_baro)
    : (ac.alt_geom != null ? toNumber(ac.alt_geom) : (ac.alt != null ? feetFromMeters(ac.alt) : null))
  const speedKt = ac.gs != null ? toNumber(ac.gs) : (ac.vel != null ? ktFromMs(ac.vel) : null)
  const heading = ac.track != null ? toNumber(ac.track) : (ac.hdg != null ? toNumber(ac.hdg) : null)
  const verticalRate = ac.baro_rate != null ? toNumber(ac.baro_rate) : (ac.vertRate != null ? toNumber(ac.vertRate) : null)

  return {
    icao24_hex: hex,
    callsign: String(ac.flight || ac.callsign || '').trim() || null,
    lat,
    lon,
    altitude_ft: altFt,
    speed_kt: speedKt,
    heading,
    vertical_rate: verticalRate,
    squawk: ac.squawk || null,
    category: ac.category || null,
    airborne: !grounded && lat != null && lon != null,
    raw: ac,
  }
}

function managedOperatorPrefix(callsign) {
  const cs = String(callsign || '').trim().toUpperCase()
  if (!cs) return null
  return MANAGED_OPERATOR_CALLSIGN_PREFIXES.find(prefix => cs.startsWith(prefix)) || null
}

function extractAircraft(payload) {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.aircraft)) return payload.aircraft
  if (Array.isArray(payload.ac)) return payload.ac
  if (payload.now && payload.aircraft && typeof payload.aircraft === 'object') {
    return Object.values(payload.aircraft)
  }
  return []
}

async function decodeResponse(res) {
  const buf = Buffer.from(res.data)
  const encoding = String(res.headers?.['content-encoding'] || '').toLowerCase()
  const contentType = String(res.headers?.['content-type'] || '').toLowerCase()
  const body = encoding.includes('gzip') || contentType.includes('gzip') || buf[0] === 0x1f && buf[1] === 0x8b
    ? zlib.gunzipSync(buf).toString('utf8')
    : buf.toString('utf8')
  return JSON.parse(body)
}

async function fetchSnapshotFromUrl(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    headers: {
      'Accept': 'application/json, application/gzip, */*',
      'User-Agent': 'flightterm-business-jet-tracker/1.0',
    },
  })
  const payload = await decodeResponse(res)
  return {
    source: url,
    aircraft: extractAircraft(payload).map(normalizeAircraft).filter(Boolean),
    totalFeedCount: extractAircraft(payload).length,
    sampledAt: payload.now ? new Date(Number(payload.now) * 1000) : new Date(),
  }
}

function fetchSnapshotFromPoller() {
  const poller = require('./poller')
  const bundle = poller.getFlights?.() || { flights: [] }
  const flights = bundle.flights || []
  return {
    source: 'poller',
    aircraft: flights.map(normalizeAircraft).filter(Boolean),
    totalFeedCount: flights.length,
    sampledAt: bundle.fetchedAt ? new Date(bundle.fetchedAt) : new Date(),
  }
}

function formatTemplateDate(template, date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return template
    .replaceAll('{yyyy}', String(date.getUTCFullYear()))
    .replaceAll('{yy}', String(date.getUTCFullYear()).slice(-2))
    .replaceAll('{MM}', pad(date.getUTCMonth() + 1))
    .replaceAll('{dd}', pad(date.getUTCDate()))
    .replaceAll('{HH}', pad(date.getUTCHours()))
    .replaceAll('{mm}', pad(date.getUTCMinutes()))
    .replaceAll('{ss}', pad(date.getUTCSeconds()))
    .replaceAll('{epoch}', String(Math.floor(date.getTime() / 1000)))
}

function ensureCohort() {
  if (db.getFaaAircraftRefCount() === 0 || db.getFaaRegistryCount() === 0) {
    return { count: 0, rebuilt: false, missingFaaRef: db.getFaaAircraftRefCount() === 0 }
  }
  const r = db.ensureBusinessJetCohortCurrent({ maxSeats: COHORT_MAX_SEATS })
  return {
    count: r.result?.count ?? r.health?.count ?? db.getBusinessJetLatest().cohortSize,
    rebuilt: !!r.rebuilt,
    reason: r.reason,
  }
}

function computeUnusualScore(count, baseline) {
  if (!baseline || baseline.samples < MIN_CALIBRATION_SAMPLES || baseline.median == null) {
    return null
  }
  if (baseline.max != null && count > baseline.max) return 1
  if (baseline.p99 != null && count > baseline.p99) return 0.88
  if (baseline.p95 != null && count > baseline.p95) return 0.76
  if (baseline.p90 != null && count > baseline.p90) return 0.56
  if (baseline.median != null && count > baseline.median) return 0.28
  return 0
}

function calibrationStatus(baseline, historyTemplateConfigured = !!HISTORY_URL_TEMPLATE) {
  const samples = Number(baseline?.samples || 0)
  if (samples >= MIN_CALIBRATION_SAMPLES) {
    return {
      state: 'calibrated',
      label: 'calibrated',
      samples,
      minSamples: MIN_CALIBRATION_SAMPLES,
      level5Meaning: `disaster-imminent redline: current 30-minute snapshot exceeds every same-version snapshot from the trailing ${BASELINE_DAYS} days for the same UTC weekday within +/-${BASELINE_WINDOW_MINUTES} minutes`,
    }
  }
  return {
    state: 'warming',
    label: 'calibration warming up',
    samples,
    minSamples: MIN_CALIBRATION_SAMPLES,
    historyTemplateConfigured,
    level5Meaning: `unavailable until at least ${MIN_CALIBRATION_SAMPLES} same-version snapshots exist for the same UTC weekday within +/-${BASELINE_WINDOW_MINUTES} minutes`,
  }
}

function msUntilNextSampleSlot(from = new Date(), intervalMs = MIN_SAMPLE_INTERVAL_MS) {
  const now = from instanceof Date ? from.getTime() : new Date(from).getTime()
  if (!Number.isFinite(now)) return intervalMs
  const next = Math.ceil((now + 1) / intervalMs) * intervalMs
  return Math.max(1000, next - now)
}

function isRecentLiveSample(sampledAt = new Date()) {
  const latest = db.getBusinessJetLatest({ historyHours: 1 }).snapshot
  if (!latest?.sampled_at) return false
  const nextAllowed = new Date(latest.sampled_at).getTime() + MIN_SAMPLE_INTERVAL_MS
  const now = sampledAt instanceof Date ? sampledAt.getTime() : new Date(sampledAt).getTime()
  return Number.isFinite(nextAllowed) && Number.isFinite(now) && now < nextAllowed
}

async function sampleOnce({ url = SNAPSHOT_URL, source = null, sampledAt = null } = {}) {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const cohortInfo = ensureCohort()
    const cohortRows = db.getBusinessJetCohort()
    const cohort = new Map(cohortRows.map(r => [r.icao24_hex, r]))

    let snapshot
    if (url) snapshot = await fetchSnapshotFromUrl(url)
    else snapshot = fetchSnapshotFromPoller()
    if (sampledAt) snapshot.sampledAt = sampledAt instanceof Date ? sampledAt : new Date(sampledAt)
    if (source) snapshot.source = source
    const isHistorical = source === 'history'
    if (!isHistorical && isRecentLiveSample(snapshot.sampledAt)) {
      const latest = db.getBusinessJetLatest({ historyHours: 1 }).snapshot
      lastSampleAt = latest?.sampled_at || lastSampleAt
      return {
        snapshotId: latest?.id || null,
        sampled_at: latest?.sampled_at || null,
        skipped: true,
        reason: 'last business-jet snapshot is less than 30 minutes old',
        airborne: latest?.airborne_count || 0,
        matched: latest?.matched_count || 0,
        baseline: latest ? {
          mean: latest.baseline_mean,
          p95: latest.baseline_p95,
          p99: latest.baseline_p99,
          samples: latest.baseline_samples,
        } : null,
        unusualScore: latest?.unusual_score ?? null,
        source: latest?.source || snapshot.source,
      }
    }

    if (snapshot.totalFeedCount === 0) {
      throw new Error(`business jet tracker source ${snapshot.source} returned no aircraft; skipping snapshot`)
    }

    const matched = []
    let managedOperatorExcluded = 0
    const managedOperatorExcludedByPrefix = {}
    for (const ac of snapshot.aircraft) {
      const c = cohort.get(ac.icao24_hex)
      if (!c) continue
      const deniedPrefix = managedOperatorPrefix(ac.callsign)
      if (deniedPrefix) {
        managedOperatorExcluded++
        managedOperatorExcludedByPrefix[deniedPrefix] = (managedOperatorExcludedByPrefix[deniedPrefix] || 0) + 1
        continue
      }
      matched.push({
        ...ac,
        n_number: c.n_number ? `N${c.n_number}` : null,
        owner_name: c.owner_name,
        aircraft_mfr: c.aircraft_mfr,
        aircraft_model: c.aircraft_model,
        cohort_tier: c.cohort_tier,
        owner_class: c.owner_class,
        wealth_weight: c.wealth_weight,
      })
    }
    lastRuntimeAudit = {
      managedOperatorExcluded,
      managedOperatorExcludedByPrefix,
      managedOperatorPrefixes: MANAGED_OPERATOR_CALLSIGN_PREFIXES,
    }
    const airborne = matched.filter(m => m.airborne)
    const baseline = db.getBusinessJetBaseline({
      sampledAt: snapshot.sampledAt,
      days: BASELINE_DAYS,
      windowMinutes: BASELINE_WINDOW_MINUTES,
    })
    const unusualScore = computeUnusualScore(airborne.length, baseline)
    const recorded = db.recordBusinessJetSnapshot({
      sampledAt: snapshot.sampledAt,
      source: snapshot.source,
      cohortSize: cohortRows.length,
      totalFeedCount: snapshot.totalFeedCount,
      positions: airborne,
      baseline,
      unusualScore,
    })
    lastSampleAt = recorded.sampled_at
    lastError = null
    return {
      ...recorded,
      cohort: cohortInfo,
      airborne: airborne.length,
      matched: matched.length,
      baseline,
      unusualScore,
      calibrationStatus: calibrationStatus(baseline),
      audit: lastRuntimeAudit,
      source: snapshot.source,
    }
  })().catch(err => {
    lastError = err.message
    throw err
  }).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function backfillHistorical({ start, end, stepMinutes = 30, urlTemplate = HISTORY_URL_TEMPLATE } = {}) {
  if (!urlTemplate) throw new Error('BUSINESS_JET_HISTORY_URL_TEMPLATE is not configured')
  const startDate = new Date(start)
  const endDate = new Date(end)
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
    throw new Error('valid start and end dates are required')
  }
  const stepMs = Math.max(30, Number(stepMinutes) || 30) * 60_000
  const results = []
  for (let t = startDate.getTime(); t <= endDate.getTime(); t += stepMs) {
    const sampledAt = new Date(t)
    const url = formatTemplateDate(urlTemplate, sampledAt)
    try {
      const r = await sampleOnce({ url, source: 'history', sampledAt })
      results.push({ sampledAt: sampledAt.toISOString(), ok: true, airborne: r.airborne })
    } catch (err) {
      results.push({ sampledAt: sampledAt.toISOString(), ok: false, error: err.message })
    }
  }
  return results
}

function getTrackerState() {
  const data = db.getBusinessJetLatest({ historyHours: 168 })
  const snap = data.snapshot
  const computedBaseline = snap ? db.getBusinessJetBaseline({
    sampledAt: snap.sampled_at,
    days: BASELINE_DAYS,
    windowMinutes: BASELINE_WINDOW_MINUTES,
  }) : null
  const baseline = snap ? {
    mean: computedBaseline?.mean ?? snap.baseline_mean,
    median: computedBaseline?.median ?? null,
    p90: computedBaseline?.p90 ?? null,
    p95: computedBaseline?.p95 ?? snap.baseline_p95,
    p99: computedBaseline?.p99 ?? snap.baseline_p99,
    max: computedBaseline?.max ?? null,
    samples: computedBaseline?.samples ?? snap.baseline_samples,
    days: BASELINE_DAYS,
    windowMinutes: BASELINE_WINDOW_MINUTES,
  } : null
  const status = calibrationStatus(baseline)
  const cohortAudit = db.getBusinessJetCohortAudit()
  const baselineCurve = snap ? db.getBusinessJetBaselineCurve({
    sampledAt: snap.sampled_at,
    days: BASELINE_DAYS,
    windowMinutes: BASELINE_WINDOW_MINUTES,
    hours: 48,
    stepMinutes: 30,
  }) : []
  return {
    running,
    intervalMs: SNAPSHOT_INTERVAL_MS,
    minSampleIntervalMs: MIN_SAMPLE_INTERVAL_MS,
    source: SNAPSHOT_URL || 'poller',
    historyTemplateConfigured: !!HISTORY_URL_TEMPLATE,
    lastError,
    lastSampleAt: lastSampleAt || snap?.sampled_at || null,
    cohortVersion: db.BUSINESS_JET_COHORT_VERSION,
    cohortSize: data.cohortSize,
    cohortBreakdown: data.cohortBreakdown || { tiers: [], owners: [] },
    calibrationStatus: status,
    audit: {
      ...cohortAudit,
      runtime: {
        ...lastRuntimeAudit,
        managedOperatorPrefixes: MANAGED_OPERATOR_CALLSIGN_PREFIXES,
      },
    },
    snapshot: snap ? {
      id: snap.id,
      sampledAt: snap.sampled_at,
      cohortVersion: snap.cohort_version,
      source: snap.source,
      cohortSize: snap.cohort_size,
      airborneCount: snap.airborne_count,
      matchedCount: snap.matched_count,
      totalFeedCount: snap.total_feed_count,
      unusualScore: snap.unusual_score,
    } : null,
    baseline,
    baselineCurve,
    positions: data.positions.map(p => ({
      icao: p.icao24_hex,
      callsign: p.callsign,
      registration: p.n_number,
      owner: p.owner_name,
      manufacturer: p.aircraft_mfr,
      model: p.aircraft_model,
      tier: p.cohort_tier,
      ownerClass: p.owner_class,
      wealthWeight: p.wealth_weight,
      lat: p.lat,
      lon: p.lon,
      altitudeFt: p.altitude_ft,
      speedKt: p.speed_kt,
      heading: p.heading,
      verticalRate: p.vertical_rate,
      squawk: p.squawk,
      category: p.category,
      sampledAt: p.sampled_at,
    })),
    history: data.history,
  }
}

function start() {
  if (running) return
  running = true
  const run = () => sampleOnce().catch(err => console.warn('business-jet-tracker:', err.message))
  timer = setTimeout(() => {
    run()
    timer = setInterval(run, MIN_SAMPLE_INTERVAL_MS)
    timer.unref?.()
  }, msUntilNextSampleSlot())
  timer.unref?.()
}

function stop() {
  running = false
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = {
  start,
  stop,
  sampleOnce,
  backfillHistorical,
  getTrackerState,
  _internals: {
    normalizeAircraft,
    extractAircraft,
    formatTemplateDate,
    computeUnusualScore,
    msUntilNextSampleSlot,
  },
}
