'use client'

import { useEffect, useRef } from 'react'
import { markUpdateAvailable } from '@/lib/update-signal'

/**
 * Registers the offline app-shell service worker once per app open. Same shape
 * as components/Bootstrap.tsx: 'use client', useRef once-guard, renders nothing,
 * touches navigator only inside the effect (client-purity — no module/render
 * scope browser access, so all four routes stay ○ Static). updateViaCache:'none'
 * stops the browser HTTP-cache serving a stale sw.js — the only stale-SW defense
 * without headers() under output:'export' (04-RESEARCH §2.3, §5).
 */
export default function RegisterSW() {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return // StrictMode double-invoke guard
    ran.current = true
    if (!('serviceWorker' in navigator)) return

    // Native app shortcut: SW is redundant (the bundle ships inside the .ipa,
    // served via diary:// custom scheme — always offline-capable by default).
    // Worse, SW's cache-first policy serves stale chunks across rebuilds, so
    // each `npm run apple:build` + Xcode ⌘R requires Clean Build Folder +
    // delete-and-reinstall to see new code. Detection: window.diaryBridge is
    // injected by the Swift shell atDocumentStart — same single signal used by
    // lib/repository-provider.ts. On native: skip new SW registration AND
    // tear down any SW + cache storage a prior app version left behind.
    const isNative = typeof window !== 'undefined' && !!window.diaryBridge
    if (isNative) {
      navigator.serviceWorker
        .getRegistrations()
        .then((rs) => rs.forEach((r) => r.unregister()))
        .catch(() => {})
      if ('caches' in window) {
        caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {})
      }
      return
    }

    // The cache-first app-shell SW is built for the static export only
    // (`next build` → out/, NODE_ENV=production). Under `next dev` it would
    // serve stale Turbopack chunks and wedge the app on "加载中". So in dev:
    // never register, and proactively tear down any SW + Cache Storage that a
    // prior session left controlling localhost:3000. (IndexedDB is untouched —
    // SW/cache teardown never affects the diary data.)
    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker
        .getRegistrations()
        .then((rs) => rs.forEach((r) => r.unregister()))
        .catch(() => {})
      if ('caches' in window) {
        caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {})
      }
      return
    }

    const base = process.env.NEXT_PUBLIC_BASE_PATH || ''
    navigator.serviceWorker
      .register(base + '/sw.js', { scope: base + '/', updateViaCache: 'none' })
      .then((reg) => {
        // A new build is deployed when the browser's update check finds a
        // byte-changed sw.js (SW_BUILD). updatefound fires on the STALE page —
        // the only signal that can reach a user still running the cached old
        // shell. Mark it so UpdateBanner can prompt a manual refresh. IndexedDB
        // is untouched by any of this.
        const notify = () => markUpdateAvailable()
        if (reg.installing) notify() // update already in flight before listener attached
        reg.addEventListener('updatefound', notify)

        // iOS home-screen PWAs don't reliably re-run the update check on cold
        // start — the process lingers after a swipe-away, so mount-time
        // register() alone never fires again. Force a check whenever the app
        // returns to the foreground (primary iOS fix, farmstride#72); focus
        // covers desktop tab switches. Listeners live for the whole session
        // (single-page app) and are intentionally not torn down.
        const check = () => { reg.update().catch(() => {}) }
        const onVisible = () => { if (document.visibilityState === 'visible') check() }
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', check)
      })
      .catch((e) => console.error('SW register failed:', e))
  }, [])
  return null
}
