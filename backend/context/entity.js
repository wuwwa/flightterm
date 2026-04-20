// Entity-type classifier (v5.7 Phase 2).
// Reads FAA registry fields pre-attached to the flight as `flight.faaReg`
// by the poller's getFlights() bulk-join. Stays synchronous so it can plug
// into the existing groups orchestrator next to airline/family/agency.

// FAA TYPE REGISTRANT code → entity group tag.
// Ref: FAA "AR-Data File Layout" (public domain).
const TYPE_REGISTRANT = {
  1: 'individual',
  2: 'partnership',
  3: 'corp',
  4: 'coowned',
  5: 'government',
  7: 'llc',
  8: 'noncitizen',
  9: 'noncitizen',
}

// Owner-name heuristics that suggest the registered entity is a trust/trustee
// arrangement — a common ownership-obscuring pattern. Additive to entity:*
// tags above: a plane can be both `entity:corp` and `entity:trust`.
const TRUST_PATTERNS = [
  /\bTRUST(EE)?\b/,
  /\bTITLE\s*TRUST\b/,
  /\bBANK\s+OF\s+UTAH\b/,       // a well-known trustee entity
]

/**
 * Classify a flight by registered-entity type.
 * Returns { tags: string[], owner: string | null }. Empty tags[] if no faaReg
 * row is attached (typical for non-US-registered aircraft).
 */
function classifyEntity(flight) {
  const reg = flight && flight.faaReg
  if (!reg) return { tags: [], owner: null }

  const tags = []
  const typeTag = TYPE_REGISTRANT[reg.type_registrant]
  if (typeTag) tags.push(`entity:${typeTag}`)

  const owner = reg.owner_name || null
  if (owner && TRUST_PATTERNS.some(re => re.test(owner))) {
    if (!tags.includes('entity:trust')) tags.push('entity:trust')
  }

  return { tags, owner }
}

module.exports = { classifyEntity, TYPE_REGISTRANT }
