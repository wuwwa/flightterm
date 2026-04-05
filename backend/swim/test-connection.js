#!/usr/bin/env node
// ── SWIM Connection Test ────────────────────────────────────────────────────
// Run: node backend/swim/test-connection.js
// Tests the Solace connection to FAA SWIM SCDS and logs the first few messages.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const ScdsConsumer = require('./scds-consumer')

const config = {
  name: 'FNS-TEST',
  url: process.env.SWIM_FNS_URL || 'tcps://ems2.swim.faa.gov:55443',
  vpn: process.env.SWIM_FNS_VPN || 'AIM_FNS',
  username: process.env.SWIM_USERNAME,
  password: process.env.SWIM_PASSWORD,
  queue: process.env.SWIM_FNS_QUEUE,
}

console.log('=== SWIM SCDS Connection Test ===')
console.log(`URL:      ${config.url}`)
console.log(`VPN:      ${config.vpn}`)
console.log(`Username: ${config.username}`)
console.log(`Password: ${config.password ? '***' + config.password.slice(-4) : 'NOT SET'}`)
console.log(`Queue:    ${config.queue}`)
console.log('')

if (!config.username || !config.password || !config.queue) {
  console.error('ERROR: Missing SWIM credentials in .env')
  console.error('Required: SWIM_USERNAME, SWIM_PASSWORD, SWIM_FNS_QUEUE')
  process.exit(1)
}

let msgCount = 0
const MAX_MESSAGES = 3

const consumer = new ScdsConsumer(config, (xml, props) => {
  msgCount++
  console.log(`\n── Message #${msgCount} ──`)
  console.log(`Properties:`, JSON.stringify(props, null, 2))
  console.log(`XML (first 500 chars):`, xml.substring(0, 500))
  console.log(`Full length: ${xml.length} chars`)

  if (msgCount >= MAX_MESSAGES) {
    console.log(`\n=== SUCCESS: Received ${msgCount} messages. Connection works! ===`)
    consumer.disconnect()
    process.exit(0)
  }
})

console.log('Connecting...')
consumer.connect()
  .then(() => {
    console.log('Connected! Waiting for messages (will show first 3)...')
    console.log('(If no messages appear within 30s, the queue may be empty or subscription filters are too narrow)')
  })
  .catch((err) => {
    console.error('CONNECTION FAILED:', err.message)
    process.exit(1)
  })

// Timeout after 60s
setTimeout(() => {
  console.log(`\nTimeout after 60s. Received ${msgCount} messages.`)
  if (msgCount === 0) {
    console.log('No messages received. Possible causes:')
    console.log('  1. Queue is empty (no new NOTAMs published recently)')
    console.log('  2. Subscription filters are too restrictive')
    console.log('  3. Connection succeeded but queue binding failed')
  }
  consumer.disconnect()
  process.exit(msgCount > 0 ? 0 : 1)
}, 60_000)
