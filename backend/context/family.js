// Aircraft family / class classifier.
// Maps the ICAO type designator (e.g. "B738", "A320", "EC35") into a handful
// of overlapping group tags: family (b737 / a320 / crj / ...), class (widebody
// / narrowbody / regional / bizjet / helo / prop), and role (cargo when the
// airframe is a dedicated freighter variant).

// Each entry: [ICAO type prefix regex, family, class, role?]
// Order matters — first match wins. More specific entries come before generic.
const RULES = [
  // ─── Boeing widebodies ───────────────────────────────────────────────────
  // Freighter variants first so they don't get swallowed by the passenger regex.
  { re: /^B74F/i, family: 'b747', class: 'widebody', role: 'cargo' },
  { re: /^B74[78]/i, family: 'b747', class: 'widebody', role: 'passenger' },
  { re: /^B77F/i, family: 'b777', class: 'widebody', role: 'cargo' },
  { re: /^B77[2LW7]/i, family: 'b777', class: 'widebody', role: 'passenger' },
  { re: /^B76F/i,    family: 'b767', class: 'widebody', role: 'cargo' },
  { re: /^B76[2-4]/i, family: 'b767', class: 'widebody', role: 'passenger' },
  { re: /^B78[7-9X]/i, family: 'b787', class: 'widebody', role: 'passenger' },

  // ─── Airbus widebodies ───────────────────────────────────────────────────
  { re: /^A3[34][0-9]/i, family: 'a330', class: 'widebody', role: 'passenger' },
  { re: /^A35[0-9]/i,    family: 'a350', class: 'widebody', role: 'passenger' },
  { re: /^A38[0-9]/i,    family: 'a380', class: 'widebody', role: 'passenger' },

  // ─── Narrowbodies ────────────────────────────────────────────────────────
  // Specific B737/B757 families — separate so B752 doesn't get swept into b737.
  { re: /^B73F/i,        family: 'b737', class: 'narrowbody', role: 'cargo' },
  { re: /^B73[2-9]/i,    family: 'b737', class: 'narrowbody', role: 'passenger' },
  { re: /^B75[0-9]/i,    family: 'b757', class: 'narrowbody', role: 'passenger' },
  { re: /^A31[89]/i,     family: 'a320', class: 'narrowbody', role: 'passenger' },
  { re: /^A32[012]/i,    family: 'a320', class: 'narrowbody', role: 'passenger' },
  { re: /^A22[01]/i,     family: 'a220', class: 'narrowbody', role: 'passenger' },

  // ─── Regional jets ───────────────────────────────────────────────────────
  { re: /^CRJ[0-9]/i, family: 'crj',  class: 'regional', role: 'passenger' },
  { re: /^E17[05]|^E19[05]/i, family: 'e-jet', class: 'regional', role: 'passenger' },
  { re: /^E45|^E13[05]/i,     family: 'e-jet', class: 'regional', role: 'passenger' },
  { re: /^E29[0-9]/i, family: 'e-jet', class: 'regional', role: 'passenger' },

  // ─── Turboprops (regional + cargo) ──────────────────────────────────────
  { re: /^DH8[A-D]/i, family: 'dash8', class: 'prop', role: 'passenger' },
  { re: /^AT[4-7][2356]/i, family: 'atr', class: 'prop', role: 'passenger' },
  { re: /^C208/i, family: 'caravan', class: 'prop', role: 'utility' },
  { re: /^SF34|^SB20/i, family: 'saab', class: 'prop', role: 'passenger' },

  // ─── Business jets ───────────────────────────────────────────────────────
  { re: /^GLF[2-8]|^GLEX|^G[45][0-9][0-9]/i, family: 'gulfstream', class: 'bizjet' },
  { re: /^GALX/i, family: 'gulfstream', class: 'bizjet' },
  { re: /^BCS[13]/i, family: 'a220', class: 'narrowbody' },
  { re: /^CL[236][0-9]|^CL60/i, family: 'challenger', class: 'bizjet' },
  { re: /^C25[0-9]|^C5[056]|^C68[0-9]|^C7[05]/i, family: 'citation', class: 'bizjet' },
  { re: /^E5[05]|^E55[0-9]/i, family: 'legacy', class: 'bizjet' },
  { re: /^PC12|^PC24/i, family: 'pilatus', class: 'bizjet' },
  { re: /^F900|^F2TH|^F7X|^FA[27]X|^FA50|^FA8X|^F10/i, family: 'falcon', class: 'bizjet' },
  { re: /^HA4[0-9]|^BE40|^PRM1/i, family: 'hawker', class: 'bizjet' },
  { re: /^LJ[3-9][0-9]/i, family: 'learjet', class: 'bizjet' },

  // ─── Helicopters (most common ICAO types) ────────────────────────────────
  { re: /^EC[1-7][0-9]|^AS[3-5][0-9]|^H1[0-3][0-9]|^H145|^H155|^H160|^H175|^H215|^H225/i,
    family: 'airbus-helo', class: 'helo' },
  { re: /^(B06|B06T|B407|B412|B427|B429|B430|B505)/i, family: 'bell-helo', class: 'helo' },
  { re: /^S6[0-9]|^S7[0-9]|^S76|^S92/i, family: 'sikorsky-helo', class: 'helo' },
  { re: /^R22|^R44|^R66/i, family: 'robinson-helo', class: 'helo' },
  { re: /^A109|^A119|^A139|^A149|^A169|^A189/i, family: 'leonardo-helo', class: 'helo' },
  { re: /^MD5[0-9]|^MD6[0-9]|^MD90[0-9]/i, family: 'md-helo', class: 'helo' },

  // ─── GA light piston / training ──────────────────────────────────────────
  { re: /^C1[57][0-9]|^C18[02]|^C20[67]|^BE3[36]|^BE58|^SR2[02]|^DA[24][0-9]|^P28[A-R]/i,
    family: 'ga-piston', class: 'ga' },
]

/**
 * Classify an ICAO aircraft type designator into group tag IDs.
 * Returns { family, class, role } with any slot that matched.
 * Unknown types return an empty object.
 */
function classifyType(acType) {
  if (!acType) return {}
  const t = String(acType).toUpperCase()
  for (const r of RULES) {
    if (r.re.test(t)) {
      const out = { family: r.family, class: r.class }
      if (r.role) out.role = r.role
      return out
    }
  }
  return {}
}

function classifyFamily(flight) {
  return classifyType(flight && flight.acType)
}

module.exports = { classifyFamily, classifyType }
