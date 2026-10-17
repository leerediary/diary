'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { getRepository } from '@/lib/repository-provider'
import type { Habit, HabitCompletion } from '@/lib/types'
import { deriveMonthColumns } from '@/lib/month-columns'
import MonthlyGrid from '@/components/MonthlyGrid'

function MonthlyView() {
  // Derive y/m from the query string every render (changes via client nav).
  const params = useSearchParams()
  // Device-local — current month follows the phone/browser time zone (was Asia/Shanghai).
  const now = new Date()
  const year = parseInt(params.get('y') ?? String(now.getFullYear()))
  const month = parseInt(params.get('m') ?? String(now.getMonth() + 1))

  const monthStr = `${year}-${String(month).padStart(2, '0')}`
  const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`

  // D-03 snapshot column model: current/future month → live habits; past month → completion-derived
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const isCurrentMonth = monthStr === currentMonthStr
  const useLiveHabitColumns = isCurrentMonth || monthStr > currentMonthStr

  const [data, setData] = useState<{ habits: Habit[]; completions: HabitCompletion[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    ;(async () => {
      const repo = getRepository()
      const [liveHabits, allHabits, completions] = await Promise.all([
        repo.listHabits(),
        repo.list<Habit>('habits', { includeDeleted: true }),
        repo.listMonthCompletions(`${monthStr}-01`, `${nextMonth}-01`),
      ])
      const columns = deriveMonthColumns(liveHabits, allHabits, completions, useLiveHabitColumns)
      if (!cancelled) setData({ habits: columns, completions })
    })()
    return () => {
      cancelled = true
    }
  }, [monthStr, nextMonth])

  if (!data) {
    return <p style={{ color: 'var(--muted)', fontSize: '15px' }}>加载中…</p>
  }

  return (
    <MonthlyGrid
      habits={data.habits}
      completions={data.completions}
      year={year}
      month={month}
    />
  )
}

export default function MonthlyPage() {
  return (
    <Suspense fallback={<p style={{ color: 'var(--muted)', fontSize: '15px' }}>加载中…</p>}>
      <MonthlyView />
    </Suspense>
  )
}
