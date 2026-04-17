// ── Unified aircraft search client (v5.6.0) ───────────────────────────────
// Thin client over /api/search. Debounce is handled by the caller because
// the render cadence depends on the UI.

import axios from 'axios'

const TIMEOUT = 6_000

export async function searchAircraft(q, { limit = 10 } = {}) {
  if (!q || q.trim().length < 2) return { q, total: 0, results: [] }
  const res = await axios.get('/api/search', {
    params: { q, limit }, timeout: TIMEOUT,
  })
  return res.data
}
