import { describe, it, expect } from 'vitest'
import { activityPlot } from './privateActivityChart'
const sample = (hour, count) => ({ sampledAt: `2026-09-10T${hour}:00Z`, airborneCount: count })

describe('private activity chart', () => {
  it('spaces observations by actual elapsed time and identifies gaps', () => {
    const result = activityPlot([sample('12:00', 5), sample('12:30', 10), sample('14:00', 15)])
    expect(result.points.map(p => p.x)).toEqual([0, 25, 100])
    expect(result.gaps).toEqual([{ left: 25, width: 75 }])
    expect(result.ceiling).toBe(15)
  })
  it('starts at zero and preserves genuine zero observations', () => {
    const result = activityPlot([sample('12:00', 0), sample('12:30', 11)])
    expect(result.ceiling).toBe(15)
    expect(result.points[0].height).toBe(0)
    expect(result.points[1].height).toBeCloseTo(11 / 15 * 100)
  })
  it('omits missing and invalid samples without manufacturing zeroes', () => {
    expect(activityPlot([sample('12:00', null), sample('12:30', -1), sample('13:00', NaN), sample('invalid', 10)]).points).toEqual([])
  })
  it('centers a single observation with a finite scale', () => {
    const result = activityPlot([sample('12:00', 0)])
    expect(result.points[0].x).toBe(50)
    expect(result.ceiling).toBe(5)
    expect(result.gaps).toEqual([])
  })
  it('retains original frame indexes when ordering samples', () => {
    expect(activityPlot([sample('12:30', 10), sample('12:00', 5)]).points.map(p => p.index)).toEqual([1, 0])
  })
})
