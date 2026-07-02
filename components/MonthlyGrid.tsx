'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Habit, HabitCompletion } from '@/lib/types'

interface Props {
  /** Precomputed column set from deriveMonthColumns — may include tombstoned (previously-active) habits for past months (D-03/D-04). */
  habits: Habit[]
  completions: Pick<HabitCompletion, 'habit_id' | 'date'>[]
  year: number
  month: number
}

const WDS = ['一', '二', '三', '四', '五', '六', '日']

export default function MonthlyGrid({ habits, completions, year, month }: Props) {
  const router = useRouter()
  const daysInMonth = new Date(year, month, 0).getDate()
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const doneSet = new Set(completions.map(c => `${c.date}::${c.habit_id}`))

  const prevMonth = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 }
  const nextMonth = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }

  const navigate = (y: number, m: number) =>
    router.push(`/monthly?y=${y}&m=${m}`)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <button
          onClick={() => navigate(prevMonth.y, prevMonth.m)}
          style={{ color: 'var(--accent)', fontSize: '20px', cursor: 'pointer', background: 'none', border: 'none', padding: 0, lineHeight: 1 }}
        >
          ‹
        </button>
        <h2 style={{ fontWeight: 600, fontSize: '17px', letterSpacing: '-0.02em' }}>{year}年{month}月</h2>
        <button
          onClick={() => navigate(nextMonth.y, nextMonth.m)}
          style={{ color: 'var(--accent)', fontSize: '20px', cursor: 'pointer', background: 'none', border: 'none', padding: 0, lineHeight: 1 }}
        >
          ›
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed', border: '1px solid var(--border)' }}>
          <colgroup>
            <col style={{ width: '96px' }} />
            {habits.map(h => (
              <col key={h.id} style={{ width: `${100 / habits.length}%` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th style={{ padding: '8px', textAlign: 'left', color: 'var(--muted)', fontSize: '13px', fontWeight: 400, border: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                日期
              </th>
              {habits.map(h => (
                <th key={h.id} style={{ padding: '8px 4px', textAlign: 'center', fontSize: '13px', fontWeight: 400, border: '1px solid var(--border)' }}>
                  <Link href={`/habit?id=${h.id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                    {h.short_name}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: daysInMonth }, (_, i) => {
              const day = i + 1
              const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
              const date = new Date(year, month - 1, day)
              const wd = WDS[date.getDay() === 0 ? 6 : date.getDay() - 1]
              const isToday = dateStr === todayStr
              const isFuture = dateStr > todayStr
              const isWeekend = date.getDay() === 0 || date.getDay() === 6

              return (
                <tr key={day} style={{ background: isToday ? 'var(--card)' : 'transparent' }}>
                  <td style={{
                    padding: '8px',
                    fontSize: '13px',
                    whiteSpace: 'nowrap',
                    color: isWeekend ? '#d96060' : 'var(--foreground)',
                    fontWeight: isToday ? 600 : 400,
                    border: '1px solid var(--border)',
                  }}>
                    {day} 周{wd}
                  </td>
                  {habits.map(h => {
                    const done = doneSet.has(`${dateStr}::${h.id}`)
                    return (
                      <td key={h.id} style={{ padding: '5px 4px', textAlign: 'center', border: '1px solid var(--border)' }}>
                        {isFuture ? (
                          <span style={{ opacity: 0.2, fontSize: '0.6rem' }}>·</span>
                        ) : done ? (
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: '20px', height: '20px',
                            color: 'var(--foreground)', fontSize: '14px', fontWeight: 600,
                          }}>✓</span>
                        ) : (
                          <span style={{
                            display: 'inline-flex', width: '20px', height: '20px',
                            borderRadius: '50%', border: '1.5px solid var(--border)', opacity: 0.35,
                          }} />
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
