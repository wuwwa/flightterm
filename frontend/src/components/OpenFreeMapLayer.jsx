import { useEffect } from 'react'
import { useMap } from 'react-leaflet'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'

export const OPENFREEMAP_ATTRIBUTION = [
  '<a href="https://openfreemap.org/">OpenFreeMap</a>',
  '&copy; <a href="https://openmaptiles.org/">OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
].join(' · ')

/**
 * OpenFreeMap's public basemap is vector-only. This adapter keeps the existing
 * Leaflet markers, paths, controls, and interaction while MapLibre renders the
 * keyless dark vector basemap in Leaflet's tile pane.
 */
export default function OpenFreeMapLayer({ opacity = 1 }) {
  const map = useMap()

  useEffect(() => {
    let cancelled = false
    let layer = null

    const addLayer = async () => {
      // Keep MapLibre's rendering engine out of the initial application bundle;
      // it is only needed once a map is actually mounted.
      const [{ maplibreGL }, { setWorkerUrl }] = await Promise.all([
        import('@maplibre/maplibre-gl-leaflet'),
        import('maplibre-gl'),
      ])
      if (cancelled) return

      // MapLibre 6 needs an explicit bundled worker URL under Vite.
      setWorkerUrl(workerUrl)
      layer = maplibreGL({
        style: OPENFREEMAP_STYLE_URL,
        attributionControl: { customAttribution: OPENFREEMAP_ATTRIBUTION },
      }).addTo(map)

      layer.getContainer().style.opacity = String(opacity)
    }

    addLayer().catch(error => {
      console.error('OpenFreeMap basemap failed to initialize:', error)
    })

    return () => {
      cancelled = true
      layer?.remove()
    }
  }, [map, opacity])

  return null
}
