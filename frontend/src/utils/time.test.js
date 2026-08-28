import { describe, expect, it } from 'vitest'
import { formatLocalTime, localTimeZone, localTimeZoneLabel, TIME_MODES } from './time'

describe('local time formatting', () => {
  it('formats valid timestamps with browser locale settings', () => {
    expect(formatLocalTime('2026-08-28T12:34:56.000Z')).toMatch(/\d{2}:\d{2}/)
    expect(formatLocalTime('2026-08-28T12:34:56.000Z')).toContain(localTimeZoneLabel('2026-08-28T12:34:56.000Z'))
    expect(formatLocalTime('not-a-date')).toBe('—')
    expect(localTimeZone()).toBeTruthy()
  })

  it('supports an explicit UTC display preference', () => {
    const timestamp = '2026-08-28T12:34:56.000Z'
    expect(formatLocalTime(timestamp, { mode: TIME_MODES.UTC })).toContain('UTC')
    expect(localTimeZoneLabel(timestamp, TIME_MODES.UTC)).toBe('UTC')
  })
})
