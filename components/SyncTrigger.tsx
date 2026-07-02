'use client'

import { useEffect, useRef } from 'react'
import { getLocalRepository } from '@/lib/repository-provider'
import { SyncEngine } from '@/lib/sync-engine'

// Module-scope throttle state — intentionally NOT React state or useRef.
// Must survive component remounts (App Router navigation unmounts/remounts
// client components). React state resets on unmount; module scope persists
// for the full page session. Mirrors lib/bootstrap.ts's module-scope
// `inFlight` coalescing pattern.
const THROTTLE_MS = 30_000
let lastRunAt = 0

/**
 * Manual sync trigger — callable from any client component (e.g. SyncBanner).
 * Same 30s throttle as the visibilitychange path; rapid calls are silently dropped.
 * Fire-and-forget: caller should .catch(console.error).
 */
export async function triggerSync(): Promise<void> {
  const now = Date.now()
  if (now - lastRunAt < THROTTLE_MS) return
  lastRunAt = now
  const engine = new SyncEngine(getLocalRepository())
  await engine.runCycle()
}

/**
 * Wires the visibilitychange event to SyncEngine.runCycle() with a 30-second
 * throttle (D-01, D-03). Fires an initial cycle on app open.
 *
 * Rules:
 *  - 'use client' required: document.visibilityState is browser-only API;
 *    must not execute during Next 16 static-export prerender (Node has no document).
 *  - All browser-API access is strictly inside useEffect (runs client-side only).
 *  - useRef(false) StrictMode once-guard: React 19 double-invokes effects in dev.
 *  - SyncEngine instance created inside useEffect, not at module scope or
 *    component scope — same discipline as Bootstrap.tsx / RegisterSW.tsx.
 *  - runCycle() is fire-and-forget (never awaited in render path — D-02 fast path).
 *  - Cleanup removes the visibilitychange listener on unmount.
 */
export default function SyncTrigger() {
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return // StrictMode double-invoke guard (same as Bootstrap.tsx)
    ran.current = true

    const engine = new SyncEngine(getLocalRepository())

    const trigger = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastRunAt < THROTTLE_MS) return
      lastRunAt = now
      engine.runCycle().catch((e) => console.error('[SyncEngine] cycle error:', e))
    }

    // Trigger on foreground return (D-01: visibilitychange only, no timer/online/manual)
    document.addEventListener('visibilitychange', trigger)
    // Also trigger on initial mount (app open)
    trigger()

    return () => document.removeEventListener('visibilitychange', trigger)
  }, [])

  return null
}
