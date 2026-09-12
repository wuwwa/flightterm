const fs = require('fs')
const path = require('path')

describe('SWIM worker recovery', () => {
  it('wakes a disconnected worker and delegates idle shutdown to its authenticated lease', () => {
    const app = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
    const fly = fs.readFileSync(path.join(__dirname, '..', 'fly.swim.toml'), 'utf8')

    expect(app).toContain('const wasDisconnected = !swim.getStatus()?.workerConnected')
    expect(app).toContain('if (wake && (wasIdle || wasDisconnected)) kickSwimWake(reason)')
    expect(fly).toContain('min_machines_running = 0')
    expect(fly).toContain("auto_stop_machines = 'off'")
    expect(fly).toContain("policy = 'on-failure'")
    expect(fly).toContain("SWIM_EXIT_ON_IDLE = 'true'")
  })
})
