'use client'

/**
 * SyncBanner — non-blocking, fault-only in-page banner (D-04/D-05/D-08/D-10).
 *
 * Reads sync-state from the module-scope pub/sub in lib/sync-state.ts.
 * Subscribes via useEffect — state comes from getSyncState()/subscribe,
 * NOT from props (avoids the useState(props) nav-state bug class documented
 * in 06-CONTEXT.md).
 *
 * Render rules:
 *   - unsyncedCount === 0 && conflictDates.length === 0 → return null (D-04 invisible)
 *   - conflictDates.length > 0 → show conflict banner as primary (D-08)
 *   - unsyncedCount > 0 → show unsynced banner
 *
 * Banner is fixed to the bottom of the viewport (does not push/reflow <main>).
 * No shadow, no gradient — Apple design system (06-CONTEXT.md design rules).
 * Action Blue #0066cc for the tappable detail affordance only.
 *
 * Next 16 discipline (AGENTS.md / 06-RESEARCH.md Pitfall 6):
 *   - 'use client' required: subscribes to module-scope signal via useEffect
 *   - All module-scope state access is inside useEffect (safe from Node prerender)
 *   - SyncBanner renders null during static-export prerender (no state yet)
 */

import { useEffect, useRef, useState } from 'react'
import { getSyncState, subscribe, type SyncStateShape } from '@/lib/sync-state'
import { requestSignIn } from '@/lib/signin-request'
import { triggerSync } from '@/components/SyncTrigger'

export default function SyncBanner() {
  // Initialize from the module store — safe: getSyncState() returns the plain
  // initial value { unsyncedCount: 0, conflictDates: [] } in both Node and browser.
  const [syncState, setSyncStateLocal] = useState<SyncStateShape>(getSyncState)
  // Local UI state for the manual sync button.
  const [buttonDisabled, setButtonDisabled] = useState(false)
  const [syncError, setSyncError] = useState(false)
  const disableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Subscribe to sync-state changes. Returns an unsubscribe function for cleanup.
    const unsub = subscribe(() => setSyncStateLocal(getSyncState()))
    return () => {
      unsub()
      if (disableTimerRef.current) clearTimeout(disableTimerRef.current)
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    }
  }, [])

  const { unsyncedCount, conflictDates, isUnauthenticated } = syncState

  // D-04: normal sync is invisible — no banner in steady state.
  if (unsyncedCount === 0 && conflictDates.length === 0) return null

  // D-08: conflict is the primary fault; takes precedence over unsynced.
  if (conflictDates.length > 0) {
    const firstDate = conflictDates[0]
    return (
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          backgroundColor: '#fff8e6',
          borderTop: '1px solid #f0c040',
          padding: '10px 16px',
          fontSize: '14px',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
          fontWeight: 400,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
        }}
      >
        <span>{conflictDates.length} 处日记冲突已合并，请核对</span>
        <a
          href={`/?date=${encodeURIComponent(firstDate)}`}
          style={{ color: '#0066cc', textDecoration: 'underline', fontWeight: 600 }}
        >
          {firstDate}
        </a>
      </div>
    )
  }

  // D-10 / D-07: unsynced banner — shown only past the threshold (set by SyncEngine).
  // When isUnauthenticated, add a tappable sign-in affordance (D-07 / RESEARCH Pattern 4).
  // The nudge is ONLY shown when unsyncedCount > 0 — benign silence when synced (D-05).
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        backgroundColor: '#f5f5f7',
        borderTop: '1px solid #d2d2d7',
        padding: '10px 16px',
        fontSize: '14px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
        fontWeight: 400,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        color: '#333',
      }}
    >
      {isUnauthenticated ? (
        <>
          <span>{unsyncedCount} 项更改待同步 · 请登录以同步</span>
          <button
            onClick={requestSignIn}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: '#0066cc',
              textDecoration: 'underline',
              fontWeight: 600,
              fontFamily: 'inherit',
              fontSize: 'inherit',
            }}
          >
            登录
          </button>
        </>
      ) : (
        <>
          <span>{unsyncedCount} 项更改待同步</span>
          {syncError && (
            <span style={{ color: '#cc3300' }}>同步失败</span>
          )}
          <button
            onClick={() => {
              if (buttonDisabled) return
              setButtonDisabled(true)
              disableTimerRef.current = setTimeout(() => setButtonDisabled(false), 30_000)
              triggerSync().catch((e: unknown) => {
                console.error(e)
                setSyncError(true)
                errorTimerRef.current = setTimeout(() => setSyncError(false), 2000)
              })
            }}
            disabled={buttonDisabled}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: buttonDisabled ? 'default' : 'pointer',
              color: buttonDisabled ? '#999' : '#0066cc',
              textDecoration: buttonDisabled ? 'none' : 'underline',
              fontWeight: 600,
              fontFamily: 'inherit',
              fontSize: 'inherit',
              opacity: buttonDisabled ? 0.5 : 1,
            }}
          >
            立即同步
          </button>
        </>
      )}
    </div>
  )
}
