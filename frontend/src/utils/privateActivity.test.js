import { describe, it, expect } from 'vitest'
import { segmentedPath, sampleState, sampleAge, comparable } from './privateActivity'
import recording from '../data/privateRecording.json'

describe('private observation presentation', () => {
  it('does not join unobserved intervals or convert null to zero', () => {
    const x = n => n / 60000
    const y = n => n
    const points = [{ at: 0, count: 2 }, { at: 1800000, count: 3 }, { at: 3600000, count: null }, { at: 5400000, count: 4 }, { at: 10800000, count: 5 }]
    expect(segmentedPath(points, x, y, 'count')).toBe('M0.0,2.0 L30.0,3.0 M90.0,4.0 M180.0,5.0')
  })
  it('ages saved data even when HTTP requests succeed', () => {
    const now = Date.parse('2026-09-10T12:00:00Z')
    expect(sampleState('2026-08-23T00:29:00Z', now)).toBe('saved')
    expect(sampleAge('2026-09-10T11:58:00Z', now)).toBe('Updated 2 min ago')
    expect(sampleState(null, now)).toBe('warming')
  })
  it('bundles real ordered recording frames with internally consistent counts', () => {
    expect(recording.frames.length).toBeGreaterThan(2)
    for (let i = 0; i < recording.frames.length; i++) {
      const frame = recording.frames[i]
      expect(frame.airborneCount).toBe(frame.positions.length)
      expect(frame.sampledAt.startsWith('2026-08-21')).toBe(true)
      if (i) expect(new Date(frame.sampledAt).getTime()).toBeGreaterThan(new Date(recording.frames[i - 1].sampledAt).getTime())
    }
  })
  it('does not compare across a recording gap', () => {
    const frame = recording.frames[0]
    expect(comparable(frame, { ...frame, sampledAt: '2026-08-23T12:00:00Z' })).toBe(false)
  })
})
