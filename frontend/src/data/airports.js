// Top 50 US airports — coordinates for map plotting and route visualization
// Sourced from backend/anomaly.js AIRPORTS constant
const AIRPORTS = {
  KATL: { lat: 33.637, lon: -84.428, city: 'Atlanta', state: 'GA' },
  KLAX: { lat: 33.943, lon: -118.408, city: 'Los Angeles', state: 'CA' },
  KDFW: { lat: 32.897, lon: -97.038, city: 'Dallas-Fort Worth', state: 'TX' },
  KDEN: { lat: 39.852, lon: -104.673, city: 'Denver', state: 'CO' },
  KORD: { lat: 41.974, lon: -87.907, city: "Chicago O'Hare", state: 'IL' },
  KJFK: { lat: 40.641, lon: -73.778, city: 'New York JFK', state: 'NY' },
  KMCO: { lat: 28.429, lon: -81.309, city: 'Orlando', state: 'FL' },
  KLAS: { lat: 36.084, lon: -115.152, city: 'Las Vegas', state: 'NV' },
  KCLT: { lat: 35.214, lon: -80.943, city: 'Charlotte', state: 'NC' },
  KMIA: { lat: 25.796, lon: -80.287, city: 'Miami', state: 'FL' },
  KSEA: { lat: 47.449, lon: -122.309, city: 'Seattle', state: 'WA' },
  KEWR: { lat: 40.693, lon: -74.169, city: 'Newark', state: 'NJ' },
  KSFO: { lat: 37.619, lon: -122.379, city: 'San Francisco', state: 'CA' },
  KPHX: { lat: 33.434, lon: -112.012, city: 'Phoenix', state: 'AZ' },
  KIAH: { lat: 29.984, lon: -95.341, city: 'Houston IAH', state: 'TX' },
  KBOS: { lat: 42.366, lon: -71.010, city: 'Boston', state: 'MA' },
  KFLL: { lat: 26.073, lon: -80.153, city: 'Fort Lauderdale', state: 'FL' },
  KMSP: { lat: 44.882, lon: -93.222, city: 'Minneapolis', state: 'MN' },
  KLGA: { lat: 40.777, lon: -73.873, city: 'New York LGA', state: 'NY' },
  KDTW: { lat: 42.212, lon: -83.353, city: 'Detroit', state: 'MI' },
  KBWI: { lat: 39.176, lon: -76.669, city: 'Baltimore', state: 'MD' },
  KDCA: { lat: 38.852, lon: -77.038, city: 'Washington DCA', state: 'VA' },
  KIAD: { lat: 38.945, lon: -77.456, city: 'Washington IAD', state: 'VA' },
  KPHL: { lat: 39.872, lon: -75.241, city: 'Philadelphia', state: 'PA' },
  KSLC: { lat: 40.788, lon: -111.978, city: 'Salt Lake City', state: 'UT' },
  KSAN: { lat: 32.734, lon: -117.190, city: 'San Diego', state: 'CA' },
  KBNA: { lat: 36.124, lon: -86.678, city: 'Nashville', state: 'TN' },
  KAUS: { lat: 30.195, lon: -97.670, city: 'Austin', state: 'TX' },
  KRDU: { lat: 35.880, lon: -78.788, city: 'Raleigh-Durham', state: 'NC' },
  KTPA: { lat: 27.975, lon: -82.533, city: 'Tampa', state: 'FL' },
  KSTL: { lat: 38.748, lon: -90.370, city: 'St. Louis', state: 'MO' },
  KPIT: { lat: 40.492, lon: -80.233, city: 'Pittsburgh', state: 'PA' },
  KPDX: { lat: 45.589, lon: -122.597, city: 'Portland', state: 'OR' },
  KMSY: { lat: 29.993, lon: -90.258, city: 'New Orleans', state: 'LA' },
  KMCI: { lat: 39.298, lon: -94.714, city: 'Kansas City', state: 'MO' },
  KCLE: { lat: 41.412, lon: -81.850, city: 'Cleveland', state: 'OH' },
  KSAT: { lat: 29.534, lon: -98.470, city: 'San Antonio', state: 'TX' },
  KIND: { lat: 39.717, lon: -86.294, city: 'Indianapolis', state: 'IN' },
  KSDF: { lat: 38.174, lon: -85.736, city: 'Louisville', state: 'KY' },
  KCVG: { lat: 39.049, lon: -84.668, city: 'Cincinnati', state: 'OH' },
  KOAK: { lat: 37.721, lon: -122.221, city: 'Oakland', state: 'CA' },
  KSJC: { lat: 37.362, lon: -121.929, city: 'San Jose', state: 'CA' },
  KSMF: { lat: 38.695, lon: -121.591, city: 'Sacramento', state: 'CA' },
  KHNL: { lat: 21.319, lon: -157.922, city: 'Honolulu', state: 'HI' },
  KHOU: { lat: 29.645, lon: -95.279, city: 'Houston Hobby', state: 'TX' },
  KMDW: { lat: 41.786, lon: -87.752, city: 'Chicago Midway', state: 'IL' },
  KDAL: { lat: 32.847, lon: -96.852, city: 'Dallas Love', state: 'TX' },
  KRSW: { lat: 26.536, lon: -81.755, city: 'Fort Myers', state: 'FL' },
  KPBI: { lat: 26.683, lon: -80.096, city: 'West Palm Beach', state: 'FL' },
  KABQ: { lat: 35.040, lon: -106.609, city: 'Albuquerque', state: 'NM' },
}

export default AIRPORTS

export function getAirportCoords(icao) {
  return AIRPORTS[icao] || null
}

export function getAirportLabel(icao) {
  const ap = AIRPORTS[icao]
  return ap ? `${icao.replace(/^K/, '')} — ${ap.city}` : icao?.replace(/^K/, '') || '?'
}
