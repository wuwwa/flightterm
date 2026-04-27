import axios from 'axios'

/**
 * Fetch NOTAMs for a list of ICAO airport codes
 * @param {string[]} codes - e.g. ['KJFK', 'KLAX']
 * @returns {{ notams: { [code]: Array }, cached: number, fetched: number }}
 */
export async function fetchNotams(codes) {
  if (!codes || codes.length === 0) return { notams: {}, cached: 0, fetched: 0 }
  const res = await axios.get('/api/notams', {
    params: { locations: codes.join(',') },
  })
  return res.data
}
