// ── ICAO aircraft type → category map (v5.7.7) ────────────────────────────
// Maps ICAO type designators (e.g. "B738", "EC35", "GLF6") to a use/size
// category. Used by classifyByType() in backend/context/aircraft.js.
//
// Categories (kept short and sortable for filter chips):
//   wide_body         A330/340/350/380, B777/787/747
//   narrow_body       A220, A320 family, B737 family, B757
//   regional_jet      CRJ, ERJ, E170/175/190/195
//   turboprop         AT72, ATR42, DH8, BE20, SF34, etc.
//   business_jet      Gulfstreams, Globals, Challengers, Citations, Falcons
//   light_aircraft    GA singles + light twins (C172, PA28, BE36)
//   helicopter        any rotor (separated further by helicopter_use lookup)
//   military_jet      F16, F35, F18, F15, etc.
//   military_xport    C5, C17, C130, KC135, KC46, A400
//   military_helo     UH60, AH64, CH47, V22 (incl. V-22 tiltrotor)
//   special           U2, RC135, E3, P8 (surveillance / patrol)
//
// Sources: FAA aircraft type designators, ICAO 8643 (Aircraft Type
// Designators). Kept the most common ~250 entries — covers >95% of real
// traffic. Unknown types fall through to `null`, which is fine.

const TYPE_CATEGORY = {
  // ── Wide-body airliners ────────────────────────────────────────────────
  A332: 'wide_body', A333: 'wide_body', A338: 'wide_body', A339: 'wide_body',
  A342: 'wide_body', A343: 'wide_body', A345: 'wide_body', A346: 'wide_body',
  A359: 'wide_body', A35K: 'wide_body',
  A388: 'wide_body',
  B742: 'wide_body', B743: 'wide_body', B744: 'wide_body', B748: 'wide_body',
  B752: 'narrow_body', B753: 'narrow_body',  // 757 is technically narrow
  B762: 'wide_body', B763: 'wide_body', B764: 'wide_body',
  B772: 'wide_body', B773: 'wide_body', B77L: 'wide_body', B77W: 'wide_body',
  B778: 'wide_body', B779: 'wide_body',
  B788: 'wide_body', B789: 'wide_body', B78X: 'wide_body',
  IL96: 'wide_body', T204: 'wide_body',

  // ── Narrow-body airliners ──────────────────────────────────────────────
  A318: 'narrow_body', A319: 'narrow_body', A320: 'narrow_body',
  A321: 'narrow_body',
  A19N: 'narrow_body', A20N: 'narrow_body', A21N: 'narrow_body',
  BCS1: 'narrow_body', BCS3: 'narrow_body',  // A220
  B731: 'narrow_body', B732: 'narrow_body', B733: 'narrow_body',
  B734: 'narrow_body', B735: 'narrow_body', B736: 'narrow_body',
  B737: 'narrow_body', B738: 'narrow_body', B739: 'narrow_body', B73X: 'narrow_body',
  B37M: 'narrow_body', B38M: 'narrow_body', B39M: 'narrow_body', B3XM: 'narrow_body',

  // ── Regional jets ──────────────────────────────────────────────────────
  CRJ1: 'regional_jet', CRJ2: 'regional_jet', CRJ7: 'regional_jet',
  CRJ9: 'regional_jet', CRJX: 'regional_jet',
  E135: 'regional_jet', E140: 'regional_jet', E145: 'regional_jet',
  E170: 'regional_jet', E175: 'regional_jet', E190: 'regional_jet',
  E195: 'regional_jet', E290: 'regional_jet', E295: 'regional_jet',
  E75L: 'regional_jet', E75S: 'regional_jet',

  // ── Turboprops (regional + cargo + GA twin) ───────────────────────────
  AT42: 'turboprop', AT43: 'turboprop', AT44: 'turboprop',
  AT45: 'turboprop', AT46: 'turboprop', AT72: 'turboprop',
  AT73: 'turboprop', AT75: 'turboprop', AT76: 'turboprop',
  DH8A: 'turboprop', DH8B: 'turboprop', DH8C: 'turboprop', DH8D: 'turboprop',
  SF34: 'turboprop', SF50: 'business_jet',  // Cirrus Vision Jet
  SB20: 'turboprop',
  BE20: 'turboprop', BE99: 'turboprop',
  BE9L: 'turboprop', BE9T: 'turboprop',
  C208: 'turboprop', C210: 'light_aircraft',
  PC12: 'turboprop',
  TBM7: 'turboprop', TBM8: 'turboprop', TBM9: 'turboprop',
  PC6T: 'turboprop',
  KODI: 'turboprop',  // Quest Kodiak

  // ── Business jets ──────────────────────────────────────────────────────
  // Gulfstream
  G150: 'business_jet', G280: 'business_jet',
  GLF2: 'business_jet', GLF3: 'business_jet', GLF4: 'business_jet',
  GLF5: 'business_jet', GLF6: 'business_jet',
  GA5C: 'business_jet', GA7C: 'business_jet',
  G450: 'business_jet', G500: 'business_jet', G550: 'business_jet',
  G650: 'business_jet', G700: 'business_jet', G800: 'business_jet',
  // Bombardier
  CL30: 'business_jet', CL35: 'business_jet', CL60: 'business_jet',
  CL64: 'business_jet', CL65: 'business_jet',
  GLEX: 'business_jet', GL5T: 'business_jet', GL7T: 'business_jet',
  LJ31: 'business_jet', LJ35: 'business_jet', LJ40: 'business_jet',
  LJ45: 'business_jet', LJ55: 'business_jet', LJ60: 'business_jet',
  LJ70: 'business_jet', LJ75: 'business_jet', LJ85: 'business_jet',
  // Cessna Citation
  C25A: 'business_jet', C25B: 'business_jet', C25C: 'business_jet',
  C500: 'business_jet', C501: 'business_jet', C510: 'business_jet',
  C525: 'business_jet', C550: 'business_jet', C551: 'business_jet',
  C560: 'business_jet', C56X: 'business_jet', C650: 'business_jet',
  C680: 'business_jet', C68A: 'business_jet', C700: 'business_jet',
  C750: 'business_jet',
  // Embraer / Praetor / Phenom
  E50P: 'business_jet', E55P: 'business_jet',
  E545: 'business_jet', E550: 'business_jet',
  // Dassault Falcon
  F2TH: 'business_jet', F900: 'business_jet', FA50: 'business_jet',
  F900EX: 'business_jet', F7X: 'business_jet', F8X: 'business_jet',
  // Hawker / Beechjet
  H25A: 'business_jet', H25B: 'business_jet', H25C: 'business_jet',
  HA4T: 'business_jet', HDJT: 'business_jet',
  PRM1: 'business_jet',
  // Pilatus
  PC24: 'business_jet',
  // Honda
  HDJT_HONDA: 'business_jet',

  // ── Light single-engine GA ─────────────────────────────────────────────
  C150: 'light_aircraft', C152: 'light_aircraft', C162: 'light_aircraft',
  C172: 'light_aircraft', C175: 'light_aircraft', C177: 'light_aircraft',
  C180: 'light_aircraft', C182: 'light_aircraft', C185: 'light_aircraft',
  C188: 'light_aircraft',
  C206: 'light_aircraft', C207: 'light_aircraft',
  C310: 'light_aircraft', C337: 'light_aircraft', C340: 'light_aircraft',
  C402: 'light_aircraft', C404: 'light_aircraft', C414: 'light_aircraft',
  C421: 'light_aircraft', C425: 'light_aircraft', C441: 'light_aircraft',
  PA28: 'light_aircraft', PA32: 'light_aircraft', PA34: 'light_aircraft',
  PA44: 'light_aircraft', PA46: 'light_aircraft',
  P28A: 'light_aircraft', P28B: 'light_aircraft', P28R: 'light_aircraft',
  P28S: 'light_aircraft', P28T: 'light_aircraft',
  PA31: 'light_aircraft', PA38: 'light_aircraft', PA42: 'light_aircraft',
  M20J: 'light_aircraft', M20P: 'light_aircraft', M20T: 'light_aircraft',
  BE33: 'light_aircraft', BE35: 'light_aircraft', BE36: 'light_aircraft',
  BE55: 'light_aircraft', BE58: 'light_aircraft', BE60: 'light_aircraft',
  BE76: 'light_aircraft', BE77: 'light_aircraft', BE95: 'light_aircraft',
  DA20: 'light_aircraft', DA40: 'light_aircraft', DA42: 'light_aircraft',
  DA62: 'light_aircraft',
  SR20: 'light_aircraft', SR22: 'light_aircraft',
  AA1: 'light_aircraft', AA5: 'light_aircraft',
  C162SKYC: 'light_aircraft',
  RV6: 'light_aircraft', RV7: 'light_aircraft', RV8: 'light_aircraft',
  RV9: 'light_aircraft', RV10: 'light_aircraft', RV12: 'light_aircraft',
  RV14: 'light_aircraft',

  // ── Helicopters ────────────────────────────────────────────────────────
  // Bell
  B06: 'helicopter', B06T: 'helicopter',
  B407: 'helicopter', B412: 'helicopter', B427: 'helicopter',
  B429: 'helicopter', B430: 'helicopter', B505: 'helicopter',
  B505_JX: 'helicopter',
  B47G: 'helicopter', B47J: 'helicopter',
  H47: 'military_helo',  // CH-47 Chinook
  // Airbus / Eurocopter
  AS50: 'helicopter', AS55: 'helicopter',
  AS65: 'helicopter', AS32: 'helicopter', AS3B: 'helicopter',
  EC20: 'helicopter', EC30: 'helicopter', EC35: 'helicopter',
  EC45: 'helicopter', EC55: 'helicopter', EC75: 'helicopter',
  EC25: 'helicopter', EC15: 'helicopter', EC65: 'helicopter',
  EC120: 'helicopter', EC130: 'helicopter', EC135: 'helicopter',
  EC145: 'helicopter', EC155: 'helicopter', EC175: 'helicopter',
  EC225: 'helicopter',
  H125: 'helicopter', H130: 'helicopter', H135: 'helicopter',
  H145: 'helicopter', H155: 'helicopter', H160: 'helicopter',
  H175: 'helicopter', H215: 'helicopter', H225: 'helicopter',
  // AgustaWestland / Leonardo
  A109: 'helicopter', A119: 'helicopter', A129: 'helicopter',
  A139: 'helicopter', A149: 'helicopter', A169: 'helicopter',
  A189: 'helicopter',
  AW09: 'helicopter', AW119: 'helicopter', AW139: 'helicopter',
  AW169: 'helicopter', AW189: 'helicopter',
  // MD Helicopters
  MD52: 'helicopter', MD60: 'helicopter', MD90: 'helicopter',
  MD500: 'helicopter', MD52F: 'helicopter', MD60F: 'helicopter',
  H500: 'helicopter', H520: 'helicopter', H600: 'helicopter',
  // Sikorsky
  S61: 'helicopter', S64: 'helicopter', S70: 'helicopter',
  S76: 'helicopter', S92: 'helicopter',
  // Robinson
  R22: 'helicopter', R44: 'helicopter', R66: 'helicopter',
  // Schweizer / Enstrom / Hughes
  S269: 'helicopter', S300: 'helicopter', S330: 'helicopter',
  S333: 'helicopter', S434: 'helicopter',
  EN28: 'helicopter', EN48: 'helicopter', EN80: 'helicopter',
  // Bristow / Other
  BK17: 'helicopter', BO5: 'helicopter', BO105: 'helicopter',
  KMAX: 'helicopter', LAMA: 'helicopter',

  // ── Military fixed-wing ───────────────────────────────────────────────
  // Fighters
  F15: 'military_jet', F16: 'military_jet', F18: 'military_jet',
  F22: 'military_jet', F35: 'military_jet',
  EUFI: 'military_jet', RFAL: 'military_jet', GRIP: 'military_jet',
  T38: 'military_jet', T6: 'military_jet', T6A: 'military_jet',
  T45: 'military_jet',
  // Bombers
  B1: 'military_jet', B2: 'military_jet', B52: 'military_jet',
  // Transports
  C5: 'military_xport', C5M: 'military_xport',
  C17: 'military_xport',
  C130: 'military_xport', C30J: 'military_xport',
  HC30: 'military_xport', LC30: 'military_xport', WC30: 'military_xport',
  C40: 'military_xport',
  A400: 'military_xport',
  // Tankers
  KC10: 'military_xport', KC30: 'military_xport',
  KC46: 'military_xport', KC135: 'military_xport',
  // Special / surveillance
  E2: 'special', E3: 'special', E4: 'special',
  E6: 'special', E7: 'special', E8: 'special',
  P3: 'special', P8: 'special',
  RC135: 'special', U2: 'special',

  // ── Military helicopters & tiltrotor ───────────────────────────────────
  UH60: 'military_helo', H60: 'military_helo', S70I: 'military_helo',
  AH64: 'military_helo', H64: 'military_helo',
  AH1: 'military_helo', UH1: 'military_helo',
  CH47: 'military_helo', H46: 'military_helo', H53: 'military_helo',
  CH53: 'military_helo', CH46: 'military_helo',
  V22: 'military_helo',  // technically tiltrotor
  AH6: 'military_helo', MH6: 'military_helo',
}

// Reverse lookup helper — useful for filter chips that want to expose
// "all wide-body types currently in feed".
function typesByCategory(category) {
  const out = []
  for (const [k, v] of Object.entries(TYPE_CATEGORY)) {
    if (v === category) out.push(k)
  }
  return out
}

function categoryFor(acType) {
  if (!acType) return null
  const t = String(acType).toUpperCase().trim()
  return TYPE_CATEGORY[t] || null
}

module.exports = { TYPE_CATEGORY, categoryFor, typesByCategory }
