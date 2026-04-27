#!/usr/bin/env node
// Dump one full TFMS message to inspect XML structure
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const solace = require('solclientjs').debug
const factoryProps = new solace.SolclientFactoryProperties()
factoryProps.profile = solace.SolclientFactoryProfiles.version10
solace.SolclientFactory.init(factoryProps)

const session = solace.SolclientFactory.createSession({
  url: process.env.SWIM_TFMS_URL, vpnName: process.env.SWIM_TFMS_VPN,
  userName: process.env.SWIM_USERNAME, password: process.env.SWIM_PASSWORD,
  connectRetries: 1,
})

session.on(solace.SessionEventCode.UP_NOTICE, () => {
  const c = session.createMessageConsumer({
    queueDescriptor: { name: process.env.SWIM_TFMS_QUEUE, type: solace.QueueType.QUEUE },
    acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
    createIfMissing: false,
  })
  c.on(solace.MessageConsumerEventName.MESSAGE, (msg) => {
    const xml = msg.getXmlContent() || ''
    // Find a FlightData message (has fltdOutput)
    if (xml.includes('fltdOutput') && xml.length > 5000) {
      console.log(xml)
      msg.acknowledge()
      session.disconnect()
      process.exit(0)
    }
    msg.acknowledge()
  })
  c.connect()
})
session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, () => process.exit(1))
session.connect()
setTimeout(() => process.exit(1), 30000)
