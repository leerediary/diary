'use client'

import { useEffect, useState } from 'react'
import { LOCAL_ONLY } from '@/lib/local-only'

const DISMISS_KEY = 'pwa-install-banner-dismissed'

/**
 * One-time iOS「添加到主屏幕」banner shown at the bottom of the screen.
 * Only appears when LOCAL_ONLY is true AND the browser is iOS/iPadOS Safari
 * AND the display mode is non-standalone. Once dismissed (localStorage key),
 * it never returns. Renders nothing in non-iOS, standalone, or dismissed state.
 *
 * Apple design system: single accent #0066cc on interactive element only;
 * parchment surface #f5f5f7; no gradient, no box-shadow, no font-weight 500;
 * SF Pro fallback font stack (~/.claude/CLAUDE.md).
 */
export default function InstallBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!LOCAL_ONLY) return

    try {
      if (localStorage.getItem(DISMISS_KEY)) return
    } catch {
      return
    }

    // iPadOS 13+ reports Macintosh in UA but supports multi-touch (pitfall P-4).
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    if (!isIOS) return

    const isStandalone =
      (navigator as any).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches
    if (isStandalone) return

    setVisible(true)
  }, [])

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        background: '#f5f5f7',
        borderTop: '1px solid #d2d2d7',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
        fontSize: 15,
        fontWeight: 400,
        color: '#1d1d1f',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '12px 16px',
      }}
    >
      <span>
        点底部 <span style={{ fontWeight: 600 }}>分享</span> →
        <span style={{ fontWeight: 600 }}>添加到主屏幕</span>{' '}
        安装后像独立 app 一样离线使用
      </span>
      <button
        type="button"
        aria-label="关闭"
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, '1')
          } catch {
            // storage unavailable — dismiss still works for the session
          }
          setVisible(false)
        }}
        style={{
          background: 'none',
          border: 'none',
          color: '#0066cc',
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
