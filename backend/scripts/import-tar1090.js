#!/usr/bin/env node
// ── Import wiedehopf/tar1090-db into known-aircraft.json ──────────────────
// Run on demand: `node backend/scripts/import-tar1090.js`
//
// Pulls the latest tar1090-db aircraft tags and merges them into
// backend/data/known-aircraft.json. Existing curated entries are preserved
// — bulk imports never overwrite a curated tag set, only supplement.
//
// tar1090-db layout (verified 2025/2026):
//   - db/files.js                 — gzipped JSON array of shard prefixes
//   - db/<PREFIX>.js              — gzipped JSON object keyed by hex suffix
//                                   value: [registration, icaoType, flagsHex, description]
//   - All files in /db/ are gzip-compressed regardless of Content-Encoding.
//
// Tag bitmask (db_flags as a hex integer, per wiedehopf/tar1090
// planeObject.js lines 2791-2795):
//   0x01 → military
//   0x02 → interesting (manually curated "noteworthy" fleet)
//   0x04 → PIA  (FAA Privacy ICAO Address — rotating tail; usually exec/VIP)
//   0x08 → LADD (FAA Limit Aircraft Data Display — surveillance-blocked)
//   0x10+ → unassigned in tar1090; bit-4 entries with NULL reg/type/desc
//          appear to be FAA block-allocation markers and are ignored.
//
// Tag mapping (tar1090 → flightterm):
//   mil         → military
//   interesting → vip
//   pia         → vip
//   ladd        → law_enforcement

'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const zlib = require('zlib')

const BASE = 'https://raw.githubusercontent.com/wiedehopf/tar1090-db/master/db'
const OUT  = path.join(__dirname, '..', 'data', 'known-aircraft.json')

// Throttle concurrent requests so we don't hammer raw.githubusercontent.com.
const CONCURRENCY = 8

function fetchUrl(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'flightterm-import' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        return resolve(fetchUrl(res.headers.location, redirects - 1))
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

// db/* files are stored gzipped on disk; the HTTP response is the raw
// gzip blob (Content-Encoding usually unset). Always try gunzip; fall back
// to the raw buffer if it isn't a gzip stream.
function gunzipMaybe(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf)
  }
  return buf
}

async function fetchJson(url) {
  const buf = await fetchUrl(url)
  const text = gunzipMaybe(buf).toString('utf8')
  return JSON.parse(text)
}

function flagsToTags(flagsHex) {
  if (!flagsHex) return []
  const v = parseInt(flagsHex, 16)
  if (!Number.isFinite(v) || v === 0) return []
  const tags = []
  if (v & 0x01) tags.push('military')
  if (v & 0x02) tags.push('vip')              // "interesting"
  if (v & 0x04) tags.push('vip')              // PIA — privacy address
  if (v & 0x08) tags.push('law_enforcement')  // LADD — surveillance-blocked
  // Bits 0x10+ unassigned in tar1090; ignore.
  return [...new Set(tags)]
}

async function processShard(prefix, accum) {
  const url = `${BASE}/${prefix}.js`
  let shard
  try {
    shard = await fetchJson(url)
  } catch (err) {
    console.warn(`  shard ${prefix} failed: ${err.message}`)
    return
  }
  let kept = 0
  for (const [suffix, row] of Object.entries(shard)) {
    if (!Array.isArray(row)) continue
    const [reg, type, flagsHex, desc] = row
    const tags = flagsToTags(flagsHex)
    if (tags.length === 0) continue
    // Skip FAA block-allocation markers — they have null reg/type/desc.
    // These are slot reservations, not actual aircraft.
    if (!reg && !type && !desc) continue
    const hex = (prefix + suffix).toLowerCase()
    if (!/^[0-9a-f]{6}$/.test(hex)) continue
    accum.push({ hex, tags, registration: reg || '', type: type || '' })
    kept++
  }
  if (kept > 0) console.log(`  ${prefix}: ${Object.keys(shard).length} entries, ${kept} tagged`)
}

async function runWithConcurrency(items, n, fn) {
  const queue = items.slice()
  const workers = Array.from({ length: n }, async () => {
    while (queue.length) {
      const item = queue.shift()
      await fn(item)
    }
  })
  await Promise.all(workers)
}

async function main() {
  console.log('import-tar1090: fetching shard manifest …')
  const files = await fetchJson(`${BASE}/files.js`)
  console.log(`  ${files.length} shards`)

  const entries = []
  await runWithConcurrency(files, CONCURRENCY, (p) => processShard(p, entries))
  console.log(`import-tar1090: ${entries.length} tagged entries across all shards`)

  // Preserve existing curated entries — bulk import only adds, never overwrites.
  const existing = JSON.parse(fs.readFileSync(OUT, 'utf8'))
  const meta = existing._meta || {}
  meta.lastBulkImport = new Date().toISOString()
  meta.lastBulkImportCount = entries.length

  let added = 0
  let merged = 0
  for (const e of entries) {
    const cur = existing[e.hex]
    if (!cur) {
      const row = { tags: e.tags }
      if (e.registration) row.registration = e.registration
      if (e.type) row.type = e.type
      existing[e.hex] = row
      added++
    } else {
      // Curated entry exists — only merge the *tags* array; never overwrite
      // registration/type/operator/notes. The curated entry is the source
      // of truth for those (the bulk feed has stale data for high-profile
      // tails like AF1, where the hex code gets reassigned).
      const newTags = [...new Set([...(cur.tags || []), ...e.tags])]
      if (newTags.length !== (cur.tags || []).length) {
        cur.tags = newTags
        merged++
      }
    }
  }
  existing._meta = meta
  fs.writeFileSync(OUT, JSON.stringify(existing, null, 2))
  console.log(`import-tar1090: added ${added} new entries, merged tags into ${merged} existing entries`)
  console.log(`  written to ${OUT}`)
}

main().catch((err) => { console.error('import-tar1090: failed:', err); process.exit(1) })
