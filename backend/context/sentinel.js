// ── Sentinel Hub (Copernicus Dataspace) ────────────────────────────────────
// v2.0.0 — OAuth2 client-credentials flow. We don't render imagery server-side
// — instead we mint a bearer token and hand it to the frontend, which uses it
// to hit the Sentinel WMS endpoint directly. Tokens are 30-min TTL; we refresh
// 2 min early to avoid races.

const axios = require('axios')

const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token'
const WMS_BASE = 'https://sh.dataspace.copernicus.eu/ogc/wms'

const CLIENT_ID = process.env.SENTINEL_CLIENT_ID
const CLIENT_SECRET = process.env.SENTINEL_CLIENT_SECRET

let _cached = null  // { token, expiresAt }

async function getToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('SENTINEL_CLIENT_ID / SENTINEL_CLIENT_SECRET not set')
  }
  if (_cached && Date.now() < _cached.expiresAt) return _cached.token

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  })
  const res = await axios.post(TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  })
  const expiresIn = res.data?.expires_in ?? 1800
  _cached = {
    token: res.data.access_token,
    expiresAt: Date.now() + (expiresIn - 120) * 1000,
  }
  return _cached.token
}

// Returns both the token (so client can set Authorization: Bearer) and a
// ready-made WMS base URL. Client builds the GetMap call with its own bbox
// + layer (TRUE_COLOR / NDVI / etc.).
async function fetchAccess() {
  const token = await getToken()
  return {
    token,
    expiresInSec: Math.max(0, Math.floor((_cached.expiresAt - Date.now()) / 1000)),
    wmsBase: WMS_BASE,
    note: 'GET ' + WMS_BASE + '/{INSTANCE_ID} with Authorization: Bearer <token>',
  }
}

module.exports = { fetchAccess, getToken }
