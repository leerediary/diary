'use client'

/**
 * AccountEntry — quiet, always-reachable account/settings affordance (Phase 7 / D-07).
 *
 * Shows sign-in or sign-out state near Nav. Two states:
 *   - Signed in:  "已登录" + a sign-out tap target
 *   - Signed out: "登录" button → requestSignIn() (lib/signin-request.ts) →
 *     Bootstrap shows <SignInScreen>. Works even when the local store has data
 *     (the empty-store-only sign-in gate would otherwise leave no re-login path).
 *
 * Subscribes to auth state via onAuthStateChange inside useEffect — reactive,
 * no polling. Does NOT use a useRef(false) once-guard because the subscription
 * must remain active for the full component lifetime (unlike one-shot Bootstrap/RegisterSW).
 *
 * Design constraints (CLAUDE.md Apple Design System):
 *   - Action Blue #0066cc only on the interactive tap target
 *   - No shadow, no badge, no weight 500; SF Pro fallback stack; 14px quiet size
 *   - No sign-out confirmation dialog — strictly single-user app
 *   - No useState(props): sign-in state comes from onAuthStateChange, not props
 *
 * Pitfall 6 guard: onAuthStateChange is called inside useEffect, never at
 * module scope or render time.
 */

import { useEffect, useState } from 'react'
import { onAuthStateChange, signOut } from '@/lib/auth-session'
import { requestSignIn } from '@/lib/signin-request'
import { ACTION_BLUE_BUTTON } from '@/components/shared-styles'

export default function AccountEntry() {
  const [isSignedIn, setIsSignedIn] = useState(false)

  useEffect(() => {
    // Subscribe to auth state changes. Returns unsubscribe for cleanup.
    const unsubscribe = onAuthStateChange((event, session) => {
      setIsSignedIn(!!session)
    })
    return unsubscribe
  }, [])

  const style: React.CSSProperties = {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
    fontSize: 14,
    fontWeight: 400,
    lineHeight: 1,
  }

  if (isSignedIn) {
    return (
      <div style={{ ...style, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: '#6e6e73' }}>已登录</span>
        <button
          onClick={() => signOut().catch((e) => console.error('sign-out failed:', e))}
          style={ACTION_BLUE_BUTTON}
        >
          退出
        </button>
      </div>
    )
  }

  return (
    <div style={style}>
      <button
        onClick={requestSignIn}
        style={ACTION_BLUE_BUTTON}
      >
        登录
      </button>
    </div>
  )
}
