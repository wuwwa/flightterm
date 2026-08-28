import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

describe('flight inspector record layout', () => {
  it('keeps aircraft and route details in one readable sidebar column', () => {
    const component = readSource('./FlightInspectorModal.jsx')
    const styles = readSource('../index.css')

    expect(component).toContain('className="flight-inspector__record-grid"')
    expect(component).not.toContain('xl:col-span-2')
    expect(styles).toMatch(/\.flight-inspector__record-grid\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s)
    expect(styles).toMatch(/\.inspector-record-row\s*{[^}]*min-height:\s*30px/s)
  })
})
