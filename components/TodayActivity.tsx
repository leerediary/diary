'use client'

import type { Habit, HabitCompletion, LongTermTask, PomodoroSession } from '@/lib/types'
import { dayKey, getDayOffsetHours } from '@/lib/today'

interface Props {
  habits: Habit[]
  completions: HabitCompletion[]
  pomodoros: PomodoroSession[]
  tasks: LongTermTask[]
  today: string  // YYYY-MM-DD (device-local). Passed in so the component does not recompute the day.
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      // No timeZone option → device-local (was hardcoded Asia/Shanghai).
    })
  } catch {
    return ''
  }
}

export interface TodayActivityRow {
  kind: 'habit' | 'pomodoro'
  time: string  // empty string on orphan habit rows
  sortKey: string
  habitName: string | null
  durationMin?: number
  noteLines: string[]
  // Pomodoro inline link " · name". Either the linked task or the linked habit
  // (a session has at most one). Each pomodoro carries its OWN notes (above);
  // this label only names what the session was attached to.
  linkName?: string
  linkKind?: 'task' | 'habit'
  // Renders a ✓ after linkName:
  //   task  → this session marked the task complete (marked_task_complete)
  //   habit → the habit was completed today; shown once, on the EARLIEST
  //           today's pomodoro linked to that habit.
  linkCompleted?: boolean
}

export function buildTodayActivityRows(
  habits: Habit[],
  completions: HabitCompletion[],
  pomodoros: PomodoroSession[],
  tasks: LongTermTask[],
  today: string,
  offsetHours = 0,
): TodayActivityRow[] {
  const habitName = new Map(habits.map(h => [h.id, h.name]))
  const taskById = new Map<string, LongTermTask>(tasks.map(t => [t.id, t]))

  const completionByHabit = new Map<string, HabitCompletion>()
  for (const c of completions) {
    if (c.deleted_at != null) continue
    completionByHabit.set(c.habit_id, c)
  }

  const todayPomodoros = pomodoros
    .filter(p => p.deleted_at == null && dayKey(p.started_at, offsetHours) === today)
    .sort((a, b) => a.started_at.localeCompare(b.started_at))

  // For each completed habit linked to today's pomodoros, the EARLIEST such
  // pomodoro is the "marker" row: it shows the habit-completion ✓ and absorbs
  // any habit-note lines that did NOT come from a pomodoro (typed directly in
  // the checklist) so they aren't lost. All note texts shown under each habit's
  // pomodoros are collected to subtract those pomodoro-originated lines.
  const markerPomodoroOfHabit = new Map<string, string>()  // habit_id → pomodoro.id
  const pomodoroNotesByHabit = new Map<string, Set<string>>()
  for (const p of todayPomodoros) {
    if (p.habit_id == null) continue
    if (!pomodoroNotesByHabit.has(p.habit_id)) pomodoroNotesByHabit.set(p.habit_id, new Set())
    const set = pomodoroNotesByHabit.get(p.habit_id)!
    for (const n of p.notes ?? []) set.add(n)
    if (completionByHabit.has(p.habit_id) && !markerPomodoroOfHabit.has(p.habit_id)) {
      markerPomodoroOfHabit.set(p.habit_id, p.id)
    }
  }

  const rows: TodayActivityRow[] = []

  for (const p of todayPomodoros) {
    // Each pomodoro binds its OWN notes — no shared/unshared filtering.
    const noteLines = [...(p.notes ?? [])]
    let linkName: string | undefined
    let linkKind: 'task' | 'habit' | undefined
    let linkCompleted: boolean | undefined

    if (p.task_id != null) {
      linkName = taskById.get(p.task_id)?.name ?? '(已删除的任务)'
      linkKind = 'task'
      linkCompleted = p.marked_task_complete === true
    } else if (p.habit_id != null) {
      linkName = habitName.get(p.habit_id) ?? '(已归档)'
      linkKind = 'habit'
      const isMarker = markerPomodoroOfHabit.get(p.habit_id) === p.id
      linkCompleted = isMarker
      if (isMarker) {
        // Append checklist-only habit notes (in the completion note but not from
        // any of this habit's pomodoros) under the marker pomodoro — lossless.
        const c = completionByHabit.get(p.habit_id)!
        const pomoNotes = pomodoroNotesByHabit.get(p.habit_id) ?? new Set<string>()
        const habitOnly = (c.note ?? '').split('\n').filter(l => l.trim() !== '' && !pomoNotes.has(l))
        noteLines.push(...habitOnly)
      }
    }

    rows.push({
      kind: 'pomodoro',
      time: formatTime(p.started_at),
      sortKey: p.started_at,
      habitName: null,
      durationMin: Math.round(p.duration_sec / 60),
      noteLines,
      linkName,
      linkKind,
      linkCompleted,
    })
  }

  // Orphan habit rows: completed today, no linked pomodoro picked them up.
  for (const c of completions) {
    if (c.deleted_at != null) continue
    if (markerPomodoroOfHabit.has(c.habit_id)) continue
    const note = (c.note ?? '').trim()
    const noteLines = note === '' ? [] : note.split('\n').filter(l => l.trim() !== '')
    rows.push({
      kind: 'habit',
      time: formatTime(c.completed_at),
      sortKey: c.completed_at,
      habitName: habitName.get(c.habit_id) ?? '(已归档)',
      noteLines,
    })
  }

  return rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
}

export default function TodayActivity({ habits, completions, pomodoros, tasks, today }: Props) {
  const rows = buildTodayActivityRows(habits, completions, pomodoros, tasks, today, getDayOffsetHours())

  // D-16: hide entire block when empty.
  if (rows.length === 0) return null

  // D-17: read-only — no interactive elements.
  return (
    <div>
      <h2 style={{
        fontSize: '17px',
        fontWeight: 600,
        color: '#1d1d1f',
        marginBottom: '16px',
      }}>
        今日活动
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {rows.map((row, idx) => {
          if (row.kind === 'habit') {
            // Orphan habit (no pomodoro picked it up as tail today): show time + ✓ + name
            return (
              <div key={`h-${idx}`} style={{ fontSize: '15px', color: 'var(--foreground)', lineHeight: 1.47 }}>
                <span style={{ fontWeight: 600 }}>{row.time}</span>
                {' ✓ '}
                <span>{row.habitName}</span>
                {row.noteLines.length > 0 && (
                  <div style={{ marginTop: '4px', marginLeft: '24px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {row.noteLines.map((line, i) => (
                      <div key={i} style={{ color: 'var(--muted)', fontSize: '14px' }}>
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          }
          return (
            <div key={`p-${idx}`} style={{ fontSize: '15px', color: 'var(--foreground)', lineHeight: 1.47 }}>
              <span style={{ fontWeight: 600 }}>{row.time}</span>
              {' 🍅 '}
              <span>{row.durationMin}min</span>
              {row.linkName && (
                <>
                  {' · '}
                  <span>{row.linkName}</span>
                  {row.linkCompleted && <span style={{ color: 'var(--accent)' }}>{' ✓'}</span>}
                </>
              )}
              {row.noteLines.length > 0 && (
                <div style={{ marginTop: '4px', marginLeft: '24px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {row.noteLines.map((line, i) => (
                    <div key={i} style={{ color: 'var(--muted)', fontSize: '14px' }}>
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
