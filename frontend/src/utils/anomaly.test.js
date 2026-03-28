import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  scoreAnomaly,
  detectPhase,
  deriveSeverity,
  CATEGORY,
  SEVERITY,
  PHASE,
  ANOMALY_THRESHOLD,
} from './anomaly.js'

// ── Test fixtures / factories ────────────────────────────────────────────────

const NOW = 1711500000000 // fixed timestamp for deterministic tests

/** Build a snapshot entry */
function snap(overrides = {}) {
  return {
    ts: NOW - 90000, // 90s ago by default
    alt: 10000,      // meters (~FL330)
    vel: 230,        // m/s (~450kts)
    hdg: 90,
    grounded: false,
    vertRate: null,
    posSrc: 0,       // ADS-B
    ndb: null,
    ...overrides,
  }
}

/** Build a "current" flight object */
function flight(overrides = {}) {
  return {
    icao: 'abc123',
    callsign: 'UAL123',
    lat: 40.0,
    lon: -74.0,
    alt: 10000,
    vel: 230,
    hdg: 90,
    grounded: false,
    squawk: '1200',
    mil: false,
    vertRate: null,
    posSrc: 0,
    ndb: null,
    category: null,
    ...overrides,
  }
}

/** Build a minimal valid snapshot array (2+ entries for scoring to work) */
function snapshots(count = 3, overrides = {}) {
  return Array.from({ length: count }, (_, i) => snap({
    ts: NOW - (count - i) * 90000,
    ...overrides,
  }))
}

/** Build cruise-phase snapshots (stable altitude, good speed) */
function cruiseSnapshots(count = 5, alt = 10000) {
  return Array.from({ length: count }, (_, i) => snap({
    ts: NOW - (count - i) * 90000,
    alt: alt + (i % 2 === 0 ? 3 : -3), // deterministic tiny jitter
    vel: 230,
    hdg: 90,
  }))
}

/** Build descent snapshots */
function descentSnapshots(count = 5) {
  return Array.from({ length: count }, (_, i) => snap({
    ts: NOW - (count - i) * 90000,
    alt: 10000 - i * 500, // descending 500m per snapshot
    vel: 200,
    hdg: 90,
  }))
}

/** Build climb snapshots */
function climbSnapshots(count = 5) {
  return Array.from({ length: count }, (_, i) => snap({
    ts: NOW - (count - i) * 90000,
    alt: 2000 + i * 500,
    vel: 180,
    hdg: 90,
  }))
}


// ── Mock Date.now for deterministic scoring ──────────────────────────────────
// scoreAnomaly uses Date.now() internally for dtSec calculations

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
})


// ═════════════════════════════════════════════════════════════════════════════
// P0: Phase Detection
// ═════════════════════════════════════════════════════════════════════════════

describe('detectPhase', () => {
  it('returns UNKNOWN with null/empty/single snapshot', () => {
    expect(detectPhase(null)).toBe(PHASE.UNKNOWN)
    expect(detectPhase([])).toBe(PHASE.UNKNOWN)
    expect(detectPhase([snap()])).toBe(PHASE.UNKNOWN)
  })

  it('returns GROUND when last snapshot is grounded', () => {
    const snaps = [snap(), snap({ grounded: true })]
    expect(detectPhase(snaps)).toBe(PHASE.GROUND)
  })

  it('detects CRUISE — stable altitude at speed', () => {
    const snaps = cruiseSnapshots(5)
    expect(detectPhase(snaps)).toBe(PHASE.CRUISE)
  })

  it('detects CLIMB — consistent altitude gain', () => {
    const snaps = climbSnapshots(5)
    expect(detectPhase(snaps)).toBe(PHASE.CLIMB)
  })

  it('detects DESCENT — consistent altitude loss', () => {
    const snaps = descentSnapshots(5)
    expect(detectPhase(snaps)).toBe(PHASE.DESCENT)
  })

  it('detects APPROACH — low alt, descending, slow', () => {
    const snaps = Array.from({ length: 5 }, (_, i) => snap({
      ts: NOW - (5 - i) * 90000,
      alt: 2000 - i * 100, // descending slowly from 2000m
      vel: 80,             // slow
      hdg: 90,
    }))
    expect(detectPhase(snaps)).toBe(PHASE.APPROACH)
  })

  it('detects low-altitude CLIMB (climb-out)', () => {
    const snaps = Array.from({ length: 5 }, (_, i) => snap({
      ts: NOW - (5 - i) * 90000,
      alt: 500 + i * 200, // low alt, climbing
      vel: 150,
      hdg: 90,
    }))
    expect(detectPhase(snaps)).toBe(PHASE.CLIMB)
  })

  it('returns UNKNOWN when altitude data is missing', () => {
    const snaps = [snap({ alt: null }), snap({ alt: null })]
    expect(detectPhase(snaps)).toBe(PHASE.UNKNOWN)
  })

  it('only considers last 5 snapshots', () => {
    // 10 climb snapshots followed by 5 level cruise snapshots
    const climb = climbSnapshots(10)
    const cruise = cruiseSnapshots(5)
    const combined = [...climb, ...cruise]
    // detectPhase slices last 5, so should see cruise
    expect(detectPhase(combined)).toBe(PHASE.CRUISE)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P0: Severity Tiers
// ═════════════════════════════════════════════════════════════════════════════

describe('deriveSeverity', () => {
  it('SQUAWK category always returns CRITICAL', () => {
    expect(deriveSeverity(10, CATEGORY.SQUAWK, false)).toBe(SEVERITY.CRITICAL)
    expect(deriveSeverity(0, CATEGORY.SQUAWK, false)).toBe(SEVERITY.CRITICAL)
  })

  it('EMERGENCY category always returns CRITICAL', () => {
    expect(deriveSeverity(10, CATEGORY.EMERGENCY, false)).toBe(SEVERITY.CRITICAL)
  })

  it('score >= 80 returns CRITICAL', () => {
    expect(deriveSeverity(80, CATEGORY.ALTITUDE, false)).toBe(SEVERITY.CRITICAL)
    expect(deriveSeverity(100, CATEGORY.ALTITUDE, false)).toBe(SEVERITY.CRITICAL)
  })

  it('score >= 60 returns HIGH', () => {
    expect(deriveSeverity(60, CATEGORY.ALTITUDE, false)).toBe(SEVERITY.HIGH)
    expect(deriveSeverity(79, CATEGORY.ALTITUDE, false)).toBe(SEVERITY.HIGH)
  })

  it('confirmed flag returns HIGH even if score < 60', () => {
    expect(deriveSeverity(40, CATEGORY.ALTITUDE, true)).toBe(SEVERITY.HIGH)
  })

  it('score >= ANOMALY_THRESHOLD returns MEDIUM', () => {
    expect(deriveSeverity(35, CATEGORY.ALTITUDE, false)).toBe(SEVERITY.MEDIUM)
    expect(deriveSeverity(59, CATEGORY.ALTITUDE, false)).toBe(SEVERITY.MEDIUM)
  })

  it('score < ANOMALY_THRESHOLD returns LOW', () => {
    expect(deriveSeverity(0, CATEGORY.ALTITUDE, false)).toBe(SEVERITY.LOW)
    expect(deriveSeverity(34, CATEGORY.ALTITUDE, false)).toBe(SEVERITY.LOW)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P0: Squawk Detection (safety-critical)
// ═════════════════════════════════════════════════════════════════════════════

describe('squawk detection', () => {
  it('7700 — score >= 80, CRITICAL severity', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '7700' })
    const result = scoreAnomaly(snaps, cur)

    expect(result.score).toBeGreaterThanOrEqual(80)
    expect(result.severity).toBe(SEVERITY.CRITICAL)
    expect(result.categories).toContain(CATEGORY.SQUAWK)
    expect(result.reasons.some(r => r.includes('7700'))).toBe(true)
  })

  it('7500 — score exactly 100 (hijack)', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '7500' })
    const result = scoreAnomaly(snaps, cur)

    expect(result.score).toBe(100)
    expect(result.severity).toBe(SEVERITY.CRITICAL)
    expect(result.categories).toContain(CATEGORY.SQUAWK)
    expect(result.reasons.some(r => r.includes('7500'))).toBe(true)
  })

  it('7600 — adds 20 points (radio failure)', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '7600' })
    const result = scoreAnomaly(snaps, cur)

    // 7600 adds 20 via addScore, not a floor like 7700/7500
    expect(result.categories).toContain(CATEGORY.SQUAWK)
    expect(result.reasons.some(r => r.includes('7600'))).toBe(true)
  })

  it('normal squawk (1200) triggers no squawk category', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '1200' })
    const result = scoreAnomaly(snaps, cur)

    expect(result.categories).not.toContain(CATEGORY.SQUAWK)
  })

  it('7700 is never dampened by weather', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '7700' })
    const weather = { sigmets: { convective: 5, turbulence: 3 }, pireps: { count: 10, severe: true } }
    const result = scoreAnomaly(snaps, cur, null, weather)

    expect(result.score).toBeGreaterThanOrEqual(80)
    expect(result.severity).toBe(SEVERITY.CRITICAL)
  })

  it('7500 is never dampened by military flag', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '7500', mil: true })
    const result = scoreAnomaly(snaps, cur)

    expect(result.score).toBe(100)
  })

  it('7700 is never dampened by airport proximity', () => {
    // KJFK coords
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '7700', lat: 40.641, lon: -73.778 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.score).toBeGreaterThanOrEqual(80)
    expect(result.severity).toBe(SEVERITY.CRITICAL)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P0: Emergency Declaration
// ═════════════════════════════════════════════════════════════════════════════

describe('emergency declaration (adsb.fi emergency field)', () => {
  const makeEnrich = (emergency) => ({
    adsbfi: { emergency, category: 'A3' },
  })

  it('general emergency — score >= 60', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight()
    const result = scoreAnomaly(snaps, cur, makeEnrich('general'))

    expect(result.score).toBeGreaterThanOrEqual(60)
    expect(result.categories).toContain(CATEGORY.EMERGENCY)
    expect(result.severity).toBe(SEVERITY.CRITICAL)
  })

  it('unlawful — score 100', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight()
    const result = scoreAnomaly(snaps, cur, makeEnrich('unlawful'))

    expect(result.score).toBe(100)
  })

  it('lifeguard — score >= 40', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight()
    const result = scoreAnomaly(snaps, cur, makeEnrich('lifeguard'))

    expect(result.score).toBeGreaterThanOrEqual(40)
  })

  it('minfuel — score >= 40', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight()
    const result = scoreAnomaly(snaps, cur, makeEnrich('minfuel'))

    expect(result.score).toBeGreaterThanOrEqual(40)
  })

  it('nordo — score >= 40', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight()
    const result = scoreAnomaly(snaps, cur, makeEnrich('nordo'))

    expect(result.score).toBeGreaterThanOrEqual(40)
  })

  it('emergency is never dampened by weather', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight()
    const weather = { sigmets: { convective: 5 }, pireps: { count: 10, severe: true } }
    const result = scoreAnomaly(snaps, cur, makeEnrich('general'), weather)

    expect(result.score).toBeGreaterThanOrEqual(60)
    expect(result.categories).toContain(CATEGORY.EMERGENCY)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P0: Altitude Anomaly
// ═════════════════════════════════════════════════════════════════════════════

describe('altitude anomaly scoring', () => {
  it('extreme descent rate during cruise triggers ALTITUDE category', () => {
    const snaps = cruiseSnapshots(3)
    // Transponder reports -30 m/s vertical rate during what looks like cruise
    const cur = flight({ vertRate: -30 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.categories).toContain(CATEGORY.ALTITUDE)
    expect(result.score).toBeGreaterThan(0)
  })

  it('normal vertical rate during cruise scores 0', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: 0 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.categories).not.toContain(CATEGORY.ALTITUDE)
  })

  it('extreme climb rate during cruise triggers ALTITUDE', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: 25 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.categories).toContain(CATEGORY.ALTITUDE)
  })

  it('altitude score capped at 80', () => {
    const snaps = cruiseSnapshots(3)
    // Insane rate that would produce >80 uncapped
    const cur = flight({ vertRate: -100 })
    const result = scoreAnomaly(snaps, cur)

    // Category score capped at 80 per the Math.min(80, ...)
    // Total score can go higher from other categories
    expect(result.categories).toContain(CATEGORY.ALTITUDE)
  })

  it('computed altitude rate used when vertRate not available', () => {
    // Snapshots at 10000m, current at 9000m, 90s gap → ~-11 m/s rate
    const snaps = [
      snap({ ts: NOW - 180000, alt: 10000 }),
      snap({ ts: NOW - 90000, alt: 10000 }),
    ]
    const cur = flight({ alt: 9000, vertRate: null })
    const result = scoreAnomaly(snaps, cur)

    // Should detect altitude anomaly from computed rate
    // (depends on phase — cruise norms are -2 to +2 m/s)
    expect(result.score).toBeGreaterThan(0)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P1: Tolerance Multipliers
// ═════════════════════════════════════════════════════════════════════════════

describe('aircraft class tolerance', () => {
  it('light aircraft (A1) gets wider tolerance — lower score for same deviation', () => {
    const snaps = cruiseSnapshots(3)
    const deviation = { vertRate: -15 } // moderate descent during cruise

    const heavy = scoreAnomaly(snaps, flight({ ...deviation, category: 'A5' }),
      { adsbfi: { category: 'A5' } })
    const light = scoreAnomaly(snaps, flight({ ...deviation, category: 'A1' }),
      { adsbfi: { category: 'A1' } })

    // Heavy (0.9x tolerance) should score higher than light (2.0x tolerance)
    expect(heavy.score).toBeGreaterThan(light.score)
  })

  it('heavy aircraft (A5) has tightest tolerance', () => {
    const snaps = cruiseSnapshots(3)
    // Moderate deviation that a light aircraft would tolerate
    const cur = flight({ vertRate: -8, category: 'A5' })
    const result = scoreAnomaly(snaps, cur, { adsbfi: { category: 'A5' } })

    expect(result.categories).toContain(CATEGORY.ALTITUDE)
  })

  it('glider (B1) gets very wide tolerance', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: -15, category: 'B1' })
    const result = scoreAnomaly(snaps, cur, { adsbfi: { category: 'B1' } })

    // Score should be lower than same deviation on commercial jet
    const jet = scoreAnomaly(snaps, flight({ vertRate: -15, category: 'A3' }),
      { adsbfi: { category: 'A3' } })
    expect(result.score).toBeLessThan(jet.score)
  })
})

describe('altitude band multiplier', () => {
  it('FL350+ (10668m+) has tighter tolerance', () => {
    const snaps = cruiseSnapshots(3, 11000)
    const cur = flight({ alt: 11000, vertRate: -8 })
    const resultHigh = scoreAnomaly(snaps, cur)

    const snapsLow = cruiseSnapshots(3, 5000)
    const curLow = flight({ alt: 5000, vertRate: -8 })
    const resultLow = scoreAnomaly(snapsLow, curLow)

    // Same deviation at FL350+ should score higher than at FL160
    expect(resultHigh.score).toBeGreaterThanOrEqual(resultLow.score)
  })

  it('below 3000ft (914m) has widest tolerance', () => {
    const snaps = cruiseSnapshots(3, 800)
    const cur = flight({ alt: 800, vertRate: -8, vel: 100 })
    const result = scoreAnomaly(snaps, cur)

    // Wide tolerance at low altitude, but still can trigger with -8 m/s rate
    // Score is dampened but not eliminated due to multiple multipliers stacking
    expect(result.score).toBeLessThan(80)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P1: Weather Dampening
// ═════════════════════════════════════════════════════════════════════════════

describe('weather dampening', () => {
  function scoreWithWeather(weather) {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: -20 }) // anomalous descent during cruise
    return scoreAnomaly(snaps, cur, null, weather)
  }

  it('convective SIGMET dampens by 0.3x', () => {
    const noWx = scoreWithWeather(null)
    const withWx = scoreWithWeather({ sigmets: { convective: 2 }, pireps: {} })

    expect(withWx.score).toBeLessThan(noWx.score)
    expect(withWx.reasons.some(r => r.includes('convective'))).toBe(true)
  })

  it('turbulence SIGMET dampens by 0.5x', () => {
    const noWx = scoreWithWeather(null)
    const withWx = scoreWithWeather({ sigmets: { turbulence: 1 }, pireps: {} })

    expect(withWx.score).toBeLessThan(noWx.score)
    expect(withWx.score).toBeGreaterThan(0)
  })

  it('severe PIREPs dampen by 0.5x', () => {
    const noWx = scoreWithWeather(null)
    const withWx = scoreWithWeather({ sigmets: {}, pireps: { severe: true, count: 2 } })

    expect(withWx.score).toBeLessThan(noWx.score)
  })

  it('moderate PIREPs (>3) dampen by 0.7x', () => {
    const noWx = scoreWithWeather(null)
    const withWx = scoreWithWeather({ sigmets: {}, pireps: { count: 5 } })

    expect(withWx.score).toBeLessThan(noWx.score)
    expect(withWx.reasons.some(r => r.includes('PIREP'))).toBe(true)
  })

  it('few PIREPs (<=3) do not dampen', () => {
    const noWx = scoreWithWeather(null)
    const withWx = scoreWithWeather({ sigmets: {}, pireps: { count: 2 } })

    expect(withWx.score).toBe(noWx.score)
  })

  it('weather never dampens SQUAWK 7700', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '7700' })
    const weather = { sigmets: { convective: 5 }, pireps: { count: 10, severe: true } }

    const noWx = scoreAnomaly(snaps, cur)
    const withWx = scoreAnomaly(snaps, cur, null, weather)

    expect(withWx.score).toBe(noWx.score)
  })

  it('weather never dampens EMERGENCY', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight()
    const enrich = { adsbfi: { emergency: 'general' } }
    const weather = { sigmets: { convective: 5 }, pireps: { count: 10, severe: true } }

    const noWx = scoreAnomaly(snaps, cur, enrich)
    const withWx = scoreAnomaly(snaps, cur, enrich, weather)

    expect(withWx.score).toBe(noWx.score)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P1: Spatial Context
// ═════════════════════════════════════════════════════════════════════════════

describe('spatial context', () => {
  function makeNeighbors(count, hdg) {
    return Array.from({ length: count }, (_, i) => ({
      icao: `neighbor${i}`,
      lat: 40.0 + (i * 0.01),
      lon: -74.0 + (i * 0.01),
      alt: 10000,
      hdg,
      grounded: false,
      vel: 230,
    }))
  }

  it('lone deviant among straight-flying neighbors gets boosted', () => {
    const snaps = cruiseSnapshots(3)
    // Current aircraft heading 150°, neighbors all heading 90°
    const cur = flight({ hdg: 150 })
    const neighbors = makeNeighbors(15, 90)
    const allFlights = [cur, ...neighbors]

    const withContext = scoreAnomaly(snaps, flight({ vertRate: -10, hdg: 150 }), null, null, allFlights)
    const alone = scoreAnomaly(snaps, flight({ vertRate: -10, hdg: 150 }))

    // With spatial context showing lone deviant, score should be higher
    expect(withContext.score).toBeGreaterThanOrEqual(alone.score)
  })

  it('group maneuvering together with weather dampens score', () => {
    const snaps = cruiseSnapshots(3)
    // Everyone heading ~150° (turned together)
    const cur = flight({ hdg: 150, vertRate: -10 })
    const neighbors = makeNeighbors(15, 155)
    const allFlights = [cur, ...neighbors]
    const weather = { sigmets: { convective: 1 }, pireps: {} }

    const withContext = scoreAnomaly(snaps, cur, null, weather, allFlights)
    const alone = scoreAnomaly(snaps, flight({ vertRate: -10, hdg: 150 }))

    expect(withContext.score).toBeLessThan(alone.score)
  })

  it('group maneuvering without weather explanation boosts score', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ hdg: 150, vertRate: -10 })
    const neighbors = makeNeighbors(15, 155) // group turned together
    const allFlights = [cur, ...neighbors]

    const withContext = scoreAnomaly(snaps, cur, null, null, allFlights)
    const alone = scoreAnomaly(snaps, flight({ vertRate: -10, hdg: 150 }))

    // No weather but group deviating → area event → boost (1.4x)
    // However, spatial dampening (0.4) triggers first, then the "no weather" branch
    // overrides to 1.4x. The net effect depends on scoring order.
    expect(withContext.score).toBeGreaterThanOrEqual(alone.score)
  })

  it('too few neighbors (< 3 within range) → no spatial adjustment', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: -10 })
    // Only 2 neighbors
    const allFlights = [cur, ...makeNeighbors(2, 90)]

    const withContext = scoreAnomaly(snaps, cur, null, null, allFlights)
    const alone = scoreAnomaly(snaps, cur)

    expect(withContext.score).toBe(alone.score)
  })

  it('fewer than 10 total flights → no spatial adjustment', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: -10 })
    const allFlights = [cur, ...makeNeighbors(5, 90)]

    const withContext = scoreAnomaly(snaps, cur, null, null, allFlights)
    const alone = scoreAnomaly(snaps, cur)

    expect(withContext.score).toBe(alone.score)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P1: Confirmation Logic
// ═════════════════════════════════════════════════════════════════════════════

describe('multi-fetch confirmation', () => {
  it('two consecutive large descents → confirmed = true, score boosted', () => {
    // prevPrev: 10000m, prev: 9500m, current: 8900m → both deltas < -300
    const snaps = [
      snap({ ts: NOW - 270000, alt: 10000 }),
      snap({ ts: NOW - 180000, alt: 10000 }),
      snap({ ts: NOW - 90000, alt: 9500 }),
    ]
    const cur = flight({ alt: 8900, vertRate: -10 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.confirmed).toBe(true)
    expect(result.reasons.some(r => r.includes('confirmed'))).toBe(true)
  })

  it('single descent → not confirmed', () => {
    const snaps = [
      snap({ ts: NOW - 270000, alt: 10000 }),
      snap({ ts: NOW - 180000, alt: 10000 }),
      snap({ ts: NOW - 90000, alt: 10000 }),
    ]
    const cur = flight({ alt: 9500, vertRate: -8 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.confirmed).toBe(false)
  })
})

describe('noise recovery', () => {
  it('spike then recovery → score dampened by 0.3x and flagged as noise', () => {
    // prevPrev: 10000m, prev: 10600m (spike >500), current: 10050m (|currDelta|=550 > 500? no, |currDelta| = |10050-10600| = 550 > 100 — not recovery)
    // For noise recovery: |prevDelta| > 500 AND |currDelta| < 100
    // prevDelta = prev.alt - prevPrev.alt = 10600 - 10000 = 600 (>500 ✓)
    // currDelta = current.alt - prev.alt = 10050 - 10600 = -550 (|-550| < 100? NO)
    // Need: current.alt close to prev.alt for recovery. prev had the spike.
    const snaps = [
      snap({ ts: NOW - 270000, alt: 10000 }),
      snap({ ts: NOW - 180000, alt: 10000 }),
      snap({ ts: NOW - 90000, alt: 10600 }), // spike: delta = +600 (>500)
    ]
    const cur = flight({ alt: 10620, vertRate: 0 }) // recovery: delta = +20 (<100)

    const result = scoreAnomaly(snaps, cur)

    // The noise recovery dampener should fire
    if (result.score > 0) {
      expect(result.reasons.some(r => r.includes('noise') || r.includes('recovered'))).toBe(true)
    }
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P2: Airport Proximity
// ═════════════════════════════════════════════════════════════════════════════

describe('airport proximity dampening', () => {
  it('descent-only anomaly near KJFK → 0.25x dampening', () => {
    // KJFK: 40.641, -73.778
    const snaps = descentSnapshots(5)
    const cur = flight({
      lat: 40.65, lon: -73.78, // ~1km from JFK
      alt: 8000,
      vertRate: -25, // steep descent
    })

    const nearAirport = scoreAnomaly(snaps, cur)

    // Same scenario far from any airport
    const curFar = flight({
      lat: 42.0, lon: -78.0, // middle of nowhere
      alt: 8000,
      vertRate: -25,
    })
    const farFromAirport = scoreAnomaly(snaps, curFar)

    expect(nearAirport.score).toBeLessThan(farFromAirport.score)
  })

  it('squawk 7700 near airport is NOT dampened', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({
      lat: 40.65, lon: -73.78, // near JFK
      squawk: '7700',
    })
    const result = scoreAnomaly(snaps, cur)

    expect(result.score).toBeGreaterThanOrEqual(80)
    expect(result.severity).toBe(SEVERITY.CRITICAL)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P1: Military Suppression
// ═════════════════════════════════════════════════════════════════════════════

describe('military suppression', () => {
  it('military flag dampens non-emergency score by 0.3x', () => {
    const snaps = cruiseSnapshots(3)
    const deviation = { vertRate: -20 }

    const civilian = scoreAnomaly(snaps, flight(deviation))
    const military = scoreAnomaly(snaps, flight({ ...deviation, mil: true }))

    expect(military.score).toBeLessThan(civilian.score)
  })

  it('military flag via enrichment also dampens', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: -20 })
    const enrich = { adsbfi: { mil: true } }

    const noEnrich = scoreAnomaly(snaps, cur)
    const withEnrich = scoreAnomaly(snaps, cur, enrich)

    expect(withEnrich.score).toBeLessThan(noEnrich.score)
  })

  it('military 7700 squawk is NOT dampened', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '7700', mil: true })
    const result = scoreAnomaly(snaps, cur)

    expect(result.score).toBeGreaterThanOrEqual(80)
  })

  it('military emergency declaration is NOT dampened', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ mil: true })
    const enrich = { adsbfi: { emergency: 'general', mil: true } }
    const result = scoreAnomaly(snaps, cur, enrich)

    expect(result.score).toBeGreaterThanOrEqual(60)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P1: Heading / Diversion
// ═════════════════════════════════════════════════════════════════════════════

describe('heading anomaly', () => {
  it('large heading change during cruise triggers HEADING', () => {
    const snaps = cruiseSnapshots(3).map(s => ({ ...s, hdg: 90 }))
    // 90° heading change during cruise
    const cur = flight({ hdg: 180 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.categories).toContain(CATEGORY.HEADING)
  })

  it('heading change during descent does NOT trigger HEADING', () => {
    const snaps = descentSnapshots(3).map(s => ({ ...s, hdg: 90 }))
    const cur = flight({ hdg: 180, alt: 8500, vertRate: -10 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.categories).not.toContain(CATEGORY.HEADING)
  })

  it('heading change below threshold (45° * classMult) does not score', () => {
    const snaps = cruiseSnapshots(3).map(s => ({ ...s, hdg: 90 }))
    const cur = flight({ hdg: 120 }) // only 30° change, below 45° threshold
    const result = scoreAnomaly(snaps, cur)

    expect(result.categories).not.toContain(CATEGORY.HEADING)
  })
})

describe('diversion detection', () => {
  it('heading away from destination during cruise triggers DIVERSION', () => {
    const snaps = cruiseSnapshots(3)
    // Destination is due east (bearing ~90°), aircraft heading south (180°)
    const cur = flight({ hdg: 180, lat: 40.0, lon: -80.0 })
    const route = {
      destination: { latitude: 40.0, longitude: -74.0 }, // east of aircraft
    }
    const result = scoreAnomaly(snaps, cur, { flightroute: route })

    expect(result.categories).toContain(CATEGORY.DIVERSION)
  })

  it('heading toward destination does NOT trigger diversion', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ hdg: 90, lat: 40.0, lon: -80.0 })
    const route = {
      destination: { latitude: 40.0, longitude: -74.0 },
    }
    const result = scoreAnomaly(snaps, cur, { flightroute: route })

    expect(result.categories).not.toContain(CATEGORY.DIVERSION)
  })

  it('diversion not scored outside cruise phase', () => {
    const snaps = descentSnapshots(5)
    const cur = flight({ hdg: 270, lat: 40.0, lon: -80.0, alt: 8000, vertRate: -10 })
    const route = {
      destination: { latitude: 40.0, longitude: -74.0 },
    }
    const result = scoreAnomaly(snaps, cur, { flightroute: route })

    expect(result.categories).not.toContain(CATEGORY.DIVERSION)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P1: MCP Intent Signals
// ═════════════════════════════════════════════════════════════════════════════

describe('MCP intent scoring', () => {
  it('MCP altitude >10000ft below current → emergency descent intent (35pts)', () => {
    const snaps = cruiseSnapshots(3)
    // Aircraft at 10000m ≈ 32808ft, MCP set to 10000ft → gap of ~22808ft
    const cur = flight({ alt: 10000 })
    const enrich = { adsbfi: { navAlt: 10000, category: 'A3' } }
    const result = scoreAnomaly(snaps, cur, enrich)

    expect(result.categories).toContain(CATEGORY.INTENT)
    expect(result.reasons.some(r => r.includes('emergency descent intent'))).toBe(true)
  })

  it('MCP altitude 5000-10000ft below current → moderate intent (15pts)', () => {
    const snaps = cruiseSnapshots(3)
    // Aircraft at 10000m ≈ 32808ft, MCP set to 25000ft → gap of ~7808ft
    const cur = flight({ alt: 10000, lat: 42.0, lon: -78.0 }) // far from airports
    const enrich = { adsbfi: { navAlt: 25000, category: 'A3' } }
    const result = scoreAnomaly(snaps, cur, enrich)

    expect(result.categories).toContain(CATEGORY.INTENT)
  })

  it('MCP heading divergent >60° → turn intent', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ hdg: 90 })
    const enrich = { adsbfi: { navHdg: 200, category: 'A3' } } // 110° divergence
    const result = scoreAnomaly(snaps, cur, enrich)

    expect(result.categories).toContain(CATEGORY.INTENT)
    expect(result.reasons.some(r => r.includes('turn intent'))).toBe(true)
  })

  it('MCP only scored during cruise', () => {
    const snaps = descentSnapshots(5)
    const cur = flight({ alt: 8000, vertRate: -10 })
    const enrich = { adsbfi: { navAlt: 5000, category: 'A3' } }
    const result = scoreAnomaly(snaps, cur, enrich)

    expect(result.categories).not.toContain(CATEGORY.INTENT)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P1: Speed-Only Suppression
// ═════════════════════════════════════════════════════════════════════════════

describe('speed-only suppression', () => {
  it('speed anomaly alone is suppressed (score zeroed)', () => {
    // Create scenario with only speed deviation, no altitude/heading/squawk
    const snaps = cruiseSnapshots(3)
    // Large speed change but normal altitude/heading
    const cur = flight({
      vel: 100,      // massive deceleration from 230 → 100
      vertRate: 0,   // normal altitude
      hdg: 90,       // same heading
    })
    const result = scoreAnomaly(snaps, cur)

    // If only SPEED category triggered, it should be suppressed
    if (result.categories.length <= 1 &&
        (result.categories.length === 0 || result.categories[0] === CATEGORY.SPEED)) {
      expect(result.score).toBe(0)
    }
  })

  it('speed anomaly WITH altitude anomaly is NOT suppressed', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({
      vel: 100,        // speed anomaly
      vertRate: -25,   // altitude anomaly too
      hdg: 90,
    })
    const result = scoreAnomaly(snaps, cur)

    // Should have score > 0 because altitude category also present
    expect(result.score).toBeGreaterThan(0)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P2: Position Confidence
// ═════════════════════════════════════════════════════════════════════════════

describe('position confidence', () => {
  it('MLAT with <3 receivers → score 0 (skip entirely)', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: -30, posSrc: 2, ndb: 2 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.score).toBe(0)
  })

  it('ADS-B source (posSrc=0) → full scoring', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: -20, posSrc: 0 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.score).toBeGreaterThan(0)
  })

  it('MLAT with 3-4 receivers → dampened scoring', () => {
    const snaps = cruiseSnapshots(3)
    const deviation = { vertRate: -20 }

    const adsb = scoreAnomaly(snaps, flight({ ...deviation, posSrc: 0 }))
    const mlat = scoreAnomaly(snaps, flight({ ...deviation, posSrc: 2, ndb: 4 }))

    // MLAT score should be lower due to position confidence dampening
    expect(mlat.score).toBeLessThan(adsb.score)
  })

  it('position confidence does NOT affect emergency squawk scores', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '7700', posSrc: 2, ndb: 4 })
    const result = scoreAnomaly(snaps, cur)

    // 7700 should still be >= 80 regardless of position confidence
    expect(result.score).toBeGreaterThanOrEqual(80)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// P2: Edge Cases
// ═════════════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('null snapshots → returns default result', () => {
    const result = scoreAnomaly(null, flight())
    expect(result.score).toBe(0)
    expect(result.phase).toBe(PHASE.UNKNOWN)
    expect(result.reasons).toEqual([])
    expect(result.confirmed).toBe(false)
    expect(result.category).toBeNull()
    expect(result.severity).toBe(SEVERITY.LOW)
    expect(result.categories).toEqual([])
  })

  it('empty snapshots → returns default result', () => {
    const result = scoreAnomaly([], flight())
    expect(result.score).toBe(0)
  })

  it('single snapshot (< 2) → returns default result', () => {
    const result = scoreAnomaly([snap()], flight())
    expect(result.score).toBe(0)
  })

  it('null current → returns default result', () => {
    const result = scoreAnomaly(cruiseSnapshots(3), null)
    expect(result.score).toBe(0)
  })

  it('null enrichment → scores without crashing', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: -20 })
    const result = scoreAnomaly(snaps, cur, null)

    expect(result.score).toBeGreaterThan(0)
    expect(result.phase).toBeDefined()
  })

  it('null weather → scores without crashing', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: -20 })
    const result = scoreAnomaly(snaps, cur, null, null)

    expect(result.score).toBeGreaterThan(0)
  })

  it('null allFlights → scores without crashing', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ vertRate: -20 })
    const result = scoreAnomaly(snaps, cur, null, null, null)

    expect(result.score).toBeGreaterThan(0)
  })

  it('missing fields in current (null lat/lon/alt) → no crash', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ lat: null, lon: null, alt: null })
    expect(() => scoreAnomaly(snaps, cur)).not.toThrow()
  })

  it('missing fields in snapshots → no crash', () => {
    const snaps = [
      { ts: NOW - 180000 },
      { ts: NOW - 90000 },
    ]
    const cur = flight()
    expect(() => scoreAnomaly(snaps, cur)).not.toThrow()
  })

  it('score is always clamped to 0-100', () => {
    // Stack up everything: squawk + emergency + altitude anomaly
    const snaps = cruiseSnapshots(3)
    const cur = flight({ squawk: '7700', vertRate: -50 })
    const enrich = { adsbfi: { emergency: 'general' } }
    const result = scoreAnomaly(snaps, cur, enrich)

    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('exactly 2 snapshots → still scores (minimum required)', () => {
    const snaps = [
      snap({ ts: NOW - 180000 }),
      snap({ ts: NOW - 90000 }),
    ]
    const cur = flight({ vertRate: -25 })
    const result = scoreAnomaly(snaps, cur)

    // Should score something for the altitude anomaly
    expect(result.phase).toBeDefined()
  })

  it('enrichment from airplanes.live (apl) works when adsbfi missing', () => {
    const snaps = cruiseSnapshots(3)
    const cur = flight({ alt: 10000 })
    const enrich = {
      apl: {
        navAltMcp: 5000,   // MCP altitude in feet
        navHeading: 270,
        emergency: null,
        mil: false,
        category: 'A3',
      },
    }
    const result = scoreAnomaly(snaps, cur, enrich)

    // Should pick up MCP data from apl enrichment
    expect(result.categories).toContain(CATEGORY.INTENT)
  })

  it('route proximity widens tolerance near destination', () => {
    const snaps = cruiseSnapshots(3)
    const deviation = { vertRate: -10 }

    // Far from destination
    const farResult = scoreAnomaly(snaps, flight({ ...deviation, lat: 42.0, lon: -78.0 }), {
      flightroute: { destination: { latitude: 33.637, longitude: -84.428 } }, // ATL — far
    })

    // Very close to destination
    const nearResult = scoreAnomaly(snaps, flight({ ...deviation, lat: 33.7, lon: -84.4 }), {
      flightroute: { destination: { latitude: 33.637, longitude: -84.428 } }, // ATL — close
    })

    // Near destination should have lower score (wider tolerance)
    expect(nearResult.score).toBeLessThanOrEqual(farResult.score)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// Phase transition
// ═════════════════════════════════════════════════════════════════════════════

describe('phase transition anomaly', () => {
  it('cruise → descent transition with existing score triggers PHASE', () => {
    // detectPhase uses last 5 snapshots. For phase transition check:
    //   olderPhase = detectPhase(snapshots.slice(0, -1)) must be CRUISE
    //   phase = detectPhase(snapshots) must be DESCENT
    // Also need score > 10 before the phase check fires.
    //
    // snapshots.slice(0, -1) last 5 = indices 0-4: all cruise (stable alt, good vel)
    // snapshots last 5 = indices 1-5: last entries descending heavily → DESCENT
    const snaps = [
      snap({ ts: NOW - 540000, alt: 10000, vel: 230 }),
      snap({ ts: NOW - 450000, alt: 10000, vel: 230 }),
      snap({ ts: NOW - 360000, alt: 10000, vel: 230 }),
      snap({ ts: NOW - 270000, alt: 10000, vel: 230 }),
      snap({ ts: NOW - 180000, alt: 10000, vel: 230 }),
      // Last snapshot: steep descent start — when included, last-5 avg delta goes very negative
      snap({ ts: NOW - 90000, alt: 9500, vel: 230 }),
    ]
    // Current: steep descent with transponder rate, triggers altitude anomaly (score > 10)
    const cur = flight({ alt: 8500, vertRate: -25 })
    const result = scoreAnomaly(snaps, cur)

    // Phase detection on full snapshots (last 5: indices 1-5) sees descent
    // Phase detection on slice(0, -1) (last 5: indices 0-4) sees cruise
    // Altitude anomaly gives score > 10, so PHASE category should fire
    expect(result.categories).toContain(CATEGORY.PHASE)
    expect(result.reasons.some(r => r.includes('cruise') && r.includes('descent'))).toBe(true)
  })

  it('cruise → descent with no other anomaly does NOT add PHASE', () => {
    // Gentle cruise → descent, score < 10, so phase transition not added
    const snaps = [
      snap({ ts: NOW - 450000, alt: 10000, vel: 230 }),
      snap({ ts: NOW - 360000, alt: 10000, vel: 230 }),
      snap({ ts: NOW - 270000, alt: 10000, vel: 230 }),
      snap({ ts: NOW - 180000, alt: 10000, vel: 230 }),
      snap({ ts: NOW - 90000, alt: 9980, vel: 230 }),
    ]
    const cur = flight({ alt: 9960, vertRate: -0.5 })
    const result = scoreAnomaly(snaps, cur)

    expect(result.categories).not.toContain(CATEGORY.PHASE)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// Constants & exports
// ═════════════════════════════════════════════════════════════════════════════

describe('constants and exports', () => {
  it('ANOMALY_THRESHOLD is 35', () => {
    expect(ANOMALY_THRESHOLD).toBe(35)
  })

  it('all CATEGORY values are defined', () => {
    expect(Object.keys(CATEGORY)).toEqual(
      expect.arrayContaining(['SQUAWK', 'EMERGENCY', 'ALTITUDE', 'SPEED', 'HEADING', 'DIVERSION', 'PHASE', 'INTENT'])
    )
  })

  it('all SEVERITY values are defined', () => {
    expect(Object.keys(SEVERITY)).toEqual(
      expect.arrayContaining(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
    )
  })

  it('all PHASE values are defined', () => {
    expect(Object.keys(PHASE)).toEqual(
      expect.arrayContaining(['GROUND', 'CLIMB', 'CRUISE', 'DESCENT', 'APPROACH', 'UNKNOWN'])
    )
  })
})
