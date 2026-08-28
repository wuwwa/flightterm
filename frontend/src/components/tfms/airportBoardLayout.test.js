import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.join(import.meta.dirname, 'AirportBoard.jsx'), 'utf8')

describe('NAS airport flight board layout', () => {
  it('keeps full flight codes visible and explains relative ETA/ETD times', () => {
    expect(source).toContain("min-w-[5.5rem] shrink-0 whitespace-nowrap")
    expect(source).toContain('label: m > 0 ? `in ${m}m` : `${Math.abs(m)}m ago`')
    expect(source).toContain('lg:grid-cols-[minmax(320px,1fr)_minmax(320px,1fr)_280px]')
    expect(source).toContain('flex w-10 shrink-0 justify-end tabular-nums')
  })
})
