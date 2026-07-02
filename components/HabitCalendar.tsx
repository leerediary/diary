'use client'

import { useState } from 'react'
import Link from 'next/link'
import { getTodayStr } from '@/lib/today'

interface Completion {
  date: string
  note: string | null
}

interface Props {
  completions: Completion[]
}

const WDS = ['一', '二', '三', '四', '五', '六', '日']

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

export default function HabitCalendar({ completions }: Props) {
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)

  // Local logical day (matches how completion c.date is written) — was a UTC
  // toISOString().slice(0,10), which highlighted the wrong cell overseas/near midnight.
  const todayStr = getTodayStr()
  const monthStr = `${year}-${String(month).padStart(2, '0')}`

  const monthCompletions = completions.filter(c => c.date.startsWith(monthStr))
  const doneSet = new Set(monthCompletions.map(c => c.date))

  const daysInMonth = getDaysInMonth(year, month)
  const firstDay = new Date(year, month - 1, 1).getDay()
  const startOffset = firstDay === 0 ? 6 : firstDay - 1

  const pastDays = Array.from({ length: daysInMonth }, (_, i) => {
    const d = `${monthStr}-${String(i + 1).padStart(2, '0')}`
    return d <= todayStr
  }).filter(Boolean).length
  const doneDays = monthCompletions.length
  const pct = pastDays > 0 ? Math.round((doneDays / pastDays) * 100) : 0

  const goPrev = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12) }
    else setMonth(m => m - 1)
  }
  const goNext = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1) }
    else setMonth(m => m + 1)
  }

  const notesWithText = monthCompletions
    .filter(c => c.note)
    .sort((a, b) => a.date.localeCompare(b.date))

  const NavBtn = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
    <button
      onClick={onClick}
      style={{
        background: 'none', color: 'var(--accent)', border: 'none',
        cursor: 'pointer', fontSize: '20px', lineHeight: 1, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <NavBtn onClick={goPrev}>‹</NavBtn>
        <span style={{ fontWeight: 600, fontSize: '17px', letterSpacing: '-0.02em' }}>{year}年{month}月</span>
        <NavBtn onClick={goNext}>›</NavBtn>
      </div>

      <div style={{ maxWidth: '280px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '16px' }}>
          {WDS.map(d => (
            <div key={d} style={{ textAlign: 'center', fontSize: '13px', color: 'var(--muted)', padding: '4px 0' }}>
              {d}
            </div>
          ))}
          {Array.from({ length: startOffset }, (_, i) => <div key={`e-${i}`} />)}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const day = i + 1
            const dateStr = `${monthStr}-${String(day).padStart(2, '0')}`
            const done = doneSet.has(dateStr)
            const isFuture = dateStr > todayStr
            const isToday = dateStr === todayStr
            const isWeekend = (startOffset + i) % 7 >= 5
            return (
              <div
                key={day}
                style={{
                  aspectRatio: '1',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  background: done ? 'var(--accent)' : 'transparent',
                  color: done ? 'white' : isFuture ? 'var(--border)' : isWeekend ? '#d96060' : 'var(--foreground)',
                  fontWeight: isToday ? 600 : 400,
                  border: isToday && !done ? '1.5px solid var(--accent)' : 'none',
                  opacity: isFuture ? 0.3 : 1,
                }}
              >
                {day}
              </div>
            )
          })}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', textAlign: 'center', fontSize: '13px', color: 'var(--muted)' }}>
          {doneDays} / {pastDays} 天 {pct}%
        </div>
      </div>

      {notesWithText.length > 0 && (
        <div style={{ marginTop: '40px' }}>
          <div style={{ marginBottom: '8px' }}>
            <span style={{ fontSize: '17px', fontWeight: 600, letterSpacing: '-0.01em' }}>打卡笔记</span>
          </div>
          {notesWithText.map(c => {
            const [, cm, cd] = c.date.split('-').map(Number)
            return (
              <Link
                key={c.date}
                href={`/?date=${c.date}`}
                style={{
                  display: 'flex', gap: '16px', textDecoration: 'none', color: 'inherit',
                  padding: '12px 0', borderBottom: '1px solid var(--border)',
                }}
              >
                <span style={{ fontSize: '15px', color: 'var(--muted)', whiteSpace: 'nowrap', flexShrink: 0, minWidth: '32px' }}>
                  {cm}/{cd}
                </span>
                <span style={{ fontSize: '15px', color: 'var(--foreground)', whiteSpace: 'pre-line' }}>{c.note}</span>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
