#!/usr/bin/env node
// ── FAA Releasable Aircraft Registry — CLI wrapper ──────────────────────────
// Thin wrapper around backend/jobs/faaRegistryJob. Three modes:
//
//   # Full pipeline — download zip, unzip, ingest (use this one-shot on Fly)
//   node backend/scripts/ingest-faa-registry.js --fetch
//
//   # Ingest from a local MASTER.txt (useful when you've already unzipped)
//   node backend/scripts/ingest-faa-registry.js /tmp/faa/MASTER.txt
//
//   # Dry run with a row limit (smoke-test changes to the parser/classifier)
//   node backend/scripts/ingest-faa-registry.js --fetch --limit=1000
//
// Lift-shift note: this script, the shared job module at backend/jobs/, and
// the startup self-heal in backend/index.js are all pure Node code. Clone
// the repo on any host where Node runs and the ingest pipeline travels with
// it — no Fly-specific cron or infra hooks needed.

const fs = require('fs')

const { fetchAndIngest, ingestMasterFile } = require('../jobs/faaRegistryJob')
const db = require('../db')

const args = process.argv.slice(2)
const flags = { fetch: false, dryRun: false, limit: null, file: null }
for (const a of args) {
  if (a === '--fetch') flags.fetch = true
  else if (a === '--dry-run') flags.dryRun = true
  else if (a.startsWith('--limit=')) flags.limit = parseInt(a.slice(8), 10)
  else if (!a.startsWith('--')) flags.file = a
}

if (!flags.fetch && !flags.file) {
  console.error('Usage:')
  console.error('  --fetch              download + unzip + ingest (full pipeline)')
  console.error('  <path-to-MASTER.txt> ingest an already-extracted file')
  console.error('  --limit=N            process only first N rows')
  console.error('  --dry-run            parse + report without writing (file mode only)')
  process.exit(1)
}

async function main() {
  if (flags.fetch) {
    await fetchAndIngest({ limit: flags.limit })
  } else {
    if (!fs.existsSync(flags.file)) {
      console.error(`file not found: ${flags.file}`)
      process.exit(1)
    }
    if (flags.dryRun) {
      // Minimal dry-run: same parsing, but don't write. Done inline since
      // the shared module always upserts.
      console.log(`[faa-registry] dry-run ${flags.file}`)
      const readline = require('readline')
      const { parseMasterLine } = require('../jobs/faaRegistryJob')
      const rl = readline.createInterface({
        input: fs.createReadStream(flags.file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      let lineNo = 0, parsed = 0, skipped = 0
      const byType = {}
      for await (const line of rl) {
        lineNo++
        if (lineNo === 1) continue
        const row = parseMasterLine(line)
        if (!row) { skipped++; continue }
        parsed++
        if (row.type_registrant != null) {
          byType[row.type_registrant] = (byType[row.type_registrant] || 0) + 1
        }
        if (flags.limit && parsed >= flags.limit) break
      }
      console.log(`[faa-registry] dry-run: lines=${lineNo} parsed=${parsed} skipped=${skipped}`)
      console.log('[faa-registry] registrant type histogram:', byType)
      return
    }
    await ingestMasterFile(flags.file, { limit: flags.limit })
    console.log(`[faa-registry] faa_registry now holds ${db.getFaaRegistryCount().toLocaleString()} rows`)
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[faa-registry] fatal:', err.message)
    if (process.env.DEBUG) console.error(err)
    process.exit(1)
  })
