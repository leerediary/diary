// Single source of truth for the service worker's pure decision logic.
// Dual-target (no build step): the worker loads it via importScripts('/sw-policy.js')
// (attaches to self.SWPolicy); vitest loads it via require() (module.exports).
// Pure functions only — no fetch, no caches, no side effects beyond attaching P.
(function (g) {
  var _prefix = ''  // set by configure() before first use; defaults to '' (root deploy)

  var P = {
    // Bump on ANY sw.js / asset-policy change — activate sweeps every
    // non-current cache. This is the ONLY stale-shell defense (headers()
    // unsupported under output:'export', 04-RESEARCH §5).
    CACHE_VERSION: 'diary-v12',

    // Called by sw.js immediately after importScripts to inject basePath.
    configure: function (prefix) {
      _prefix = (prefix || '').replace(/\/$/, '')  // strip trailing slash
    },

    // Clean route URLs (NOT *.html) — that is what the browser requests for a
    // navigation and what the SW scope serves (04-RESEARCH §5).
    // Bare paths (no prefix). sw.js prepends _prefix when calling addAll().
    PRECACHE_URLS: [
      '/',
      '/monthly',
      '/tasks',
      '/habit',
      '/habits',
      '/pomodoro',
      '/manifest.webmanifest',
      '/icon-192.png',
      '/icon-512.png',
      '/apple-touch-icon.png',
    ],

    // Cross-origin = network-only pass-through. Covers the one-time Supabase
    // anon bootstrapIfEmpty pull — it must NEVER be cached or failed-closed
    // by the SW (STATE.md carry, 04-RESEARCH §5).
    isBypass: function (urlString, selfOrigin) {
      try {
        return new URL(urlString).origin !== selfOrigin
      } catch (e) {
        return true // unparseable → don't intercept
      }
    },

    // Content-hashed Next assets → safe to cache-first forever (old hashes
    // purged by the activate version sweep). Caller has already excluded
    // cross-origin via isBypass.
    // Prefix-aware: under /diary-web, immutable assets are /diary-web/_next/static/
    isImmutableAsset: function (urlString) {
      try {
        return new URL(urlString).pathname.indexOf(_prefix + '/_next/static/') === 0
      } catch (e) {
        return false
      }
    },

    // Map a navigation pathname to its precached shell. Caller passes a
    // pathname only (query string already excluded — ?id=/?date= are read
    // client-side, Phase 3). Unknown → '/'.
    // Prefix-aware: strip _prefix, match, then restore _prefix in the return.
    shellForPath: function (pathname) {
      var rel = _prefix ? (pathname.slice(_prefix.length) || '/') : pathname
      var shell
      if (rel === '/') shell = '/'
      else if (rel === '/monthly') shell = '/monthly'
      else if (rel === '/tasks') shell = '/tasks'
      else if (rel === '/habits') shell = '/habits'
      else if (rel === '/pomodoro') shell = '/pomodoro'
      else if (rel.indexOf('/habit') === 0) shell = '/habit'
      else shell = '/'
      return _prefix + shell
    },
  }

  g.SWPolicy = P
  if (typeof module !== 'undefined' && module.exports) module.exports = P
})(typeof self !== 'undefined' ? self : globalThis)
