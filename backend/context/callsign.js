// ── Callsign pattern tags ───────────────────────────────────────────────────
// v2.0.0 — Certain callsign prefixes are reserved / strongly associated with
// specific mission types. These are used as priors in the inference engine.
// Not 100% reliable (civilian callsigns can overlap), but high signal.

const PREFIXES = [
  // Medical / humanitarian
  { re: /^(LIFEGUARD|LGD|MED\d|MEDEVAC|AIRMED|MEDSTAR)/i, tag: 'medevac',    confidence: 0.95 },
  { re: /^(ANGEL|FLYING DOCTOR|FLD)/i,                     tag: 'medevac',    confidence: 0.70 },
  // SAR / USCG
  { re: /^(RESCUE|SAR|COAST GUARD|CG\d|USCG)/i,           tag: 'search_rescue', confidence: 0.95 },
  { re: /^RSCU/i,                                          tag: 'search_rescue', confidence: 0.85 },
  // Law-enforcement / border
  { re: /^(POLICE|POL\d|LAW|SHERIFF)/i,                    tag: 'law_enforcement', confidence: 0.90 },
  { re: /^(CBP|OMAHA|HAMMER)/i,                            tag: 'cbp_air',        confidence: 0.85 },
  { re: /^(DEA\d|FBI\d|ATF\d|MARSHAL)/i,                   tag: 'federal_lea',    confidence: 0.90 },
  // Firefighting
  { re: /^(TANKER|AIRTAK|FIRE|LEAD|COPTR|BAT\d)/i,         tag: 'firefighting',   confidence: 0.80 },
  // Military identifiers
  { re: /^(RCH|REACH|SAM\d|AF\d|AF1|NAVY|ARMY|MARINE|CNV|EVAC|RAIDR|GRIM|LOBO|DOOM|HUNTR)/i,
    tag: 'military', confidence: 0.85 },
  // Executive / VIP
  { re: /^(AF1|AIRFORCE ONE|EXEC\d|VENUS|VM\d)/i,          tag: 'vip_exec',       confidence: 0.90 },
  // News / media helicopters. Two paths:
  //   1. N-number suffix on a registration that ends in a network's letters.
  //      Anchored with $ so we don't catch N5NCK, N1234ABCD, etc. Dropped
  //      "NC" — too generic (it's not a real network suffix; it just looks
  //      like one and produced false positives like N48NC, N123NC).
  //   2. Spoken on-air callsigns most US metro stations actually use.
  //      Most media helos register under LLC owners, so the registration
  //      itself rarely names the network — the on-air callsign does.
  { re: /^N\d{1,4}(TV|CBS|ABC|NBC|FOX|CNN)$/i,             tag: 'news_media',     confidence: 0.85 },
  { re: /^(CHOPPER|SKY|EYEWITNESS|AIRBUS|NEWSCOPTER|TRAFFIC)\s*\d+/i,
                                                            tag: 'news_media',     confidence: 0.80 },
  // No `\b` — station call letters often run straight into digits (KCAL9,
  // FOX5HD, etc.) and `\b` doesn't fire between a letter and a digit.
  { re: /^(KCAL|KTLA|KABC|KCBS|KNBC|WABC|WCBS|WNBC|WPIX|WNYW|WJLA|WTSP|WTVF|WSVN|WPLG|WGN|WHDH|WMAQ|WLFL|WFAA|WFTV|WXIA|FOX5|FOX11|FOX29|FOX31)/i,
                                                            tag: 'news_media',     confidence: 0.95 },
  // Survey / mapping
  { re: /^(SURVEY|MAPPER|GEO\d)/i,                         tag: 'survey',         confidence: 0.75 },
]

// 7500/7600/7700 squawks are IATA emergency codes — definitive.
const EMERGENCY_SQUAWK = {
  '7500': { tag: 'hijack',        confidence: 1.0, severity: 'critical' },
  '7600': { tag: 'radio_failure', confidence: 1.0, severity: 'critical' },
  '7700': { tag: 'emergency',     confidence: 1.0, severity: 'critical' },
}

function classifyCallsign(callsign) {
  if (!callsign) return []
  const cs = callsign.trim().toUpperCase()
  const hits = []
  for (const { re, tag, confidence } of PREFIXES) {
    if (re.test(cs)) hits.push({ tag, confidence, source: 'callsign_prefix' })
  }
  return hits
}

function classifySquawk(squawk) {
  if (!squawk) return null
  const s = String(squawk).padStart(4, '0')
  return EMERGENCY_SQUAWK[s] || null
}

module.exports = { classifyCallsign, classifySquawk }
