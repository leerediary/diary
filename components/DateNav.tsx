'use client'

import { useRouter } from 'next/navigation'

interface Props {
  date: string
  isToday: boolean
}

function offsetDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  const ny = dt.getUTCFullYear()
  const nm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const nd = String(dt.getUTCDate()).padStart(2, '0')
  return `${ny}-${nm}-${nd}`
}

export default function DateNav({ date, isToday }: Props) {
  const router = useRouter()
  const prev = offsetDate(date, -1)
  const next = offsetDate(date, 1)

  const [y, m, d] = date.split('-').map(Number)
  const wds = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const wd = wds[new Date(y, m - 1, d).getDay()]
  const label = isToday ? `${y}年${m}月${d}日 ${wd}（今天）` : `${y}年${m}月${d}日 ${wd}`

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
      <button
        onClick={() => router.push(`/?date=${prev}`)}
        style={{ color: 'var(--accent)', fontSize: '20px', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1, padding: 0 }}
      >
        ‹
      </button>
      <span style={{ fontSize: '17px', color: 'var(--foreground)', fontWeight: 400, letterSpacing: '-0.01em' }}>{label}</span>
      <button
        onClick={() => { if (!isToday) router.push(`/?date=${next}`) }}
        style={{ color: isToday ? 'var(--border)' : 'var(--accent)', fontSize: '20px', background: 'none', border: 'none', cursor: isToday ? 'default' : 'pointer', lineHeight: 1, padding: 0 }}
      >
        ›
      </button>
      {!isToday && (
        <button
          onClick={() => router.push('/')}
          style={{ fontSize: '13px', color: 'var(--accent)', background: 'none', border: 'none', padding: '0 0 0 8px', cursor: 'pointer' }}
        >
          回今天
        </button>
      )}
    </div>
  )
}
