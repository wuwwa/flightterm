// Government & agency classifier.
// Maps callsign prefixes and military flag to agency group tags.
// Kept separate from backend/context/callsign.js (which tags mission types
// like medevac / SAR for anomaly scoring) so the two can evolve independently.

// Each rule: [regex on uppercase callsign, tag, confidence].
// Confidence < 1.0 means the rule is a prior, not a definitive match.
const RULES = [
  // ─── US Military ─────────────────────────────────────────────────────────
  // Air Force: RCH (Reach cargo/airlift), SAM (Special Air Mission — VIP),
  // AF1 (Air Force One). Also MC (Misty Call), PAT (Priority Air Transport).
  { re: /^(RCH|REACH)\d/,                                tag: 'gov:usaf',   confidence: 0.95 },
  { re: /^SAM\d/,                                         tag: 'gov:usaf',   confidence: 0.95 },
  { re: /^(AF|AIRFORCE|VENUS|VM)\d/,                      tag: 'gov:usaf',   confidence: 0.85 },
  { re: /^AF1\b/,                                         tag: 'gov:usaf',   confidence: 1.00 }, // POTUS
  { re: /^(SPAR|PAT|MC\d)/,                               tag: 'gov:usaf',   confidence: 0.75 },
  // Navy / Marines
  { re: /^(NAVY|CNV|CONVOY|RANGR|EVAC)/,                  tag: 'gov:usn',    confidence: 0.80 },
  { re: /^(MARINE|VM[FM])/,                               tag: 'gov:usmc',   confidence: 0.80 },
  // Army
  { re: /^(ARMY|DUKE|R\d{4})/,                            tag: 'gov:usa_army', confidence: 0.70 },
  // Coast Guard
  { re: /^(CG|USCG|RESCUE|COAST\s?GUARD)\d*/,             tag: 'gov:uscg',   confidence: 0.90 },

  // ─── US Federal law enforcement ──────────────────────────────────────────
  { re: /^(CBP|OMAHA|HAMMER)\d/,                          tag: 'gov:cbp',    confidence: 0.90 },
  { re: /^(DEA)\d/,                                       tag: 'gov:dea',    confidence: 0.85 },
  { re: /^(FBI)\d/,                                       tag: 'gov:fbi',    confidence: 0.85 },
  { re: /^(ATF)\d/,                                       tag: 'gov:atf',    confidence: 0.85 },
  { re: /^(MARSHAL|JUSTICE)/,                             tag: 'gov:marshals', confidence: 0.85 },

  // ─── State / local law enforcement ───────────────────────────────────────
  { re: /^(POLICE|POL\d|SHERIFF|LAW)/,                    tag: 'gov:police', confidence: 0.80 },
  { re: /^(HIGHWAY|HP\d|STATE)\d/,                        tag: 'gov:police', confidence: 0.70 },

  // ─── US Forest Service / firefighting ────────────────────────────────────
  { re: /^(TANKER|AIRTAK|LEAD|COPTR|BAT)\d/,              tag: 'gov:firefighting', confidence: 0.80 },
  { re: /^(FIRE|CALFIRE)/,                                tag: 'gov:firefighting', confidence: 0.75 },
]

/**
 * Classify a flight by agency affiliation.
 * Returns { tags: string[], sources: [{ tag, confidence }] }.
 * `tags` is deduped and contains only entries with confidence >= 0.7.
 * The `mil` flag on the flight additionally emits `gov:military` when true.
 */
function classifyAgency(flight) {
  const tags = new Set()
  const sources = []

  const cs = (flight && flight.callsign || '').trim().toUpperCase()
  if (cs) {
    for (const { re, tag, confidence } of RULES) {
      if (re.test(cs) && confidence >= 0.7) {
        tags.add(tag)
        sources.push({ tag, confidence, source: 'callsign_prefix' })
      }
    }
  }

  // Military flag (from APL /v2/mil — authoritative) adds an umbrella tag
  // even if callsign didn't resolve to a specific branch.
  if (flight && flight.mil) {
    tags.add('gov:military')
    sources.push({ tag: 'gov:military', confidence: 1.0, source: 'mil_flag' })
  }

  return { tags: Array.from(tags), sources }
}

module.exports = { classifyAgency }
