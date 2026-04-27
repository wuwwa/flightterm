#!/usr/bin/env node
// Cross-platform cleanup: kill any processes holding the dev ports.
// Used as `predev` so stale processes from a previous Ctrl+C don't block startup.

const { execSync } = require('child_process')

const PORTS = [3001, 3002, 5173]
const isWin = process.platform === 'win32'

function findPids(port) {
  try {
    if (isWin) {
      const out = execSync(`netstat -ano -p TCP`, { encoding: 'utf8' })
      const pids = new Set()
      for (const line of out.split('\n')) {
        // e.g. "  TCP    0.0.0.0:3001    0.0.0.0:0    LISTENING    3936"
        const m = line.match(new RegExp(`[:.]${port}\\s.*LISTENING\\s+(\\d+)`))
        if (m) pids.add(m[1])
      }
      return Array.from(pids)
    } else {
      // lsof on macOS / Linux
      const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' })
      return out.split('\n').filter(Boolean)
    }
  } catch {
    return []
  }
}

function kill(pid) {
  try {
    if (isWin) execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
    else execSync(`kill -9 ${pid}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let killed = 0
for (const port of PORTS) {
  const pids = findPids(port)
  for (const pid of pids) {
    if (kill(pid)) {
      console.log(`cleanup: freed port ${port} (killed PID ${pid})`)
      killed++
    }
  }
}
if (killed === 0) console.log('cleanup: dev ports clean')
