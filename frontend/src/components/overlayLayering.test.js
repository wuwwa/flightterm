import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

describe('map and record overlay layering', () => {
  it('contains Leaflet pane z-indexes within each map', () => {
    const css = readSource('../index.css')
    const rule = css.match(/\.leaflet-container\s*\{([^}]*)\}/s)

    expect(rule?.[1]).toMatch(/isolation:\s*isolate/)
    expect(rule?.[1]).toMatch(/z-index:\s*0/)
  })

  it('keeps flight records above application content', () => {
    expect(readSource('./FlightDossier.jsx')).toContain('z-[1200]')
    expect(readSource('./GroupDossier.jsx')).toContain('z-[1200]')
    expect(readSource('../App.jsx')).toContain('z-[1200] flex flex-col')
  })
})
