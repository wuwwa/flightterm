// ── Interesting-flights feed client (v5.2.0) ───────────────────────────────
// Thin wrapper over /api/feed/interesting. Backend does the scoring; this
// returns whatever ranks high enough right now.

import axios from 'axios'

const TIMEOUT = 15_000

export async function fetchInterestingFeed({ limit = 20 } = {}) {
  const res = await axios.get('/api/feed/interesting', {
    params: { limit }, timeout: TIMEOUT,
  })
  return res.data
}
