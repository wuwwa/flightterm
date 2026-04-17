// ── US volcano coordinates keyed by Smithsonian GVP vnum ────────────────────
// v5.1.1 — bug_018 — The USGS HANS elevated-alerts feed returns `vnum` but
// not lat/lon. This table pairs the active US volcanoes we care about with
// coordinates so correlation.js can join alerts to nearby aircraft.
//
// Sources: Smithsonian Global Volcanism Program + USGS volcano-observatory
// pages. Update if new volcanoes go into alert status.

module.exports = {
  // ── Alaska Volcano Observatory (AVO) ───────────────────────────
  '311120': { name: 'Great Sitkin',     lat: 52.075,  lon: -176.130 },
  '311360': { name: 'Shishaldin',       lat: 54.756,  lon: -163.970 },
  '311060': { name: 'Cleveland',        lat: 52.825,  lon: -169.944 },
  '311190': { name: 'Semisopochnoi',    lat: 51.929,  lon:  179.586 },
  '311240': { name: 'Pavlof',           lat: 55.420,  lon: -161.894 },
  '311020': { name: 'Akutan',           lat: 54.134,  lon: -165.986 },
  '313030': { name: 'Mount Spurr',      lat: 61.299,  lon: -152.251 },
  '313010': { name: 'Redoubt',          lat: 60.485,  lon: -152.742 },
  '313020': { name: 'Iliamna',          lat: 60.032,  lon: -153.090 },
  '313040': { name: 'Augustine',        lat: 59.363,  lon: -153.430 },
  '312160': { name: 'Veniaminof',       lat: 56.198,  lon: -159.392 },
  '311310': { name: 'Okmok',            lat: 53.397,  lon: -168.166 },
  '311110': { name: 'Kanaga',           lat: 51.923,  lon: -177.168 },
  '311130': { name: 'Korovin',          lat: 52.381,  lon: -174.154 },
  '311290': { name: 'Makushin',         lat: 53.891,  lon: -166.923 },
  '312030': { name: 'Mount Wrangell',   lat: 62.006,  lon: -144.019 },
  '313160': { name: 'Bogoslof',         lat: 53.930,  lon: -168.034 },

  // ── Cascades Volcano Observatory (CVO) ─────────────────────────
  '321050': { name: 'Mount St. Helens', lat: 46.200,  lon: -122.188 },
  '321040': { name: 'Mount Rainier',    lat: 46.853,  lon: -121.760 },
  '321030': { name: 'Glacier Peak',     lat: 48.112,  lon: -121.114 },
  '321020': { name: 'Mount Baker',      lat: 48.777,  lon: -121.814 },
  '322010': { name: 'Mount Hood',       lat: 45.374,  lon: -121.695 },
  '322170': { name: 'Newberry',         lat: 43.722,  lon: -121.229 },
  '323080': { name: 'Mount Shasta',     lat: 41.409,  lon: -122.195 },
  '323090': { name: 'Lassen Peak',      lat: 40.492,  lon: -121.508 },
  '323100': { name: 'Long Valley',      lat: 37.700,  lon: -118.870 },
  '322090': { name: 'Three Sisters',    lat: 44.133,  lon: -121.767 },

  // ── Hawaiian Volcano Observatory (HVO) ─────────────────────────
  '332010': { name: 'Kilauea',          lat: 19.421,  lon: -155.287 },
  '332020': { name: 'Mauna Loa',        lat: 19.475,  lon: -155.608 },
  '332030': { name: 'Hualalai',         lat: 19.692,  lon: -155.870 },
  '332040': { name: 'Loihi',            lat: 18.920,  lon: -155.270 },
  '332050': { name: 'Haleakala',        lat: 20.708,  lon: -156.253 },
}
