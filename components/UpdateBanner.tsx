'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { subscribeUpdateAvailable } from '@/lib/update-signal'
import { LATEST_VERSION } from '@/lib/changelog'

const VERSION_KEY = 'diary-app-version'

/**
 * Bottom banner for app updates, two mutually-exclusive states:
 *
 * 1. "发现新版本" — the service worker found a new build (updatefound) while
 *    the user is still on the stale cached shell. The only action that helps is
 *    a manual reload; the new SW has already skipWaiting()+claimed, so reload
 *    lands on the new shell. IndexedDB data is untouched by any of this.
 *
 * 2. "已更新到 X" — after the reload, the bundle's LATEST_VERSION differs from
 *    the version last seen (localStorage). Points to the changelog on /settings
 *    so the user can read what changed.
 *
 * These can't collide: the version stamp only fires when the bundle version
 * advanced, which is exactly the new shell where updatefound does NOT fire.
 *
 * Apple design system: parchment --card surface, single --accent on interactive
 * elements only, no gradient / box-shadow / weight-500 (~/.claude/CLAUDE.md).
 * Mirrors components/InstallBanner.tsx.
 */
export default function UpdateBanner() {
  const [mode, setMode] = useState<'update' | 'whatsnew' | null>(null)
  const router = useRouter()
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return // StrictMode double-invoke guard
    ran.current = true

    const unsubscribe = subscribeUpdateAvailable(() => setMode('update'))

    try {
      const seen = localStorage.getItem(VERSION_KEY)
      if (seen && seen !== LATEST_VERSION) setMode('whatsnew')
      localStorage.setItem(VERSION_KEY, LATEST_VERSION)
    } catch {
      // storage unavailable — version stamp is best-effort
    }

    return unsubscribe
  }, [])

  if (!mode) return null

  const isUpdate = mode === 'update'

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1001,
        background: 'var(--card)',
        borderTop: '1px solid var(--border)',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
        fontSize: 15,
        fontWeight: 400,
        color: 'var(--foreground)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '12px 16px',
      }}
    >
      <span>{isUpdate ? '发现新版本，刷新后生效' : `已更新到 ${LATEST_VERSION}`}</span>
      <button
        type="button"
        onClick={() => (isUpdate ? window.location.reload() : router.push('/settings'))}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent)',
          fontSize: 15,
          fontWeight: 600,
          cursor: 'pointer',
          padding: '4px 8px',
          flexShrink: 0,
        }}
      >
        {isUpdate ? '立即刷新' : '查看更新日志'}
      </button>
      <button
        type="button"
        aria-label="关闭"
        onClick={() => setMode(null)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent)',
          fontSize: 15,
          fontWeight: 400,
          cursor: 'pointer',
          padding: '4px 8px',
          flexShrink: 0,
        }}
      >
        关闭
      </button>
    </div>
  )
}
