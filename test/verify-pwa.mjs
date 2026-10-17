// PWA build-artifact verification — the structural/installability half of
// OFFLINE-04/05 (the offline-data half is already proven by the Phase-1 suite +
// verify:migration; the live offline render is the 04-03 manual checkpoint).
// Self-contained: runs `npm run build` then hard-asserts the out/ artifacts.
// Mirrors test/migration-verify.ts discipline — throw + exit 1 on any miss,
// print "PWA VERIFY: PASS" with an N/N count only when every assertion holds.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let n = 0
const fail = (msg) => {
  console.error(`PWA VERIFY: FAIL — ${msg}`)
  process.exit(1)
}
const assert = (cond, msg) => {
  n++
  if (!cond) fail(msg)
  console.log(`  ✓ [${n}] ${msg}`)
}

console.log('Building (npm run build)...')
execSync('rm -rf .next out && npm run build', { stdio: 'inherit' })

// 1. Manifest
assert(existsSync('out/manifest.webmanifest'), 'out/manifest.webmanifest exists')
let m
try {
  m = JSON.parse(readFileSync('out/manifest.webmanifest', 'utf8'))
} catch (e) {
  fail(`out/manifest.webmanifest is not valid JSON: ${e.message}`)
}
assert(typeof m.name === 'string' && m.name.length > 0, 'manifest has a name')
assert(m.start_url.endsWith('/'), "manifest start_url ends with '/'")
assert(m.display === 'standalone', "manifest display === 'standalone'")
const icons = m.icons || []
assert(icons.some((i) => i.sizes === '192x192'), 'manifest has a 192x192 icon')
assert(icons.some((i) => i.sizes === '512x512'), 'manifest has a 512x512 icon')
assert(icons.some((i) => i.purpose === 'maskable'), 'manifest has a maskable icon')

// 2. Service worker
assert(existsSync('out/sw.js'), 'out/sw.js exists')
const sw = readFileSync('out/sw.js', 'utf8')
for (const t of ["importScripts('sw-policy.js')", 'skipWaiting', 'clients.claim', 'isBypass']) {
  assert(sw.includes(t), `out/sw.js contains ${t}`)
}
assert(!/addEventListener\(\s*['"](push|notificationclick)['"]/.test(sw), 'out/sw.js has NO push/notificationclick listener')

// 3. SW policy
assert(existsSync('out/sw-policy.js'), 'out/sw-policy.js exists')
const P = require('../out/sw-policy.js')
for (const u of ['/', '/monthly', '/tasks', '/habit', '/manifest.webmanifest']) {
  assert(P.PRECACHE_URLS.includes(u), `PRECACHE_URLS includes ${u}`)
}
const supa = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://abc.supabase.co'
assert(P.isBypass(supa + '/rest/v1/habits', 'https://x') === true, 'cross-origin Supabase URL → isBypass true (no cache-trap)')

// 4. Icons — valid PNG magic + IHDR dimensions
for (const [f, w, h] of [
  ['out/icon-192.png', 192, 192],
  ['out/icon-512.png', 512, 512],
  ['out/apple-touch-icon.png', 180, 180],
]) {
  assert(existsSync(f), `${f} exists`)
  const b = readFileSync(f)
  const okMagic = b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG'
  const W = b.readUInt32BE(16)
  const H = b.readUInt32BE(20)
  assert(okMagic && W === w && H === h, `${f} is a valid PNG ${w}x${h} (got ${W}x${H})`)
}

// 5. Registration wiring (source)
const layout = readFileSync('app/layout.tsx', 'utf8')
assert(layout.includes('RegisterSW'), 'app/layout.tsx references RegisterSW')
const reg = readFileSync('components/RegisterSW.tsx', 'utf8')
assert(reg.includes('updateViaCache'), 'RegisterSW.tsx sets updateViaCache')
assert(reg.includes("'/sw.js'") || reg.includes("/sw.js'"), "RegisterSW.tsx registers '/sw.js'")

console.log(`\nPWA VERIFY: PASS (${n}/${n})`)
process.exit(0)
