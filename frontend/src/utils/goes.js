// ── GOES-16/18 geostationary satellite tile helpers (v5.5.0) ───────────────
// Pure URL builders. The CDN is public, CORS-allowed, and served from
// cdn.star.nesdis.noaa.gov — no API key, no backend proxy required.
//
// Sector abbreviations per NESDIS:
//   GOES-16 (East) — ne / se / umv / nr / sr / gm / taw / cam / pr
//   GOES-18 (West) — psw / pnw / hi / ak / ...
//
// We pick a satellite + sector from the aircraft's lat/lon. A single best-fit
// picture is better than three sectors that only overlap by 50 km.

const GOES_CDN = 'https://cdn.star.nesdis.noaa.gov'

// Sector lookup by [latMin, latMax, lonMin, lonMax] → { sat, sector, label }.
// Ordered from most-specific to most-general so the first match wins.
const SECTORS = [
  // GOES-18 (West — covers Pacific + western CONUS)
  { name: 'Hawaii',              sat: 'GOES18', sector: 'hi',   bbox: [17, 24, -162, -152] },
  { name: 'Alaska',              sat: 'GOES18', sector: 'ak',   bbox: [48, 72, -175, -128] },
  { name: 'Pacific Northwest',   sat: 'GOES18', sector: 'pnw',  bbox: [40, 52, -130, -110] },
  { name: 'Pacific Southwest',   sat: 'GOES18', sector: 'psw',  bbox: [27, 42, -125, -108] },

  // GOES-16 (East — covers CONUS + Atlantic)
  { name: 'Northern Rockies',    sat: 'GOES16', sector: 'nr',   bbox: [37, 50, -117, -96] },
  { name: 'Southern Rockies',    sat: 'GOES16', sector: 'sr',   bbox: [28, 42, -115, -96] },
  { name: 'Upper Miss Valley',   sat: 'GOES16', sector: 'umv',  bbox: [37, 50, -100, -82] },
  { name: 'Southern Miss Valley',sat: 'GOES16', sector: 'smv',  bbox: [28, 42, -100, -82] },
  { name: 'Northeast',           sat: 'GOES16', sector: 'ne',   bbox: [36, 50, -85,  -65] },
  { name: 'Southeast',           sat: 'GOES16', sector: 'se',   bbox: [24, 40, -92,  -70] },
  { name: 'Gulf of Mexico',      sat: 'GOES16', sector: 'gm',   bbox: [18, 32, -98,  -78] },
  { name: 'Puerto Rico',         sat: 'GOES16', sector: 'pr',   bbox: [16, 22, -70,  -62] },
  { name: 'Tropical Atlantic',   sat: 'GOES16', sector: 'taw',  bbox: [10, 30, -85,  -55] },
]

const GOES16_CONUS = { name: 'CONUS',           sat: 'GOES16', sector: 'CONUS' }  // fallback
const GOES16_FD    = { name: 'Full Disk',       sat: 'GOES16', sector: 'FD'    }  // wider fallback

function inBbox(lat, lon, [s, n, w, e]) {
  return lat >= s && lat <= n && lon >= w && lon <= e
}

export function pickSector(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return GOES16_CONUS
  for (const s of SECTORS) if (inBbox(lat, lon, s.bbox)) return s
  // If in CONUS-ish but no specific sector matched, fall back to CONUS.
  if (lat >= 20 && lat <= 55 && lon >= -130 && lon <= -60) return GOES16_CONUS
  // Otherwise hit the full disk (covers the hemisphere).
  return GOES16_FD
}

// Build the image URL for a given sector + band. Default band GEOCOLOR gives
// the enhanced-color true-color-with-IR-overlay image most people expect.
export function goesImageUrl({ sat, sector }, { band = 'GEOCOLOR', res = '1200x1200' } = {}) {
  // CONUS/FD live under /ABI/<sector>/, sector views under /ABI/SECTOR/<sector>/.
  const base = (sector === 'CONUS' || sector === 'FD')
    ? `${GOES_CDN}/${sat}/ABI/${sector}/${band}`
    : `${GOES_CDN}/${sat}/ABI/SECTOR/${sector}/${band}`
  return `${base}/latest.jpg`
}

// Helper for the animation loop URL (NESDIS animation page).
export function goesLoopUrl({ sat, sector }) {
  const g = sat === 'GOES16' ? 'G16' : sat === 'GOES18' ? 'G18' : 'G16'
  return `https://www.star.nesdis.noaa.gov/GOES/sector_band.php?sat=${g}&sector=${sector}&band=GEOCOLOR&length=24`
}
