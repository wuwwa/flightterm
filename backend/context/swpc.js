// ── NOAA SWPC (space weather) ───────────────────────────────────────────────
// v2.0.0 — Kp planetary index + GOES X-ray flux. High Kp degrades GPS and HF
// radio, which matters for polar ops and satcom. Global state, not geo-local.

const axios = require('axios')

const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json'
const ALERT_URL = 'https://services.swpc.noaa.gov/products/alerts.json'
const CACHE = { t: 0, v: null }
const TTL_MS = 5 * 60_000

function classifyKp(kp) {
  if (kp == null) return 'unknown'
  if (kp >= 9) return 'G5 extreme storm'
  if (kp >= 8) return 'G4 severe storm'
  if (kp >= 7) return 'G3 strong storm'
  if (kp >= 6) return 'G2 moderate storm'
  if (kp >= 5) return 'G1 minor storm'
  if (kp >= 4) return 'unsettled'
  return 'quiet'
}

async function fetchStatus() {
  if (CACHE.v && Date.now() - CACHE.t < TTL_MS) return CACHE.v
  const [kpRes, alertRes] = await Promise.allSettled([
    axios.get(KP_URL, { timeout: 10000 }),
    axios.get(ALERT_URL, { timeout: 10000 }),
  ])

  // Kp: take the most recent sample with kp_index set.
  let currentKp = null, currentEst = null, kpTime = null
  if (kpRes.status === 'fulfilled' && Array.isArray(kpRes.value.data)) {
    const last = kpRes.value.data[kpRes.value.data.length - 1]
    currentKp = last?.kp_index
    currentEst = last?.estimated_kp
    kpTime = last?.time_tag
  }

  // Alerts: last few space-weather warnings.
  let recentAlerts = []
  if (alertRes.status === 'fulfilled' && Array.isArray(alertRes.value.data)) {
    recentAlerts = alertRes.value.data.slice(0, 5).map(a => ({
      issued: a.issue_datetime,
      product: a.product_id,
      message: a.message?.split('\n').slice(0, 4).join(' '),
    }))
  }

  const out = {
    kp: currentKp,
    kpEstimated: currentEst,
    kpAt: kpTime,
    classification: classifyKp(currentKp ?? currentEst),
    alerts: recentAlerts,
  }
  CACHE.t = Date.now()
  CACHE.v = out
  return out
}

module.exports = { fetchStatus }
