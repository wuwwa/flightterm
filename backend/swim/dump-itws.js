#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const solace = require('solclientjs').debug
const fp = new solace.SolclientFactoryProperties()
fp.profile = solace.SolclientFactoryProfiles.version10
solace.SolclientFactory.init(fp)

const session = solace.SolclientFactory.createSession({
  url: process.env.SWIM_ITWS_URL, vpnName: process.env.SWIM_ITWS_VPN,
  userName: process.env.SWIM_USERNAME, password: process.env.SWIM_PASSWORD,
  connectRetries: 1,
})

const seen = new Set()
let count = 0

session.on(solace.SessionEventCode.UP_NOTICE, () => {
  const c = session.createMessageConsumer({
    queueDescriptor: { name: process.env.SWIM_ITWS_QUEUE, type: solace.QueueType.QUEUE },
    acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
    createIfMissing: false,
  })
  c.on(solace.MessageConsumerEventName.MESSAGE, (msg) => {
    const xml = msg.getXmlContent() || ''
    const bin = msg.getBinaryAttachment()
    const binStr = bin ? (typeof bin === 'string' ? bin : Buffer.isBuffer(bin) ? bin.toString('utf8') : '') : ''
    const content = xml || binStr

    const props = {}
    try {
      const map = msg.getUserPropertyMap()
      if (map) for (const k of map.getKeys() || []) try { props[k] = map.getField(k)?.getValue() } catch {}
    } catch {}

    const msgType = props.msgType || props.MessageType || props.ITWS_MessageType || '?'
    const key = msgType

    if (!seen.has(key)) {
      seen.add(key)
      count++
      console.log(`\n${'='.repeat(60)}`)
      console.log(`MSG TYPE: ${key}`)
      console.log(`Props: ${JSON.stringify(props, null, 2)}`)
      console.log(`XML len: ${xml.length}  Binary len: ${binStr.length}`)
      if (content.length > 0) {
        console.log(`Content (first 1500):`)
        console.log(content.substring(0, 1500))
      } else {
        console.log('(no content)')
      }

      if (count >= 5) {
        console.log('\n=== Seen ' + seen.size + ' types ===')
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
setTimeout(() => { console.log('Types:', [...seen]); session.disconnect(); process.exit(0) }, 30000)
