// Group-tag orchestrator.
// Combines airline / family / agency classifiers into a flat string[] of
// "<kind>:<id>" tags attached to each flight. Entity-type tags (LLC/Corp/etc)
// will be appended here once the FAA registry ingest lands.

const { classifyAirline } = require('../context/airline')
const { classifyFamily } = require('../context/family')
const { classifyAgency } = require('../context/agency')
const { classifyEntity } = require('../context/entity')

/**
 * Returns { groups: string[], airline, owner }.
 * - `airline` is the matched AirlineEntry (or null) so the dossier endpoint
 *   can echo name/country/iata without re-looking-them-up.
 * - `owner` is the registered owner name from FAA registry (or null) — handy
 *   for the dossier's header row and the eventual owner-fleet grouping.
 *
 * Entity tags rely on `flight.faaReg` being pre-attached by the caller
 * (see backend/poller.js getFlights()); classifier stays sync.
 */
function assignGroups(flight) {
  const groups = []

  const airline = classifyAirline(flight)
  if (airline) {
    groups.push(`airline:${airline.icao.toLowerCase()}`)
  }

  const family = classifyFamily(flight)
  if (family.family) groups.push(`family:${family.family}`)
  if (family.class)  groups.push(`class:${family.class}`)
  if (family.role)   groups.push(`role:${family.role}`)

  const agency = classifyAgency(flight)
  for (const tag of agency.tags) {
    groups.push(tag)
  }

  const entity = classifyEntity(flight)
  for (const tag of entity.tags) {
    groups.push(tag)
  }

  return { groups, airline, owner: entity.owner }
}

module.exports = { assignGroups }
