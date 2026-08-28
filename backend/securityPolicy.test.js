const fs = require('fs')
const path = require('path')

describe('production content security policy', () => {
  it('allows the keyless OpenFreeMap renderer and its worker', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')

    expect(source).toContain("'https://tiles.openfreemap.org'")
    expect(source).toMatch(/workerSrc:\s*\["'self'",\s*'blob:'\]/)
  })
})
