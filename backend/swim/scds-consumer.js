// ── SWIM SCDS Consumer ──────────────────────────────────────────────────────
// Generic Solace consumer for FAA SWIM Cloud Distribution Service (SCDS).
// Connects to a Solace message broker, binds to a guaranteed messaging queue,
// and calls a handler for each received message. Reusable across SWIM feeds
// (FNS, TFMS, SFDPS, ITWS, etc.) — just pass different config + handler.
//
// Protocol: Solace SMF over TLS (tcps://)
// Auth:     Username + password, scoped to a Message VPN

const solace = require('solclientjs')

// Initialize Solace factory once
const factoryProps = new solace.SolclientFactoryProperties()
factoryProps.profile = solace.SolclientFactoryProfiles.version10
factoryProps.logLevel = solace.LogLevel.WARN
solace.SolclientFactory.init(factoryProps)

class ScdsConsumer {
  /**
   * @param {Object} config
   * @param {string} config.name       - Human-readable name for logging (e.g. 'FNS', 'TFMS')
   * @param {string} config.url        - Solace broker URL (e.g. 'tcps://ems2.swim.faa.gov:55443')
   * @param {string} config.vpn        - Message VPN name
   * @param {string} config.username   - Connection username
   * @param {string} config.password   - Connection password
   * @param {string} config.queue      - Queue name to bind to
   * @param {Function} handler         - async function(messageText, properties) called per message
   */
  constructor(config, handler) {
    this.config = config
    this.handler = handler
    this.session = null
    this.consumer = null
    this.connected = false
    this.stats = {
      received: 0,
      processed: 0,
      errors: 0,
      lastMessageAt: null,
      connectedAt: null,
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const { name, url, vpn, username, password, queue } = this.config

      if (!url || !vpn || !username || !password || !queue) {
        reject(new Error(`swim/${name}: missing connection config (url, vpn, username, password, queue all required)`))
        return
      }

      console.log(`swim/${name}: connecting to ${url} (vpn: ${vpn})`)

      const sessionProps = {
        url,
        vpnName: vpn,
        userName: username,
        password,
        connectRetries: 3,
        reconnectRetries: -1,         // infinite reconnect
        reconnectRetryWaitInMsecs: 5000,
        keepAliveIntervalInMsecs: 10000,
        keepAliveIntervalsLimit: 3,
        reapplySubscriptions: true,
        publisherProperties: {
          enabled: false,             // consumer only
        },
      }

      try {
        this.session = solace.SolclientFactory.createSession(sessionProps)
      } catch (err) {
        reject(new Error(`swim/${name}: failed to create session: ${err.message}`))
        return
      }

      // Session event handlers
      this.session.on(solace.SessionEventCode.UP_NOTICE, () => {
        console.log(`swim/${name}: session connected`)
        this.connected = true
        this.stats.connectedAt = new Date().toISOString()
        this._bindQueue(queue)
        resolve()
      })

      this.session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (event) => {
        console.error(`swim/${name}: connection failed:`, event.infoStr)
        this.connected = false
        reject(new Error(`swim/${name}: connection failed: ${event.infoStr}`))
      })

      this.session.on(solace.SessionEventCode.DISCONNECTED, () => {
        console.warn(`swim/${name}: disconnected`)
        this.connected = false
        this.consumer = null
      })

      this.session.on(solace.SessionEventCode.RECONNECTING_NOTICE, () => {
        console.warn(`swim/${name}: reconnecting...`)
        this.connected = false
      })

      this.session.on(solace.SessionEventCode.RECONNECTED_NOTICE, () => {
        console.log(`swim/${name}: reconnected`)
        this.connected = true
      })

      // Connect
      try {
        this.session.connect()
      } catch (err) {
        reject(new Error(`swim/${name}: connect() threw: ${err.message}`))
      }
    })
  }

  _bindQueue(queueName) {
    const { name } = this.config

    const messageConsumer = this.session.createMessageConsumer({
      queueDescriptor: {
        name: queueName,
        type: solace.QueueType.QUEUE,
      },
      acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
      createIfMissing: false,
    })

    messageConsumer.on(solace.MessageConsumerEventName.UP, () => {
      console.log(`swim/${name}: queue consumer bound to ${queueName}`)
    })

    messageConsumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, () => {
      console.error(`swim/${name}: queue bind failed for ${queueName}`)
    })

    messageConsumer.on(solace.MessageConsumerEventName.DOWN, () => {
      console.warn(`swim/${name}: queue consumer down`)
    })

    messageConsumer.on(solace.MessageConsumerEventName.DOWN_ERROR, () => {
      console.error(`swim/${name}: queue consumer down with error`)
    })

    messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
      this.stats.received++
      this.stats.lastMessageAt = new Date().toISOString()

      try {
        // Extract message body — Solace messages can carry content in multiple fields:
        //   1. Binary attachment (most SWIM messages)
        //   2. XML content (some SWIM messages)
        //   3. SDT structured data (rare)
        // Try all accessors and use whichever has content.
        let text = ''

        // Try binary attachment first (most common for SWIM)
        try {
          const bin = message.getBinaryAttachment()
          if (bin) {
            if (typeof bin === 'string') text = bin
            else if (Buffer.isBuffer(bin)) text = bin.toString('utf8')
            else if (bin instanceof Uint8Array) text = Buffer.from(bin).toString('utf8')
            else if (typeof bin.toString === 'function') text = bin.toString()
          }
        } catch {}

        // If binary was empty, try XML content accessor
        if (!text || text.length < 5) {
          try {
            const xml = message.getXmlContent()
            if (xml && typeof xml === 'string' && xml.length > 0) text = xml
          } catch {}
        }

        // Try XML content decoded
        if (!text || text.length < 5) {
          try {
            const xml = message.getXmlContentDecoded()
            if (xml && typeof xml === 'string' && xml.length > 0) text = xml
          } catch {}
        }

        // Try SDT container as last resort
        if (!text || text.length < 5) {
          try {
            const container = message.getSdtContainer()
            if (container) {
              const val = container.getValue()
              if (typeof val === 'string') text = val
            }
          } catch {}
        }

        // Extract message properties for context
        const props = {}
        const userProps = message.getUserPropertyMap()
        if (userProps) {
          const keys = userProps.getKeys()
          if (keys) {
            for (const key of keys) {
              try { props[key] = userProps.getField(key)?.getValue() } catch {}
            }
          }
        }

        // Call handler
        Promise.resolve(this.handler(text, props)).then(() => {
          this.stats.processed++
          message.acknowledge()
        }).catch((err) => {
          this.stats.errors++
          console.error(`swim/${name}: handler error:`, err.message)
          message.acknowledge()  // ack anyway to avoid redelivery loop
        })
      } catch (err) {
        this.stats.errors++
        console.error(`swim/${name}: message processing error:`, err.message)
        message.acknowledge()
      }
    })

    messageConsumer.connect()
    this.consumer = messageConsumer
  }

  disconnect() {
    const { name } = this.config
    if (this.consumer) {
      try { this.consumer.disconnect() } catch {}
      this.consumer = null
    }
    if (this.session) {
      try { this.session.disconnect() } catch {}
      this.session = null
    }
    this.connected = false
    console.log(`swim/${name}: disconnected`)
  }

  getStats() {
    return {
      name: this.config.name,
      connected: this.connected,
      ...this.stats,
    }
  }
}

module.exports = ScdsConsumer
