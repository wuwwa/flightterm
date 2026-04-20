const { classifyEntity, TYPE_REGISTRANT } = require('./entity')

describe('classifyEntity', () => {
  it('returns empty tags when no faaReg is attached', () => {
    expect(classifyEntity({})).toEqual({ tags: [], owner: null })
    expect(classifyEntity({ faaReg: null })).toEqual({ tags: [], owner: null })
  })

  it('emits entity:individual for type 1', () => {
    const r = classifyEntity({ faaReg: { type_registrant: 1, owner_name: 'JOHN Q PILOT' } })
    expect(r.tags).toEqual(['entity:individual'])
    expect(r.owner).toBe('JOHN Q PILOT')
  })

  it('emits entity:corp for type 3', () => {
    expect(classifyEntity({ faaReg: { type_registrant: 3, owner_name: 'ACME AVIATION INC' } }).tags).toEqual(['entity:corp'])
  })

  it('emits entity:llc for type 7', () => {
    expect(classifyEntity({ faaReg: { type_registrant: 7, owner_name: 'FALCON LANDING LLC' } }).tags).toEqual(['entity:llc'])
  })

  it('emits entity:government for type 5', () => {
    expect(classifyEntity({ faaReg: { type_registrant: 5, owner_name: 'US GOVERNMENT DEPARTMENT' } }).tags).toEqual(['entity:government'])
  })

  it('collapses types 8 and 9 into entity:noncitizen', () => {
    expect(classifyEntity({ faaReg: { type_registrant: 8 } }).tags).toEqual(['entity:noncitizen'])
    expect(classifyEntity({ faaReg: { type_registrant: 9 } }).tags).toEqual(['entity:noncitizen'])
  })

  it('stacks entity:trust on top of a primary type when owner name looks like a trust', () => {
    const r = classifyEntity({ faaReg: { type_registrant: 3, owner_name: 'BANK OF UTAH TRUSTEE' } })
    expect(r.tags).toContain('entity:corp')
    expect(r.tags).toContain('entity:trust')
  })

  it('detects plain TRUST owners', () => {
    const r = classifyEntity({ faaReg: { type_registrant: 1, owner_name: 'WILSON FAMILY TRUST' } })
    expect(r.tags).toContain('entity:trust')
  })

  it('does not over-match TRUST inside unrelated words', () => {
    // \b word-boundary prevents "TRUSTED" from matching
    const r = classifyEntity({ faaReg: { type_registrant: 3, owner_name: 'TRUSTED AVIATION CORP' } })
    expect(r.tags).not.toContain('entity:trust')
  })

  it('handles unknown registrant codes gracefully', () => {
    const r = classifyEntity({ faaReg: { type_registrant: 99, owner_name: 'SOMETHING' } })
    expect(r.tags).toEqual([])
    expect(r.owner).toBe('SOMETHING')
  })

  it('exports the TYPE_REGISTRANT mapping for reuse', () => {
    expect(TYPE_REGISTRANT[1]).toBe('individual')
    expect(TYPE_REGISTRANT[7]).toBe('llc')
  })
})
