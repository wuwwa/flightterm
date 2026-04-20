const { assignGroups } = require('./groups')

describe('assignGroups', () => {
  it('combines airline + family + class + role tags', () => {
    const r = assignGroups({ callsign: 'UAL123', acType: 'B738' })
    expect(r.groups).toContain('airline:ual')
    expect(r.groups).toContain('family:b737')
    expect(r.groups).toContain('class:narrowbody')
    expect(r.groups).toContain('role:passenger')
    expect(r.airline).toMatchObject({ icao: 'UAL' })
  })

  it('tags cargo correctly', () => {
    const r = assignGroups({ callsign: 'FDX100', acType: 'B77F', acOperator: 'FedEx' })
    expect(r.groups).toContain('airline:fdx')
    expect(r.groups).toContain('family:b777')
    expect(r.groups).toContain('role:cargo')
  })

  it('tags military', () => {
    const r = assignGroups({ callsign: 'RCH456', acType: 'C17', mil: true })
    expect(r.groups).toContain('gov:usaf')
    expect(r.groups).toContain('gov:military')
    expect(r.airline).toBeNull()
  })

  it('returns empty groups for truly unknown flight', () => {
    const r = assignGroups({ callsign: '', acType: null, mil: false })
    expect(r.groups).toEqual([])
    expect(r.airline).toBeNull()
  })

  it('never returns undefined groups (invariant for filtering)', () => {
    const r = assignGroups({})
    expect(Array.isArray(r.groups)).toBe(true)
  })

  it('stacks multiple tags on one flight', () => {
    // Delta widebody freighter (hypothetical but parses cleanly)
    const r = assignGroups({ callsign: 'DAL998', acType: 'B77F' })
    expect(r.groups.length).toBeGreaterThanOrEqual(3)
  })

  it('includes entity:* tag when faaReg is attached', () => {
    const r = assignGroups({
      callsign: 'N123AB',
      acType: 'GLF6',
      faaReg: { type_registrant: 7, owner_name: 'FALCON LANDING LLC' },
    })
    expect(r.groups).toContain('entity:llc')
    expect(r.owner).toBe('FALCON LANDING LLC')
  })

  it('combines airline + entity when both apply', () => {
    // NetJets fleet — commercial callsign + LLC owner
    const r = assignGroups({
      callsign: 'EJA505',
      acType: 'C56X',
      faaReg: { type_registrant: 7, owner_name: 'NETJETS AVIATION INC' },
    })
    expect(r.groups).toContain('airline:eja')
    expect(r.groups).toContain('entity:llc')
  })
})
