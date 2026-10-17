'use client'

/**
 * SignInScreen — Apple-minimal full-viewport sign-in overlay (Phase 7 / D-04/D-06/D-08).
 *
 * Shown ONLY when the local store is empty AND no GoTrue session exists on the
 * current device (D-06 empty-only-wait gate). After successful sign-in the
 * `onSuccess` callback fires so Bootstrap.tsx can dismiss this screen and trigger
 * the authenticated bootstrapIfEmpty pull.
 *
 * Design constraints (CLAUDE.md Apple Design System):
 *   - Single Action Blue #0066cc accent, only on the submit button
 *   - SF Pro stack; 17px body; no weight 500; no gradients; no shadows on form/button
 *   - No signup field, no recovery link — D-04 / D-08 (out-of-band Dashboard actions)
 *   - Error message inline below form, cleared on next submit attempt
 *
 * Navigation discipline (STATE.md useState(props) class):
 *   - Any URL-derived state is read from useSearchParams() per render, never seeded
 *     into useState once. This component does not currently consume URL params but
 *     follows the discipline for future safety.
 *   - No useRef(false) once-guard: unlike Bootstrap, this form may be submitted
 *     repeatedly until sign-in succeeds.
 *
 * Pitfall 6 guard: signIn() is called inside an async submit handler — never at
 * module scope or render time (getAuthClient() is safe from the prerender pass).
 */

import { useState, type FormEvent } from 'react'
import { signIn, type AuthError } from '@/lib/auth-session'

interface SignInScreenProps {
  onSuccess: () => void
}

export default function SignInScreen({ onSuccess }: SignInScreenProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<AuthError | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error: signInError } = await signIn(email, password)
    setLoading(false)
    if (signInError) {
      setError(signInError)
      return
    }
    onSuccess()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        backgroundColor: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
      }}
    >
      <div style={{ width: '100%', maxWidth: 360, padding: '0 24px' }}>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: '#1d1d1f',
            marginBottom: 8,
            textAlign: 'center',
          }}
        >
          日记
        </h1>
        <p
          style={{
            fontSize: 17,
            fontWeight: 400,
            color: '#6e6e73',
            textAlign: 'center',
            marginBottom: 40,
          }}
        >
          登录以开始同步
        </p>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <input
              type="email"
              autoComplete="email"
              placeholder="电子邮件"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '12px 16px',
                fontSize: 17,
                fontWeight: 400,
                border: '1px solid #d2d2d7',
                borderRadius: 0,
                outline: 'none',
                boxSizing: 'border-box',
                color: '#1d1d1f',
                backgroundColor: '#f5f5f7',
              }}
            />
          </div>
          <div style={{ marginBottom: 24 }}>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '12px 16px',
                fontSize: 17,
                fontWeight: 400,
                border: '1px solid #d2d2d7',
                borderRadius: 0,
                outline: 'none',
                boxSizing: 'border-box',
                color: '#1d1d1f',
                backgroundColor: '#f5f5f7',
              }}
            />
          </div>

          {error && (
            <p
              style={{
                fontSize: 14,
                fontWeight: 400,
                color: '#e30000',
                marginBottom: 16,
                textAlign: 'center',
              }}
            >
              {error.message}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '12px 16px',
              fontSize: 17,
              fontWeight: 600,
              color: '#ffffff',
              backgroundColor: loading ? '#6e9ad4' : '#0066cc',
              border: 'none',
              borderRadius: 0,
              cursor: loading ? 'not-allowed' : 'pointer',
              letterSpacing: '-0.01em',
            }}
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  )
}
