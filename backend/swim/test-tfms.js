#!/usr/bin/env node
// ── TFMS SWIM Connection Test ───────────────────────────────────────────────
// Run: node backend/swim/test-tfms.js
// Tests the Solace connection to FAA SWIM TFMS and logs messages with
// detailed extraction debugging to determine where data lives.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const solace = require('solclientjs').debug
const factoryProps = new solace.SolclientFactoryProperties()
factoryProps.profile = solace.SolclientFactoryProfiles.version10
solace.SolclientFactory.init(factoryProps)

const { parseFlightData, parseFlowData, classifyMessage } = require('./tfms-parser')

const config = {
  url: process.env.SWIM_TFMS_URL || 'tcps://ems2.swim.faa.gov:55443',
  vpn: process.env.SWIM_TFMS_VPN,
  username: process.env.SWIM_USERNAME,
  password: process.env.SWIM_PASSWORD,
  queue: process.env.SWIM_TFMS_QUEUE,
}

console.log('=== TFMS Deep Message Inspection ===')
console.log(`URL: ${config.url}  VPN: ${config.vpn}  Queue: ${config.queue?.slice(-40)}`)
console.log('')

if (!config.vpn || !config.queue || !config.password) {
  console.error('ERROR: Missing TFMS credentials in .env')
  process.exit(1)
}

let msgCount = 0
const MAX = 15
const seen = { withXml: 0, emptyXml: 0, sources: {} }

const session = solace.SolclientFactory.createSession({
  url: config.url,
  vpnName: config.vpn,
  userName: config.username,
  password: config.password,
  connectRetries: 1,
})

session.on(solace.SessionEventCode.UP_NOTICE, () => {
  console.log('Connected. Binding to queue...\n')

  const consumer = session.createMessageConsumer({
    queueDescriptor: { name: config.queue, type: solace.QueueType.QUEUE },
    acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
    createIfMissing: false,
  })

  consumer.on(solace.MessageConsumerEventName.UP, () => {
    console.log('Queue bound. Waiting for messages...\n')
  })

  consumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
    msgCount++

    // Try every possible accessor
    let binText = '', xmlText = '', xmlDecoded = '', sdtText = ''
    let binType = 'null', binLen = 0

    try {
      const bin = message.getBinaryAttachment()
      binType = bin === null ? 'null' : typeof bin === 'string' ? 'string' : bin?.constructor?.name || typeof bin
      if (bin) {
        binLen = bin.length || bin.byteLength || 0
        if (typeof bin === 'string') binText = bin
        else if (Buffer.isBuffer(bin)) binText = bin.toString('utf8')
        else if (bin instanceof Uint8Array) binText = Buffer.from(bin).toString('utf8')
        else binText = String(bin)
      }
    } catch (e) { binText = `ERROR: ${e.message}` }

    try { xmlText = message.getXmlContent() || '' } catch (e) { xmlText = `ERROR: ${e.message}` }
    try { xmlDecoded = message.getXmlContentDecoded() || '' } catch (e) { xmlDecoded = `ERROR: ${e.message}` }
    try {
      const c = message.getSdtContainer()
      if (c) sdtText = String(c.getValue()).substring(0, 200)
    } catch {}

    // Get key properties
    const props = {}
    try {
      const map = message.getUserPropertyMap()
      if (map) {
        for (const key of map.getKeys() || []) {
          try { props[key] = map.getField(key)?.getValue() } catch {}
        }
      }
    } catch {}

    const msgType = props.MessageType || props.msgType || '?'
    const dataClass = props.TFMDataClass || props.TFMS_CATEGORY || '?'
    const bestContent = binText || xmlText || xmlDecoded || sdtText || ''
    const source = binText.length > 5 ? 'binary' : xmlText.length > 5 ? 'xml' : xmlDecoded.length > 5 ? 'xmlDecoded' : sdtText.length > 5 ? 'sdt' : 'empty'

    seen.sources[source] = (seen.sources[source] || 0) + 1
    if (bestContent.length > 5) seen.withXml++
    else seen.emptyXml++

    console.log(`── #${msgCount} ${dataClass} / ${msgType} ──`)
    console.log(`  binary: type=${binType} len=${binLen}`)
    console.log(`  xml:    len=${xmlText.length}  xmlDecoded: len=${xmlDecoded?.length || 0}  sdt: len=${sdtText.length}`)
    console.log(`  source: ${source}  content: ${bestContent.length} chars`)

    if (bestContent.length > 0 && bestContent.length < 800) {
      console.log(`  content: ${bestContent}`)
    } else if (bestContent.length >= 800) {
      console.log(`  content (first 500): ${bestContent.substring(0, 500)}`)
    }

    // Try parsing if we have content
    const cls = classifyMessage(props)
    if (bestContent.length > 10) {
      if (cls === 'flow') {
        const ev = parseFlowData(bestContent, props)
        if (ev?.eventType) console.log(`  PARSED flow: ${ev.eventType} at ${ev.airport || '?'}`)
      } else {
        const fp = parseFlightData(bestContent, props)
        if (fp?.acid) console.log(`  PARSED flight: ${fp.acid} ${fp.depArpt || '?'}→${fp.arrArpt || '?'} status=${fp.flightStatus || '?'}`)
      }
    }

    console.log('')
    message.acknowledge()

    if (msgCount >= MAX) {
      console.log(`=== Done: ${msgCount} messages ===`)
      console.log(`With XML content: ${seen.withXml}  Empty: ${seen.emptyXml}`)
      console.log(`Sources:`, seen.sources)
      session.disconnect()
      process.exit(0)
    }
  })

  consumer.connect()
})

session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e) => {
  console.error('Connection failed:', e.infoStr)
  process.exit(1)
})

session.connect()
setTimeout(() => { console.log('Timeout.'); session.disconnect(); process.exit(1) }, 60000)
