// ── Context map client (v5.1.0) ─────────────────────────────────────────────
// Unified bbox fetch for all correlation-layer overlays at once. Callers pass
// a bbox + the set of layers they want; the backend fans out to every adapter
// and returns one JSON bundle.

import axios from 'axios'

const TIMEOUT = 30_000
const CONUS_BBOX = [-125, 24, -66, 50]  // W, S, E, N

export async function fetchMapContext({
  bbox = CONUS_BBOX,
  layers = ['fires', 'events', 'quakes', 'volcanoes', 'webcams'],
} = {}) {
  const res = await axios.get('/api/context/map', {
    params: { bbox: bbox.join(','), layers: layers.join(',') },
    timeout: TIMEOUT,
  })
  return res.data
}

export { CONUS_BBOX }
