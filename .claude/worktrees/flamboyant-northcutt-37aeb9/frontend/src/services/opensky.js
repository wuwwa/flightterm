import axios from 'axios'

export const REGIONS = {
  global:   { lat: 30,  lon: 0,   bbox: null },
  usa:      { lat: 37,  lon: -95, bbox: { lamin: 24,  lomin: -125, lamax: 49.5, lomax: -66  } },
  europe:   { lat: 52,  lon: 15,  bbox: { lamin: 35,  lomin: -10,  lamax: 71,   lomax: 40   } },
  asia:     { lat: 35,  lon: 110, bbox: { lamin: 10,  lomin: 70,   lamax: 55,   lomax: 145  } },
  atlantic: { lat: 40,  lon: -40, bbox: { lamin: 10,  lomin: -70,  lamax: 60,   lomax: -10  } },
}

export async function fetchStates(region = 'global', userKeys = {}) {
  const reg = REGIONS[region]
  const params = reg.bbox ? { ...reg.bbox } : {}
  const headers = {}
  if (userKeys.osClientId) headers['x-user-os-id'] = userKeys.osClientId
  if (userKeys.osClientSecret) headers['x-user-os-secret'] = userKeys.osClientSecret

  const response = await axios.get('/api/opensky/states', { params, headers })
  const states = response.data?.states || []
  const credits = response.data?._credits || null

  const flights = states.map(s => ({
    icao:     (s[0] || '').trim(),
    callsign: (s[1] || '').trim() || '—',
    country:  s[2] || 'unknown',
    lon:      s[5]  != null ? parseFloat(s[5].toFixed(4))  : null,
    lat:      s[6]  != null ? parseFloat(s[6].toFixed(4))  : null,
    alt:      s[7]  != null ? Math.round(s[7])              : null,
    grounded: s[8]  ?? false,
    vel:      s[9]  != null ? parseFloat(s[9].toFixed(1))  : null,
    hdg:      s[10] != null ? Math.round(s[10])             : null,
    vertRate: s[11] != null ? parseFloat(s[11].toFixed(1)) : null,
    geoAlt:   s[13] != null ? Math.round(s[13])             : null,
    squawk:   s[14] || null,
    posSrc:   s[16] ?? 0,   // 0=ADS-B, 1=ASTERIX, 2=MLAT, 3=FLARM
    ndb:      s[17] ?? null, // number of receivers
    mil:      false,
    src:      'opensky',
  }))

  return { flights, credits }
}
