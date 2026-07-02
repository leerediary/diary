'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const links = [
  { href: '/', label: '今日' },
  { href: '/monthly', label: '月览' },
  { href: '/tasks', label: '任务' },
  { href: '/pomodoro', label: '番茄' },
]

export default function Nav() {
  const path = usePathname()
  const settingsActive = path.startsWith('/settings')
  return (
    <nav
      style={{ borderBottom: '1px solid var(--border)', background: 'var(--background)', paddingTop: 'env(safe-area-inset-top)' }}
      className="sticky top-0 z-10"
    >
      <div className="max-w-2xl mx-auto px-4 flex gap-6 h-12 items-center">
        {links.map(({ href, label }) => {
          const active = href === '/' ? path === '/' : path.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              style={{
                color: active ? 'var(--accent)' : 'var(--muted)',
                fontWeight: active ? 600 : 400,
                fontSize: '15px',
              }}
            >
              {label}
            </Link>
          )
        })}
        {/* Account + data export/import now live inside /settings (D-08 declutter).
            The gear sits where 已登录/退出 used to — the single right-side affordance. */}
        <Link
          href="/settings"
          aria-label="设置"
          style={{ marginLeft: 'auto', color: settingsActive ? 'var(--accent)' : 'var(--muted)', display: 'flex', alignItems: 'center', flexShrink: 0 }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
      </div>
    </nav>
  )
}
