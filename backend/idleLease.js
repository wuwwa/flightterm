// Only authenticated snapshot requests renew this lease; feed messages and health checks do not.
function createIdleLease({ timeoutMs, now = Date.now }) {
  let lastActivity = now()
  return {
    touch() { lastActivity = now() },
    expired() { return now() - lastActivity >= timeoutMs },
  }
}
module.exports = { createIdleLease }
