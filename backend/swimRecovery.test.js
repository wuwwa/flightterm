const fs = require('fs')
const path = require('path')

describe('SWIM worker recovery', () => {
  it('wakes a disconnected worker and keeps the production worker warm', () => {
    const app = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
    const fly = fs.readFileSync(path.join(__dirname, '..', 'fly.swim.toml'), 'utf8')

    expect(app).toContain('const wasDisconnected = !swim.getStatus()?.workerConnected')
    expect(app).toContain('if (wake && (wasIdle || wasDisconnected)) kickSwimWake(reason)')
    expect(fly).toContain('min_machines_running = 1')
  })
})
