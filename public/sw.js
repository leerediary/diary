// Hand-written cache-first offline app-shell service worker (classic worker).
// No Serwist — this project is Turbopack, Serwist needs webpack (PROJECT.md
// Key Decision, 04-RESEARCH §2.3). Push notifications are out of scope.
// Decision logic lives in the single-source sw-policy.js (vitest-tested).
// Relative importScripts resolves against sw.js's own URL (MDN confirmed).
importScripts('sw-policy.js')
const P = self.SWPolicy

// Derive basePath prefix from registration scope (e.g. 'https://host/diary-web/').
// new URL(scope).pathname = '/diary-web/'; strip trailing slash → '/diary-web'
// On root deploy: scope = 'https://host/', pathname = '/', prefix = ''
const _scope = self.registration.scope
const _prefix = new URL(_scope).pathname.replace(/\/$/, '')  // '' or '/diary-web'
P.configure(_prefix)

const PREFIXED_PRECACHE = P.PRECACHE_URLS.map(function(u) { return _prefix + u })

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const c = await caches.open(P.CACHE_VERSION)
      await c.addAll(PREFIXED_PRECACHE)
      self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) {
        if (k !== P.CACHE_VERSION) await caches.delete(k)
      }
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  // Cross-origin (the one-time Supabase anon bootstrap): network-only
  // pass-through. Do NOT respondWith — let it hit network normally; an
  // offline failure here is acceptable (bootstrap only runs when the local
  // store is empty). Never cache-trap or fail-close it (STATE.md carry).
  if (P.isBypass(req.url, self.location.origin)) return

  // Content-hashed Next assets: cache-first, populate on first hit.
  if (P.isImmutableAsset(req.url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(P.CACHE_VERSION)
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res && res.ok) cache.put(req, res.clone())
        return res
      })()
    )
    return
  }

  // Navigations: cache-first against the mapped shell, then network, then
  // fall back to the precached shell (or '/'); never throw offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(P.CACHE_VERSION)
        const shell = P.shellForPath(new URL(req.url).pathname)
        const cachedShell = await cache.match(shell)
        if (cachedShell) return cachedShell
        try {
          const res = await fetch(req)
          if (res && res.ok) cache.put(shell, res.clone())
          return res
        } catch (e) {
          const fallback = (await cache.match(shell)) || (await cache.match(_prefix + '/'))
          if (fallback) return fallback
          return new Response('', { status: 504, statusText: 'Offline' })
        }
      })()
    )
    return
  }

  // All other same-origin GET: cache-first then network.
  event.respondWith(
    (async () => {
      const cache = await caches.open(P.CACHE_VERSION)
      const hit = await cache.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res && res.ok) cache.put(req, res.clone())
      return res
    })()
  )
})
