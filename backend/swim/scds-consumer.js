// ── SWIM SCDS Consumer ──────────────────────────────────────────────────────
// Generic Solace consumer for FAA SWIM Cloud Distribution Service (SCDS).
//
// Message processing is decoupled from delivery: the Solace MESSAGE callback
// just queues raw message objects (zero work). A timer-based processing loop
// drains the queue in small batches (PROCESS_BATCH per PROCESS_INTERVAL_MS),
// yielding the event loop between batches so health checks and HTTP requests
// can respond.
//
// Protocol: Solace SMF over TLS (tcps://)
// Auth:     Username + password, scoped to a Message VPN

const solace = require('solclientjs')

// Initialize Solace factory once
const factoryProps = new solace.SolclientFactoryProperties()
factoryProps.profile = solace.SolclientFactoryProfiles.version10
factoryProps.logLevel = solace.LogLevel.WARN
solace.SolclientFactory.init(factoryProps)

const DEFAULT_PROCESS_BATCH = Number(process.env.SCDS_PROCESS_BATCH) || 10
const DEFAULT_PROCESS_INTERVAL_MS = Number(process.env.SCDS_PROCESS_INTERVAL_MS) || 200
const DEFAULT_MAX_QUEUE_SIZE = Number(process.env.SCDS_MAX_QUEUE_SIZE) || 5000

class ScdsConsumer {
  constructor(config, handler) {
    this.config = config
    this.handler = handler
    this.session = null
    this.consumer = null
    this.connected = false
    this._externalPause = false
    this._queue = []              // raw Solace message objects waiting to be processed
    this._processTimer = null
    this.sampleRate = Math.max(1, Number(config.sampleRate) || 1)
    this.processBatch = Math.max(1, Number(config.processBatch) || DEFAULT_PROCESS_BATCH)
    this.processIntervalMs = Math.max(25, Number(config.processIntervalMs) || DEFAULT_PROCESS_INTERVAL_MS)
    this.maxQueueSize = Math.max(this.processBatch, Number(config.maxQueueSize) || DEFAULT_MAX_QUEUE_SIZE)
    this.stats = {
      received: 0,
      processed: 0,
      errors: 0,
      queueDepth: 0,
      connectedAt: null,
      dropped: 0,
      sampledOut: 0,
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const { name, url, vpn, username, password, queue } = this.config

      if (!url || !vpn || !username || !password || !queue) {
        reject(new Error(`swim/${name}: missing connection config`))
        return
      }

      console.log(`swim/${name}: connecting to ${url} (vpn: ${vpn})`)

      try {
        this.session = solace.SolclientFactory.createSession({
          url,
          vpnName: vpn,
          userName: username,
          password,
          connectRetries: 3,
          reconnectRetries: -1,
          reconnectRetryWaitInMsecs: 5000,
          keepAliveIntervalInMsecs: 10000,
          keepAliveIntervalsLimit: 3,
          reapplySubscriptions: true,
          publisherProperties: { enabled: false },
        })
      } catch (err) {
        reject(new Error(`swim/${name}: failed to create session: ${err.message}`))
        return
      }

      this.session.on(solace.SessionEventCode.UP_NOTICE, () => {
        console.log(`swim/${name}: session connected`)
        this.connected = true
        this.stats.connectedAt = new Date().toISOString()
        this._bindQueue(queue)
        this._startProcessing()
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
      queueDescriptor: { name: queueName, type: solace.QueueType.QUEUE },
      acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
      createIfMissing: false,
      windowSize: Number(this.config.windowSize) || 50,
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

    // ── MESSAGE callback: ZERO processing, just queue ──────────────────────
    messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
      this.stats.received++
      if (this.sampleRate > 1 && this.stats.received % this.sampleRate !== 0) {
        this.stats.sampledOut++
        try { message.acknowledge() } catch {}
        return
      }

      this._queue.push(message)
      // OOM protection: drop oldest unprocessed messages if queue is too deep
      if (this._queue.length > this.maxQueueSize) {
        const dropped = this._queue.splice(0, this._queue.length - this.maxQueueSize)
        for (const msg of dropped) { try { msg.acknowledge() } catch {} }
        this.stats.dropped += dropped.length
      }
    })

    messageConsumer.connect()
    this.consumer = messageConsumer
  }

  // ── Processing loop: drain queue in controlled batches ───────────────────

  _startProcessing() {
    if (this._processTimer) return
    this._processTimer = setInterval(() => this._processBatch(), this.processIntervalMs)
  }

  _stopProcessing() {
    if (this._processTimer) { clearInterval(this._processTimer); this._processTimer = null }
  }

  _processBatch() {
    const batch = this._queue.splice(0, this.processBatch)
    this.stats.queueDepth = this._queue.length

    for (const message of batch) {
      try {
        const text = this._extractBody(message)
        const props = this._extractProps(message)
        this.handler(text, props)
        this.stats.processed++
      } catch (err) {
        this.stats.errors++
      }
      message.acknowledge()
    }
  }

  _extractBody(message) {
    // Binary attachment (most common for SWIM)
    try {
      const bin = message.getBinaryAttachment()
      if (bin) {
        if (typeof bin === 'string') return bin
        if (Buffer.isBuffer(bin)) return bin.toString('utf8')
        if (bin instanceof Uint8Array) return Buffer.from(bin).toString('utf8')
        if (typeof bin.toString === 'function') return bin.toString()
      }
    } catch {}

    // XML content
    try {
      const xml = message.getXmlContent()
      if (xml && typeof xml === 'string' && xml.length > 0) return xml
    } catch {}

    // XML content decoded
    try {
      const xml = message.getXmlContentDecoded()
      if (xml && typeof xml === 'string' && xml.length > 0) return xml
    } catch {}

    // SDT container (rare)
    try {
      const container = message.getSdtContainer()
      if (container) {
        const val = container.getValue()
        if (typeof val === 'string') return val
      }
    } catch {}

    return ''
  }

  _extractProps(message) {
    const props = {}
    try {
      const userProps = message.getUserPropertyMap()
      if (userProps) {
        const keys = userProps.getKeys()
        if (keys) {
          for (const key of keys) {
            try { props[key] = userProps.getField(key)?.getValue() } catch {}
          }
        }
      }
    } catch {}
    return props
  }

  // ── External flow control ────────────────────────────────────────────────

  pause() { this._externalPause = true }
  resume() { this._externalPause = false }

  disconnect() {
    const { name } = this.config
    this._stopProcessing()
    // Process remaining queued messages
    while (this._queue.length > 0) {
      const msg = this._queue.shift()
      try { msg.acknowledge() } catch {}
    }
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
      queueDepth: this._queue.length,
      ...this.stats,
    }
  }
}

module.exports = ScdsConsumer
