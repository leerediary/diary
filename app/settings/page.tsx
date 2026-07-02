'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { DAY_OFFSET_KEY } from '@/lib/today'
import AccountEntry from '@/components/AccountEntry'
import DataPortability from '@/components/DataPortability'
import { LOCAL_ONLY } from '@/lib/local-only'

export default function SettingsPage() {
  const [selectedOffset, setSelectedOffset] = useState<number>(0)
  const router = useRouter()

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DAY_OFFSET_KEY)
      if (raw !== null) {
        const n = parseInt(raw, 10)
        if (!isNaN(n) && n >= 0 && n <= 5) {
          setSelectedOffset(n)
        }
      }
    } catch { /* ignore */ }
  }, [])

  function handleSelect(n: number) {
    setSelectedOffset(n)
    try { localStorage.setItem(DAY_OFFSET_KEY, String(n)) } catch { /* ignore */ }
  }

  function handleBack() {
    router.push('/')
  }

  const offsets = [0, 1, 2, 3, 4, 5]

  return (
    <div>
      <button
        onClick={handleBack}
        style={{
          color: 'var(--accent)',
          fontSize: '15px',
          textDecoration: 'none',
          marginBottom: '32px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          padding: 0,
        }}
      >
        ← 返回
      </button>
      <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '32px' }}>
        设置
      </h1>
      <section>
        <label style={{ fontSize: '13px', color: 'var(--muted)', fontWeight: 400, marginBottom: '16px', display: 'block' }}>
          新的一天从几点开始
        </label>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
          {offsets.map((n, i) => (
            <button
              key={n}
              onClick={() => handleSelect(n)}
              style={{
                background: selectedOffset === n ? '#1d1d1f' : 'transparent',
                color: selectedOffset === n ? '#ffffff' : 'var(--muted)',
                border: 'none',
                borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
                padding: '0 20px',
                height: '36px',
                fontSize: '15px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                lineHeight: 1,
              }}
            >
              {String(n).padStart(2, '0')}
            </button>
          ))}
        </div>
      </section>

      {/* Account + data export/import relocated here from the top nav (D-08
          declutter — the nav now holds only the 4 main tabs + the gear). */}
      {!LOCAL_ONLY && (
        <section style={{ marginTop: '48px' }}>
          <label style={{ fontSize: '13px', color: 'var(--muted)', fontWeight: 400, marginBottom: '16px', display: 'block' }}>
            账户
          </label>
          <AccountEntry />
        </section>
      )}

      <section style={{ marginTop: '48px' }}>
        <label style={{ fontSize: '13px', color: 'var(--muted)', fontWeight: 400, marginBottom: '16px', display: 'block' }}>
          数据
        </label>
        <DataPortability />
      </section>
    </div>
  )
}
