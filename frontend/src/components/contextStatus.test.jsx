import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { swimState } = vi.hoisted(() => ({ swimState: { value: {} } }))
vi.mock('../contexts/SwimContext', () => ({ useSwim: () => swimState.value }))
vi.mock('./FlightMap', () => ({ default: () => null }))
import NasPanel from './NasPanel'
import { ContextEvidence } from './ContextPanel'
import FlightInspector from './FlightInspectorModal'
import DetailPanel from './DetailPanel'

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props))
const metric = (html, label) => html.match(new RegExp(`<dt>${label}</dt><dd[^>]*>(.*?)</dd>`))?.[1]

describe('aircraft context evidence', () => {
  it('does not present global volcano alerts as matches for a distant flight', () => {
    const html = render(ContextEvidence, {
      icao: 'abc123', ctx: { inferences: [], nearby: { volcanoAlerts: { alerts: [{ name: 'Great Sitkin' }, { name: 'Kilauea' }] } } },
    })
    expect(html).toContain('No signals')
    expect(html).not.toContain('Great Sitkin')
    expect(html).not.toContain('Kilauea')
    expect(html).not.toContain('matches')
  })

  it('shows the distance-qualified volcano and signal count without counting its context twice', () => {
    const html = render(ContextEvidence, {
      icao: 'abc123', ctx: {
        inferences: [{ label: 'volcano_vicinity', confidence: 0.85, reasons: ['Within 150 km'] }],
        nearby: { volcanoNear: { name: 'Kilauea', vnum: '1', alertLevel: 'WATCH', colorCode: 'ORANGE', observatory: 'HVO', distanceKm: 25 } },
      },
    })
    expect(html).toContain('1 signal')
    expect(html).not.toContain('2 signals')
    expect(html).toContain('Kilauea')
    expect(html).toContain('25.0 km')
  })

  it('labels nearby events as context rather than corroborated intent', () => {
    const html = render(ContextEvidence, {
      icao: 'abc123', ctx: { nearby: { events: { events: [{ id: 'fire1', title: 'Nearby fire', distanceKm: 180 }] }, quakes: { quakes: [{ id: 'q1', mag: 3, place: 'Nearby quake', distanceKm: 400 }] } } },
    })
    expect(html).toContain('Nearby context')
    expect(html).toContain('Nearby fire')
    expect(html).toContain('Nearby quake')
    expect(html).toContain('they do not establish this flight&#x27;s purpose')
    expect(html).not.toContain('2 signals')
  })

  it('keeps failed and pending checks distinct from a verified absence of signals', () => {
    expect(render(ContextEvidence, { loading: true })).toContain('Checking')
    expect(render(ContextEvidence, { error: 'Failed' })).toContain('Unavailable')
    expect(render(ContextEvidence, { error: 'Failed' })).not.toContain('No signals')
  })
})

describe('NAS metric availability', () => {
  beforeEach(() => { swimState.value = { status: {}, wakeState: {}, availability: {} } })

  it('does not turn missing feeds into zeros when one source is available', () => {
    swimState.value.status = { workerConnected: true, tfms: { active_gs: 2, active_gdps: 0 } }
    const html = render(NasPanel, { backendOk: true })
    expect(metric(html, 'Ground stops')).toBe('2')
    expect(metric(html, 'Delay programs')).toBe('0')
    expect(metric(html, 'Active TFRs')).toBe('—')
    expect(metric(html, 'Congestion')).toBe('—')
  })

  it('preserves an explicit zero rather than falling back to an older count', () => {
    swimState.value = { status: { tfms: { active_gs: 9, active_gdps: 8 }, notams: { active_tfrs: 0 } }, nasSummary: { groundStops: 0, gdps: 0, congestionBuilding: 0 } }
    const html = render(NasPanel, { backendOk: true })
    for (const label of ['Ground stops', 'Delay programs', 'Active TFRs', 'Congestion']) expect(metric(html, label)).toBe('0')
  })

  it('keeps known values visible during reconnection and labels the delay', () => {
    swimState.value = { status: { workerConnected: false }, nasSummary: { groundStops: 2 }, availability: { fastError: 'One request failed' } }
    const html = render(NasPanel, { backendOk: true })
    expect(html).toContain('Feeds delayed')
    expect(metric(html, 'Ground stops')).toBe('2')
    expect(metric(html, 'Active TFRs')).toBe('—')
  })

  it('shows unknown metrics before the first verified snapshot', () => {
    const html = render(NasPanel, { backendOk: true })
    for (const label of ['Ground stops', 'Delay programs', 'Active TFRs', 'Congestion']) expect(metric(html, label)).toBe('—')
  })
})

describe('personal FlightAware credentials', () => {
  const props = {
    flight: { icao: 'abc123', callsign: 'UAL123', src: 'opensky' }, flights: [],
    aeroCache: {}, aeroSpend: { cap_reached: true, total_spend: 5, cap: 5 },
    trackHistory: [], backendOk: true,
  }

  it('keeps the server cap visible for server-funded requests', () => {
    const html = render(FlightInspector, props)
    expect(html).toContain('FlightAware limit reached')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?FlightAware limit reached/)
  })

  it('allows the personal-key lookup even when the owner cap is reached', () => {
    const html = render(FlightInspector, { ...props, userAeroKey: 'test-personal-key' })
    expect(html).toContain('Get FlightAware lifecycle')
    expect(html).not.toContain('FlightAware limit reached')
  })

  it('uses the same rule in the compact detail panel', () => {
    expect(render(DetailPanel, props)).toContain('cap reached')
    expect(render(DetailPanel, { ...props, userAeroKey: 'test-personal-key' })).not.toContain('cap reached')
  })
})
