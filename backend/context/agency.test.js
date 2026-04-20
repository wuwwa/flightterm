const { classifyAgency } = require('./agency')

describe('classifyAgency', () => {
  it('tags USAF callsigns', () => {
    expect(classifyAgency({ callsign: 'RCH456' }).tags).toContain('gov:usaf')
    expect(classifyAgency({ callsign: 'REACH99' }).tags).toContain('gov:usaf')
    expect(classifyAgency({ callsign: 'SAM123' }).tags).toContain('gov:usaf')
    expect(classifyAgency({ callsign: 'AF1' }).tags).toContain('gov:usaf')
  })

  it('tags Coast Guard callsigns', () => {
    expect(classifyAgency({ callsign: 'CG1723' }).tags).toContain('gov:uscg')
    expect(classifyAgency({ callsign: 'USCG6001' }).tags).toContain('gov:uscg')
  })

  it('tags CBP callsigns', () => {
    expect(classifyAgency({ callsign: 'CBP204' }).tags).toContain('gov:cbp')
    expect(classifyAgency({ callsign: 'OMAHA9' }).tags).toContain('gov:cbp')
  })

  it('tags police/law enforcement callsigns', () => {
    expect(classifyAgency({ callsign: 'POLICE1' }).tags).toContain('gov:police')
    expect(classifyAgency({ callsign: 'SHERIFF5' }).tags).toContain('gov:police')
  })

  it('adds gov:military umbrella tag when mil flag is set', () => {
    const r = classifyAgency({ callsign: 'UNKNOWN', mil: true })
    expect(r.tags).toContain('gov:military')
  })

  it('emits branch + military when both apply', () => {
    const r = classifyAgency({ callsign: 'RCH456', mil: true })
    expect(r.tags).toContain('gov:usaf')
    expect(r.tags).toContain('gov:military')
  })

  it('returns empty tags for civilian callsigns', () => {
    expect(classifyAgency({ callsign: 'UAL123', mil: false }).tags).toEqual([])
    expect(classifyAgency({ callsign: 'N628TS' }).tags).toEqual([])
  })

  it('handles missing/empty fields gracefully', () => {
    expect(classifyAgency({}).tags).toEqual([])
    expect(classifyAgency({ callsign: null }).tags).toEqual([])
  })

  it('does not over-match DEA prefix on civilian callsigns like DEAL', () => {
    // DEA rule requires a digit after: /^(DEA)\d/
    expect(classifyAgency({ callsign: 'DEALOIL' }).tags).toEqual([])
    expect(classifyAgency({ callsign: 'DEA12' }).tags).toContain('gov:dea')
  })
})
