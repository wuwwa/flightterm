import axios from 'axios'

/**
 * Fetch METARs for specific airports.
 * @param {string[]} ids - ICAO airport codes
 * @returns {Promise<Object[]>} Array of METAR objects
 */
export async function fetchMetars(ids) {
  if (!ids.length) return []
  const res = await axios.get('/api/weather/metar', {
    params: { ids: ids.join(',') },
    timeout: 10000,
  })
  return res.data || []
}

/**
 * Fetch METARs within a bounding box.
 * @param {number} lat0 - SW latitude
 * @param {number} lon0 - SW longitude
 * @param {number} lat1 - NE latitude
 * @param {number} lon1 - NE longitude
 * @returns {Promise<Object[]>}
 */
export async function fetchMetarsBbox(lat0, lon0, lat1, lon1) {
  const res = await axios.get('/api/weather/metar', {
    params: { bbox: `${lat0},${lon0},${lat1},${lon1}` },
    timeout: 10000,
  })
  return res.data || []
}

/**
 * Fetch PIREPs (pilot reports) within a bounding box.
 * @param {number} lat0 - SW latitude
 * @param {number} lon0 - SW longitude
 * @param {number} lat1 - NE latitude
 * @param {number} lon1 - NE longitude
 * @param {Object} opts - { age: hours, inten: 'lgt'|'mod'|'sev' }
 * @returns {Promise<Object[]>}
 */
export async function fetchPireps(lat0, lon0, lat1, lon1, opts = {}) {
  const res = await axios.get('/api/weather/pirep', {
    params: { bbox: `${lat0},${lon0},${lat1},${lon1}`, age: opts.age || 2, ...opts },
    timeout: 10000,
  })
  return res.data || []
}

/**
 * Fetch active SIGMETs/AIRMETs.
 * @param {string} [hazard] - 'conv', 'turb', 'ice', 'ifr'
 * @returns {Promise<Object[]>}
 */
export async function fetchSigmets(hazard) {
  const params = {}
  if (hazard) params.hazard = hazard
  const res = await axios.get('/api/weather/sigmet', { params, timeout: 10000 })
  return res.data || []
}

/**
 * Parse a METAR into a simplified weather summary for anomaly context.
 */
export function summarizeMetar(metar) {
  if (!metar) return null
  const wx = []
  if (metar.fltCat && metar.fltCat !== 'VFR') wx.push(metar.fltCat)
  if (metar.wxString) wx.push(metar.wxString)
  if (metar.wgst && metar.wgst >= 25) wx.push(`gusts ${metar.wgst}kt`)
  else if (metar.wspd && metar.wspd >= 20) wx.push(`wind ${metar.wspd}kt`)
  if (metar.visib && parseFloat(metar.visib) < 3) wx.push(`vis ${metar.visib}SM`)
  return {
    icao: metar.icaoId,
    fltCat: metar.fltCat,
    raw: metar.rawOb,
    summary: wx.length ? wx.join(' · ') : 'VFR',
    hasSevereWx: !!(metar.wxString && /TS|FG|SN|FZRA|GR|FC/.test(metar.wxString)),
    hasLowVis: metar.fltCat === 'IFR' || metar.fltCat === 'LIFR',
    temp: metar.temp,
    wind: { dir: metar.wdir, spd: metar.wspd, gust: metar.wgst },
  }
}

/**
 * Summarize PIREPs into a severity assessment for an area.
 */
export function summarizePireps(pireps) {
  if (!pireps.length) return { count: 0, maxTurbulence: null, maxIcing: null, severe: false }
  const turbLevels = { LGT: 1, 'LGT-MOD': 2, MOD: 3, 'MOD-SEV': 4, SEV: 5, EXTRM: 6 }
  const iceLevels = { NEG: 0, 'NEG-LGT': 0, TRC: 1, 'TRC-LGT': 1, LGT: 2, 'LGT-MOD': 3, MOD: 4, 'MOD-SEV': 5, SEV: 6, HVY: 6 }

  let maxTurb = null, maxTurbVal = 0
  let maxIce = null, maxIceVal = 0

  for (const p of pireps) {
    if (p.tbInt1 && turbLevels[p.tbInt1] > maxTurbVal) {
      maxTurbVal = turbLevels[p.tbInt1]
      maxTurb = `${p.tbInt1}${p.tbType1 ? ' ' + p.tbType1 : ''} FL${p.fltLvl || '???'}`
    }
    if (p.icgInt1 && iceLevels[p.icgInt1] > maxIceVal) {
      maxIceVal = iceLevels[p.icgInt1]
      maxIce = `${p.icgInt1}${p.icgType1 ? ' ' + p.icgType1 : ''} FL${p.fltLvl || '???'}`
    }
  }

  return {
    count: pireps.length,
    maxTurbulence: maxTurb,
    maxIcing: maxIce,
    severe: maxTurbVal >= 5 || maxIceVal >= 5,
  }
}

/**
 * Summarize active SIGMETs.
 */
export function summarizeSigmets(sigmets) {
  if (!sigmets.length) return { count: 0, convective: 0, turbulence: 0, icing: 0, items: [] }
  const items = sigmets.map(s => ({
    type: s.airSigmetType,
    hazard: s.hazard,
    severity: s.severity,
    coords: s.coords,
    validTo: s.validTimeTo,
  }))
  return {
    count: sigmets.length,
    convective: sigmets.filter(s => s.hazard === 'CONVECTIVE').length,
    turbulence: sigmets.filter(s => s.hazard === 'TURB').length,
    icing: sigmets.filter(s => s.hazard === 'ICE').length,
    items,
  }
}
