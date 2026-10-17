'use client'

import Link from 'next/link'
import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { getRepository } from '@/lib/repository-provider'
import type { Habit, HabitCompletion, JournalEntry, LongTermTask, PomodoroSession } from '@/lib/types'
import HabitChecklist from '@/components/HabitChecklist'
import JournalEditor from '@/components/JournalEditor'
import TodayActivity from '@/components/TodayActivity'
import TodayTasks from '@/components/TodayTasks'
import DateNav from '@/components/DateNav'
import { getTodayStr, getDayOffsetHours, dayKey } from '@/lib/today'

interface DayData {
  habits: Habit[]
  completions: HabitCompletion[]
  journal: JournalEntry | null
  tasks: LongTermTask[]
  pomodoros: PomodoroSession[]   // Phase 12 D-12
}

function TodayView() {
  // Derive the selected date from the query string EVERY render (never seed
  // useState once — it changes via client nav; Phase-1 latent-bug class).
  const params = useSearchParams()
  const today = getTodayStr()
  const date = params.get('date') ?? today
  const isToday = date === today

  const [data, setData] = useState<DayData | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    ;(async () => {
      const repo = getRepository()
      const [habits, day, tasks, pomodoros] = await Promise.all([
        repo.listHabits(),
        repo.getDay(date),
        // Phase 14 D-15: full task list (not is_for_today-only) so task-linked 🍅 rows in TodayActivity can show task names on any date.
        repo.listAllTasks(),
        repo.listPomodoroSessions(date),
      ])
      if (!cancelled) {
        setData({ habits, completions: day.completions, journal: day.journal, tasks, pomodoros })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [date, isToday])

  if (!data) {
    return <p style={{ color: 'var(--muted)', fontSize: '15px' }}>加载中…</p>
  }

  const offsetHours = getDayOffsetHours()
  const hasActivity =
    data.completions.some(c => c.deleted_at == null) ||
    data.pomodoros.some(p => p.deleted_at == null && dayKey(p.started_at, offsetHours) === date)

  const completedIds: string[] = []
  const initialNotes: Record<string, string> = {}
  for (const c of data.completions) {
    completedIds.push(c.habit_id)
    initialNotes[c.habit_id] = c.note ?? ''
  }

  return (
    <div className="flex flex-col" style={{ gap: '64px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <DateNav date={date} isToday={isToday} />
      </div>

      <section>
        <h2 style={{ fontSize: '13px', color: 'var(--muted)', fontWeight: 400, marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          习惯打卡
          {isToday && <Link href="/habits" style={{ color: 'var(--muted)', fontSize: '13px', textDecoration: 'none', opacity: 0.6 }}>编辑</Link>}
        </h2>
        <HabitChecklist
          key={date}
          habits={data.habits}
          completedIds={completedIds}
          initialNotes={initialNotes}
          date={date}
          readonly={!isToday}
        />
      </section>

      {isToday && (
        <section>
          <h2 style={{ fontSize: '13px', color: 'var(--muted)', fontWeight: 400, marginBottom: '16px' }}>
            今日待办
          </h2>
          <TodayTasks tasks={data.tasks.filter(t => t.is_for_today && !t.completed)} />
        </section>
      )}

      {hasActivity && (
        <section>
          <TodayActivity
            key={date}
            habits={data.habits}
            completions={data.completions}
            pomodoros={data.pomodoros}
            tasks={data.tasks}
            today={date}
          />
        </section>
      )}

      <section>
        <h2 style={{ fontSize: '13px', color: 'var(--muted)', fontWeight: 400, marginBottom: '16px' }}>
          {isToday ? '今日日记' : '当日日记'}
        </h2>
        <JournalEditor key={date} date={date} initialContent={data.journal?.content ?? ''} readonly={!isToday} />
      </section>
    </div>
  )
}

export default function TodayPage() {
  // useSearchParams() must be inside a Suspense boundary for static export.
  return (
    <Suspense fallback={<p style={{ color: 'var(--muted)', fontSize: '15px' }}>加载中…</p>}>
      <TodayView />
    </Suspense>
  )
}
