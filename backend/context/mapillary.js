// ── Mapillary street-level imagery ──────────────────────────────────────────
// v2.0.0 — Graph API. Used to visually corroborate what's at the ground point
// an aircraft is orbiting over. The API rejects large bboxes — we cap at a
// few hundred meters on each side, which is enough for a street scene.

const axios = require('axios')
const { radiusBbox } = require('./geo')

const TOKEN = process.env.MAPILLARY_ACCESS_TOKEN
const BASE = 'https://graph.mapillary.com/images'
const CACHE = new Map()
const TTL_MS = 60 * 60_000

async function fetchNearest({ lat, lon, radiusKm = 0.2, limit = 3 } = {}) {
  if (!TOKEN) return { error: 'MAPILLARY_ACCESS_TOKEN not set', images: [] }
  const bbox = radiusBbox(lat, lon, Math.min(radiusKm, 0.5))
  const cacheKey = bbox.map(v => v.toFixed(4)).join(',')
  const hit = CACHE.get(cacheKey)
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v

  try {
    const res = await axios.get(BASE, {
      params: {
        access_token: TOKEN,
        fields: 'id,thumb_1024_url,computed_geometry,captured_at,is_pano',
        bbox: bbox.map(v => v.toFixed(6)).join(','),
        limit,
      },
      timeout: 4000,
    })
    const images = (res.data?.data || []).map(img => ({
      id: img.id,
      thumb: img.thumb_1024_url,
      coordinates: img.computed_geometry?.coordinates, // [lon, lat]
      capturedAt: img.captured_at ? new Date(img.captured_at).toISOString() : null,
      isPano: img.is_pano,
    }))
    const out = { count: images.length, images }
    CACHE.set(cacheKey, { t: Date.now(), v: out })
    return out
  } catch (err) {
    return { error: err.response?.data?.error?.message || err.message, images: [] }
  }
}

module.exports = { fetchNearest }
