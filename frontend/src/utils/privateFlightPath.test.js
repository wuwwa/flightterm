import { describe, it, expect } from 'vitest'
import { observedPaths, projectedPath, routePath, mapLine } from './privateFlightPath'

const at = minute => `2026-09-10T12:${String(minute).padStart(2, '0')}:00Z`
const point = (minute, extra = {}) => ({ lat: 40, lon: -80 + minute / 10, sampledAt: at(minute), ...extra })

describe('private flight paths', () => {
  it('orders positions and never includes future frames', () => {
    const paths = observedPaths([point(10), point(0), point(5), point(20)], at(10))
    expect(paths).toEqual([[[40, -80], [40, -79.5], [40, -79]]])
  })
  it('breaks gaps without connecting missing coverage', () => {
    expect(observedPaths([point(0), point(5), point(40), point(45)], at(45))).toHaveLength(2)
  })
  it('discards previous flights at a ground observation', () => {
    expect(observedPaths([point(0), point(5, { grounded: true }), point(10), point(15)], at(15)))
      .toEqual([[[40, -79], [40, -78.5]]])
  })
  it('rejects missing coordinates, duplicate timestamps and impossible jumps', () => {
    expect(observedPaths([point(0), point(5, { lat: null }), point(10), point(10), point(11, { lon: 20 })], at(11)))
      .toEqual([[[40, -80], [40, -79]]])
  })
  it('allows sparse recorded tracks with a separate gap threshold', () => {
    expect(observedPaths([point(0), point(30)], at(30), 45)).toHaveLength(1)
    expect(observedPaths([point(0), point(30)], at(30))).toHaveLength(0)
  })
  it('projects ten minutes from ground speed and heading, including heading zero', () => {
    const path = projectedPath({ lat: 0, lon: 0, heading: 0, speedKt: 360 })
    expect(path).toHaveLength(21)
    expect(path.at(-1)[0]).toBeCloseTo(1, 2)
    expect(path.at(-1)[1]).toBeCloseTo(0)
  })
  it('does not invent a projection for missing heading or speed', () => {
    expect(projectedPath({ lat: 40, lon: -80, heading: null, speedKt: 400 })).toEqual([])
    expect(projectedPath({ lat: 40, lon: -80, heading: 90, speedKt: null })).toEqual([])
    expect(projectedPath(null)).toEqual([])
  })
  it('takes the short path across the date line', () => {
    expect(mapLine([{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }])).toEqual([[0, 179], [0, 181]])
    const path = projectedPath({ lat: 0, lon: 179.8, heading: 90, speedKt: 600 })
    expect(path.at(-1)[1]).toBeGreaterThan(180)
    expect(path.at(-1)[1]).toBeLessThan(182)
  })
  it('curves long destination estimates along the globe and retains endpoints', () => {
    const path = routePath([{ lat: 40, lon: -75 }, { lat: 50, lon: 0 }])
    expect(path.length).toBeGreaterThan(20)
    expect(path[0][0]).toBeCloseTo(40)
    expect(path.at(-1)).toEqual([50, 0])
    expect(Math.max(...path.map(p => p[0]))).toBeGreaterThan(50)
  })
})
