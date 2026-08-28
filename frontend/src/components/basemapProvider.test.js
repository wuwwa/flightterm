import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

const MAP_COMPONENTS = [
  './FlightMap.jsx',
  './BusinessJetTracker.jsx',
  './tfms/AirportBoard.jsx',
  './tfms/TfmsMap.jsx',
  './dashboard/HeatMap.jsx',
  './dashboard/NasMap.jsx',
]

describe('keyless basemap provider', () => {
  it('uses the shared OpenFreeMap layer everywhere instead of CARTO raster tiles', () => {
    for (const component of MAP_COMPONENTS) {
      const source = readSource(component)

      expect(source, component).toContain('<OpenFreeMapLayer')
      expect(source, component).not.toContain('cartocdn.com')
      expect(source, component).not.toContain('attributionControl={false}')
    }
  })

  it('uses the keyless dark style and includes the required attribution', () => {
    const source = readSource('./OpenFreeMapLayer.jsx')

    expect(source).toContain('https://tiles.openfreemap.org/styles/dark')
    expect(source).toContain('OpenMapTiles')
    expect(source).toContain('OpenStreetMap')
  })
})
