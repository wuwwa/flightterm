import axios from 'axios'

export const REGIONS = {
  global:   { lat: 30,  lon: 0,   bbox: null },
  usa:      { lat: 37,  lon: -95, bbox: { lamin: 24,  lomin: -125, lamax: 49.5, lomax: -66  } },
  europe:   { lat: 52,  lon: 15,  bbox: { lamin: 35,  lomin: -10,  lamax: 71,   lomax: 40   } },
  asia:     { lat: 35,  lon: 110, bbox: { lamin: 10,  lomin: 70,   lamax: 55,   lomax: 145  } },
  atlantic: { lat: 40,  lon: -40, bbox: { lamin: 10,  lomin: -70,  lamax: 60,   lomax: -10  } },
}

export async function fetchStates(region = 'global') {
  const reg = REGIONS[region]
  const params = reg.bbox ? { ...reg.bbox } : {}

  const response = await axios.get('/api/opensky/states', { params })
  const states = response.data?.states || []

  return states.map(s => ({
    icao:     (s[0] || '').trim(),
    callsign: (s[1] || '').trim() || '—',
    country:  s[2] || 'unknown',
    lon:      s[5]  != null ? parseFloat(s[5].toFixed(4))  : null,
    lat:      s[6]  != null ? parseFloat(s[6].toFixed(4))  : null,
    alt:      s[7]  != null ? Math.round(s[7])              : null,
    grounded: s[8]  ?? false,
    vel:      s[9]  != null ? parseFloat(s[9].toFixed(1))  : null,
    hdg:      s[10] != null ? Math.round(s[10])             : null,
    mil:      false,
    src:      'opensky',
  }))
}
