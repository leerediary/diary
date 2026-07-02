'use client'

import { useEffect, useRef } from 'react'

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
      .catch((e) => console.error('SW register failed:', e))
  }, [])
  return null
}
