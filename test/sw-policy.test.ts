import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// sw-policy.js is a CJS dual-target module (also attaches self.SWPolicy in the
// worker). Load it the same way the worker's vitest-side contract expects.
const require = createRequire(import.meta.url)
const P = require('../public/sw-policy.js')

describe('sw-policy', () => {
  it('isBypass: a real Supabase-style cross-origin URL is bypassed', () => {
    const selfOrigin = 'https://diary.local'
    expect(P.isBypass('https://abc.supabase.co/rest/v1/habits', selfOrigin)).toBe(true)
    expect(P.isBypass('https://diary.local/tasks', selfOrigin)).toBe(false)
  })

  it('isImmutableAsset: only same-origin /_next/static/* is immutable', () => {
    expect(P.isImmutableAsset('https://diary.local/_next/static/chunks/x.js')).toBe(true)
    expect(P.isImmutableAsset('https://diary.local/monthly')).toBe(false)
  })

  it('shellForPath: maps every route + falls back to /', () => {
    expect(P.shellForPath('/')).toBe('/')
    expect(P.shellForPath('/monthly')).toBe('/monthly')
    expect(P.shellForPath('/tasks')).toBe('/tasks')
    expect(P.shellForPath('/habits')).toBe('/habits')
    expect(P.shellForPath('/pomodoro')).toBe('/pomodoro')
    expect(P.shellForPath('/habit')).toBe('/habit')
    expect(P.shellForPath('/habit/anything')).toBe('/habit')
    expect(P.shellForPath('/unknown')).toBe('/')
  })

  it('PRECACHE_URLS includes all route URLs + manifest', () => {
    for (const u of ['/', '/monthly', '/tasks', '/habit', '/habits', '/pomodoro', '/manifest.webmanifest']) {
      expect(P.PRECACHE_URLS).toContain(u)
    }
  })

  it('CACHE_VERSION is diary-v12', () => {
    expect(typeof P.CACHE_VERSION).toBe('string')
    expect(P.CACHE_VERSION.length).toBeGreaterThan(0)
    // Deliberate exact pin: bumping CACHE_VERSION (required on any web-bundle
    // change — see BUGFIX-LOG 2026-06-05) must also update this line. The test
    // breaking is the reminder that a bump is a conscious, reviewed step.
    expect(P.CACHE_VERSION).toBe('diary-v12')
  })

  it('configure + isImmutableAsset: prefix-aware', () => {
    P.configure('/diary-web')
    expect(P.isImmutableAsset('https://host/diary-web/_next/static/x.js')).toBe(true)
    expect(P.isImmutableAsset('https://host/_next/static/x.js')).toBe(false)  // wrong prefix
    P.configure('')  // reset for other tests
  })

  it('configure + shellForPath: prefix-aware', () => {
    P.configure('/diary-web')
    expect(P.shellForPath('/diary-web/monthly')).toBe('/diary-web/monthly')
    expect(P.shellForPath('/diary-web/')).toBe('/diary-web/')
    expect(P.shellForPath('/diary-web/unknown')).toBe('/diary-web/')
    P.configure('')
  })
})
