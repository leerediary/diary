'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { getRepository } from '@/lib/repository-provider'
import type { Habit, HabitCompletion } from '@/lib/types'
import HabitCalendar from '@/components/HabitCalendar'

function HabitView() {
  const id = useSearchParams().get('id')
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'missing' } | { status: 'ok'; habit: Habit; completions: HabitCompletion[] }
  >({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    if (!id) {
      setState({ status: 'missing' })
      return
    }
    ;(async () => {
      const repo = getRepository()
      const [habit, completions] = await Promise.all([
        repo.getHabit(id),
        repo.listHabitCompletions(id),
      ])
      if (cancelled) return
      setState(habit ? { status: 'ok', habit, completions } : { status: 'missing' })
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  const backLink = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <Link href="/monthly" style={{ color: 'var(--accent)', fontSize: '15px', textDecoration: 'none' }}>
        ← 月览
      </Link>
    </div>
  )

  if (state.status === 'loading') {
    return <p style={{ color: 'var(--muted)', fontSize: '15px' }}>加载中…</p>
  }

  if (state.status === 'missing') {
    return (
      <div className="flex flex-col" style={{ gap: '40px' }}>
        {backLink}
        <p style={{ color: 'var(--muted)', fontSize: '15px' }}>未找到该习惯</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ gap: '40px' }}>
      {backLink}

      <div>
        <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.2 }}>{state.habit.name}</h1>
        <p style={{ fontSize: '15px', color: 'var(--muted)', marginTop: '8px' }}>
          共打卡 {state.completions.length} 天
        </p>
      </div>

      <HabitCalendar completions={state.completions} />
    </div>
  )
}

export default function HabitPage() {
  return (
    <Suspense fallback={<p style={{ color: 'var(--muted)', fontSize: '15px' }}>加载中…</p>}>
      <HabitView />
    </Suspense>
  )
}
