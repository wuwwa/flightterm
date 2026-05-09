#!/usr/bin/env node
// Backfill business-jet tracker snapshots from a tar1090/readsb history URL.
//
// Required env:
//   BUSINESS_JET_HISTORY_URL_TEMPLATE
//
// Template tokens: {yyyy} {yy} {MM} {dd} {HH} {mm} {ss} {epoch}
// Example:
//   https://samples.adsbexchange.com/readsb-hist/{yyyy}/{MM}/{dd}/{HH}{mm}{ss}Z.json.gz

const tracker = require('../businessJetTracker')
const db = require('../db')

const args = process.argv.slice(2)
const flags = { start: null, end: null, stepMinutes: 30 }
for (const a of args) {
  if (a.startsWith('--start=')) flags.start = a.slice(8)
  else if (a.startsWith('--end=')) flags.end = a.slice(6)
  else if (a.startsWith('--step-minutes=')) flags.stepMinutes = Number(a.slice(15))
}
flags.stepMinutes = Math.max(30, Number(flags.stepMinutes) || 30)

if (!flags.start || !flags.end) {
  console.error('Usage: node backend/scripts/backfill-business-jets.js --start=2026-05-01T00:00:00Z --end=2026-05-02T00:00:00Z [--step-minutes=30]')
  process.exit(1)
}

async function main() {
  if (db.getFaaAircraftRefCount() === 0) {
    throw new Error('faa_aircraft_ref is empty; run `node backend/scripts/ingest-faa-registry.js --fetch` first')
  }
  const cohort = db.rebuildBusinessJetCohort()
  console.log(`[business-jets] cohort=${cohort.count.toLocaleString()}`)

  const results = await tracker.backfillHistorical(flags)
  const ok = results.filter(r => r.ok).length
  const failed = results.length - ok
  console.log(`[business-jets] backfill snapshots=${results.length} ok=${ok} failed=${failed}`)
  for (const r of results.filter(x => !x.ok).slice(0, 10)) {
    console.log(`  fail ${r.sampledAt}: ${r.error}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[business-jets] fatal:', err.message)
    if (process.env.DEBUG) console.error(err)
    process.exit(1)
  })
