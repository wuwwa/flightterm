const { classifyFamily, classifyType } = require('./family')

describe('classifyType', () => {
  it('classifies Boeing narrowbodies', () => {
    expect(classifyType('B738')).toEqual({ family: 'b737', class: 'narrowbody', role: 'passenger' })
    expect(classifyType('B737')).toMatchObject({ family: 'b737', class: 'narrowbody' })
    expect(classifyType('B739')).toMatchObject({ family: 'b737', class: 'narrowbody' })
    expect(classifyType('B752')).toMatchObject({ family: 'b757', class: 'narrowbody' })
  })

  it('classifies Airbus narrowbodies', () => {
    expect(classifyType('A320')).toMatchObject({ family: 'a320', class: 'narrowbody' })
    expect(classifyType('A321')).toMatchObject({ family: 'a320', class: 'narrowbody' })
    expect(classifyType('A319')).toMatchObject({ family: 'a320', class: 'narrowbody' })
    expect(classifyType('A220')).toMatchObject({ family: 'a220', class: 'narrowbody' })
  })

  it('classifies widebodies', () => {
    expect(classifyType('B772')).toMatchObject({ family: 'b777', class: 'widebody' })
    expect(classifyType('B77W')).toMatchObject({ family: 'b777', class: 'widebody' })
    expect(classifyType('B789')).toMatchObject({ family: 'b787', class: 'widebody' })
    expect(classifyType('A332')).toMatchObject({ family: 'a330', class: 'widebody' })
    expect(classifyType('A359')).toMatchObject({ family: 'a350', class: 'widebody' })
    expect(classifyType('B748')).toMatchObject({ family: 'b747', class: 'widebody' })
  })

  it('tags freighter variants with role cargo (not passenger)', () => {
    expect(classifyType('B77F')).toMatchObject({ family: 'b777', role: 'cargo' })
    expect(classifyType('B74F')).toMatchObject({ family: 'b747', role: 'cargo' })
    expect(classifyType('B73F')).toMatchObject({ family: 'b737', role: 'cargo' })
    expect(classifyType('B76F')).toMatchObject({ family: 'b767', role: 'cargo' })
  })

  it('classifies regional jets', () => {
    expect(classifyType('CRJ2')).toMatchObject({ family: 'crj', class: 'regional' })
    expect(classifyType('CRJ9')).toMatchObject({ family: 'crj', class: 'regional' })
    expect(classifyType('E175')).toMatchObject({ family: 'e-jet', class: 'regional' })
    expect(classifyType('E190')).toMatchObject({ family: 'e-jet', class: 'regional' })
  })

  it('classifies business jets', () => {
    expect(classifyType('GLF6')).toMatchObject({ family: 'gulfstream', class: 'bizjet' })
    expect(classifyType('C56X')).toMatchObject({ family: 'citation', class: 'bizjet' })
    expect(classifyType('CL60')).toMatchObject({ family: 'challenger', class: 'bizjet' })
    expect(classifyType('F2TH')).toMatchObject({ family: 'falcon', class: 'bizjet' })
    expect(classifyType('LJ75')).toMatchObject({ family: 'learjet', class: 'bizjet' })
  })

  it('classifies helicopters', () => {
    expect(classifyType('EC35')).toMatchObject({ class: 'helo' })
    expect(classifyType('H145')).toMatchObject({ class: 'helo' })
    expect(classifyType('B407')).toMatchObject({ family: 'bell-helo', class: 'helo' })
    expect(classifyType('S76')).toMatchObject({ family: 'sikorsky-helo', class: 'helo' })
    expect(classifyType('R44')).toMatchObject({ family: 'robinson-helo', class: 'helo' })
  })

  it('does not false-match Boeing types as helicopters', () => {
    // This was a real regression: original Bell helo regex swallowed B748/B717.
    expect(classifyType('B748').class).toBe('widebody')
    expect(classifyType('B738').class).toBe('narrowbody')
  })

  it('returns empty object for unknown types', () => {
    expect(classifyType('XX99')).toEqual({})
    expect(classifyType(null)).toEqual({})
    expect(classifyType('')).toEqual({})
  })
})

describe('classifyFamily (flight wrapper)', () => {
  it('wraps classifyType for a flight object', () => {
    expect(classifyFamily({ acType: 'B738' })).toMatchObject({ family: 'b737' })
    expect(classifyFamily({})).toEqual({})
    expect(classifyFamily({ acType: null })).toEqual({})
  })
})
