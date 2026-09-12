const { filedRoute } = require('./privateFlightPath')
const at = '2026-09-10T12:00:00Z'
const plan = { acid: 'N123', dep_arpt: 'KJFK', arr_arpt: 'KLAX', updated_at: '2026-09-10 11:55:00', route: 'DCT' }

describe('private filed routes', () => {
  it('labels endpoint-only routes as estimates', () => {
    expect(filedRoute(plan, 'N123', at)).toMatchObject({ label: 'Destination estimate', origin: 'KJFK', destination: 'KLAX' })
  })
  it('resolves filed fixes without promising complete procedures', () => {
    const result = filedRoute({ ...plan, route: 'KJFK DCT DEN DCT KLAX' }, 'N123', at)
    expect(result.label).toBe('Filed fixes')
    expect(result.points.length).toBeGreaterThan(2)
  })
  it('rejects old, future, missing and mismatched plans', () => {
    expect(filedRoute(null, 'N123', at)).toBeNull()
    expect(filedRoute(plan, 'N456', at)).toBeNull()
    expect(filedRoute({ ...plan, updated_at: '2026-09-10 08:00:00' }, 'N123', at)).toBeNull()
    expect(filedRoute({ ...plan, updated_at: '2026-09-10 13:00:00' }, 'N123', at)).toBeNull()
  })
  it('rejects completed flights and unresolved airports', () => {
    expect(filedRoute({ ...plan, ata: at }, 'N123', at)).toBeNull()
    expect(filedRoute({ ...plan, flight_status: 'CANCELLED' }, 'N123', at)).toBeNull()
    expect(filedRoute({ ...plan, arr_arpt: 'ZZZZ' }, 'N123', at)).toBeNull()
  })
})
