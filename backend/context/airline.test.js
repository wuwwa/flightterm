const { classifyAirline, lookupAirlineByIcao } = require('./airline')

describe('classifyAirline', () => {
  it('resolves US majors by callsign prefix', () => {
    expect(classifyAirline({ callsign: 'UAL123' })).toMatchObject({ icao: 'UAL', name: 'United Airlines', source: 'callsign_prefix' })
    expect(classifyAirline({ callsign: 'DAL456' })).toMatchObject({ icao: 'DAL', name: 'Delta Air Lines', source: 'callsign_prefix' })
    expect(classifyAirline({ callsign: 'AAL99' })).toMatchObject({ icao: 'AAL', name: 'American Airlines', source: 'callsign_prefix' })
    expect(classifyAirline({ callsign: 'SWA1' })).toMatchObject({ icao: 'SWA', name: 'Southwest Airlines', source: 'callsign_prefix' })
  })

  it('resolves supplement entries (FDX/UPS/ATN/CKS)', () => {
    expect(classifyAirline({ callsign: 'FDX100' })).toMatchObject({ icao: 'FDX', name: 'FedEx Express' })
    expect(classifyAirline({ callsign: 'UPS82' })).toMatchObject({ icao: 'UPS' })
    expect(classifyAirline({ callsign: 'ATN456' })).toMatchObject({ icao: 'ATN' })
    expect(classifyAirline({ callsign: 'CKS700' })).toMatchObject({ icao: 'CKS', name: 'Kalitta Air' })
  })

  it('ignores N-number registrations as callsigns (GA traffic)', () => {
    expect(classifyAirline({ callsign: 'N123AB' })).toBeNull()
    expect(classifyAirline({ callsign: 'N4567Z' })).toBeNull()
  })

  it('ignores short/malformed callsigns', () => {
    expect(classifyAirline({ callsign: '' })).toBeNull()
    expect(classifyAirline({ callsign: 'UAL' })).toBeNull() // needs digit suffix
    expect(classifyAirline({ callsign: 'X' })).toBeNull()
    expect(classifyAirline({ callsign: null })).toBeNull()
    expect(classifyAirline({})).toBeNull()
  })

  it('returns null when callsign does not match commercial prefix shape', () => {
    // Non-digit-suffix callsigns never reach the ICAO index
    expect(classifyAirline({ callsign: 'SHERIFFSIX' })).toBeNull()
    expect(classifyAirline({ callsign: 'ABC' })).toBeNull()
  })

  it('falls back to acOperator alias when callsign does not match', () => {
    // Tactical callsign, but adsbdb gave us the operator string
    const hit = classifyAirline({ callsign: 'N123FX', acOperator: 'FedEx Express' })
    expect(hit).toMatchObject({ icao: 'FDX', source: 'operator_alias' })
  })

  it('prefers callsign match over operator alias', () => {
    // UAL123 callsign should win even if acOperator is slightly different
    const hit = classifyAirline({ callsign: 'UAL123', acOperator: 'some other string' })
    expect(hit).toMatchObject({ icao: 'UAL', source: 'callsign_prefix' })
  })
})

describe('lookupAirlineByIcao', () => {
  it('finds entries by ICAO code', () => {
    expect(lookupAirlineByIcao('UAL')).toMatchObject({ icao: 'UAL', name: 'United Airlines' })
    expect(lookupAirlineByIcao('ual')).toMatchObject({ icao: 'UAL' })
  })
  it('returns null for unknown codes', () => {
    expect(lookupAirlineByIcao('___')).toBeNull()
    expect(lookupAirlineByIcao(null)).toBeNull()
    expect(lookupAirlineByIcao('')).toBeNull()
  })
})
