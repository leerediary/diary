'use client'

/**
 * Bootstrap — first-run device populate + rollover (Phase 7 / D-05/D-06).
 *
 * Phase 7 change: checks GoTrue session BEFORE calling bootstrapIfEmpty on an
 * empty store. The four branches (RESEARCH Pattern 2):
 *
 *   (1) Session present → bootstrapIfEmpty(local, authenticatedReadRemote)
 *       The auth client carries the owner JWT so the 0003 RLS policy permits reads.
 *
 *   (2) Session absent + store empty → show <SignInScreen>, block until sign-in.
 *       The anon pull is now locked out by 0003; a fresh device must sign in first.
 *       Does NOT call bootstrapIfEmpty until onSuccess fires.
 *
 *   (3) Session absent + store non-empty → local fast path (D-05/D-06). The app
 *       reads and writes local data as normal; sync silently stops until sign-in
 *       via AccountEntry or the SyncBanner tap target.
 *
 *   (4) Post sign-in callback → set showSignIn false, bootstrapIfEmpty with auth remote.
 *       inFlight coalescing in lib/bootstrap.ts handles any concurrent calls.
 *
 * The useRef(false) once-guard and the async IIFE .catch boundary are preserved
 * unchanged. Bootstrap is never removed from the layout — Pitfall 3 avoidance.
 */

import { useEffect, useRef, useState } from 'react'
import { getRepository, getLocalRepository } from '@/lib/repository-provider'
import { bootstrapIfEmpty } from '@/lib/bootstrap'
import { getSession } from '@/lib/auth-session'
import { getAuthClient } from '@/lib/supabase'
import { createReadRemote } from '@/lib/supabase-read'
import SignInScreen from '@/components/SignInScreen'
import { onSignInRequested } from '@/lib/signin-request'
import { LOCAL_ONLY } from '@/lib/local-only'

function todayStr() {
  // Device-local — follows the phone/browser time zone (was Asia/Shanghai).
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Runs once per app open: session check → first-run device populate
 * (auth-key, idempotent) → date-anchored idempotent rollover. Renders nothing
 * in steady state; renders <SignInScreen> only when store is empty + no session.
 * The provider always constructs a LocalRepository (lib/repository-provider.ts),
 * so the cast is sound — bootstrapIfEmpty needs the concrete type.
 */
export default function Bootstrap() {
  const ran = useRef(false)
  const [showSignIn, setShowSignIn] = useState(false)

  useEffect(() => {
    return onSignInRequested(() => setShowSignIn(true))
  }, [])

  useEffect(() => {
    if (ran.current) return // StrictMode double-invoke guard
    ran.current = true

    ;(async () => {
      const local = getLocalRepository()

      // Phase 19 D-02: LOCAL_ONLY build skips all auth/sync — no getSession(),
      // no sign-in gate, no remote bootstrap. Only rollover.
      if (LOCAL_ONLY) {
        await getRepository().rolloverTasks(todayStr())
        return
      }

      // D-06: check session before any bootstrap attempt.
      const session = await getSession()

      if (session) {
        // Branch 1: authenticated — bootstrapIfEmpty with auth remote (0003 RLS satisfied).
        await bootstrapIfEmpty(local, createReadRemote())
      } else {
        // Check whether the local store is empty.
        let storeEmpty = true
        const { PULL_ENTITIES } = await import('@/lib/migrate-pull')
        for (const entity of PULL_ENTITIES) {
          const rows = await local.list(entity as Parameters<typeof local.list>[0], {
            includeDeleted: true,
          })
          if (rows.length > 0) {
            storeEmpty = false
            break
          }
        }

        if (storeEmpty) {
          // Branch 2: no session + empty store → block on sign-in (D-06).
          // bootstrapIfEmpty is NOT called here; it fires in onSignInSuccess.
          setShowSignIn(true)
          return // exit the IIFE; onSignInSuccess will complete the flow
        }
        // Branch 3: no session + non-empty store → local fast path (D-05/D-06).
        // Sync silently stops; AccountEntry / banner provide sign-in affordance.
      }

      await getRepository().rolloverTasks(todayStr())
    })().catch((e) => console.error('Bootstrap failed:', e))
  }, [])

  /** Branch 4: fired by <SignInScreen onSuccess>. */
  async function onSignInSuccess() {
    setShowSignIn(false)
    const local = getLocalRepository()
    try {
      await bootstrapIfEmpty(local, createReadRemote())
      await getRepository().rolloverTasks(todayStr())
    } catch (e) {
      console.error('Post sign-in bootstrap failed:', e)
    }
  }

  // Render <SignInScreen> as a conditional child — Bootstrap itself stays mounted
  // at layout level at all times (Pitfall 3 avoidance; useRef guard is per-instance).
  if (showSignIn) {
    return <SignInScreen onSuccess={onSignInSuccess} />
  }

  return null
}
