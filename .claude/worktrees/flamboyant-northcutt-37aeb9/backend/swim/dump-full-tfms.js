#!/usr/bin/env node
// Dump several TFMS messages with different msgTypes to see what data exists
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const solace = require('solclientjs').debug
const fp = new solace.SolclientFactoryProperties()
fp.profile = solace.SolclientFactoryProfiles.version10
solace.SolclientFactory.init(fp)

const session = solace.SolclientFactory.createSession({
  url: process.env.SWIM_TFMS_URL, vpnName: process.env.SWIM_TFMS_VPN,
  userName: process.env.SWIM_USERNAME, password: process.env.SWIM_PASSWORD,
  connectRetries: 1,
})

const seen = new Set()
let count = 0

session.on(solace.SessionEventCode.UP_NOTICE, () => {
  const c = session.createMessageConsumer({
    queueDescriptor: { name: process.env.SWIM_TFMS_QUEUE, type: solace.QueueType.QUEUE },
    acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
    createIfMissing: false,
  })
  c.on(solace.MessageConsumerEventName.MESSAGE, (msg) => {
    const xml = msg.getXmlContent() || ''
    const props = {}
    try {
      const map = msg.getUserPropertyMap()
      if (map) for (const k of map.getKeys() || []) try { props[k] = map.getField(k)?.getValue() } catch {}
    } catch {}

    const dataClass = props.TFMDataClass || '?'
    const msgType = props.msgType || props.MessageType || '?'
    const key = `${dataClass}/${msgType}`

    // Collect unique message types
    if (!seen.has(key) && xml.length > 100) {
      seen.add(key)
      count++
      console.log(`\n${'='.repeat(80)}`)
      console.log(`TYPE: ${key}  (${xml.length} chars)`)
      console.log(`${'='.repeat(80)}`)
      // Pretty print the XML structure (just element names, not full content)
      const elements = xml.match(/<[^/!?][^>]*>/g) || []
      const uniqueElements = [...new Set(elements.map(e => e.replace(/ .*/, '>').replace(/xmlns[^>]*/g, '')))]
      console.log('Elements:', uniqueElements.slice(0, 40).join('\n  '))
      console.log('\nFull XML (first 2000):')
      console.log(xml.substring(0, 2000))

      if (count >= 6) {
        console.log('\n=== Collected ' + seen.size + ' unique message types ===')
        session.disconnect()
        process.exit(0)
      }
    }
    msg.acknowledge()
  })
  c.connect()
})
session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, () => process.exit(1))
session.connect()
setTimeout(() => { console.log('Types seen:', [...seen]); session.disconnect(); process.exit(0) }, 45000)
