import { describe, it, expect } from 'vitest'
import { buildTodayActivityRows } from '@/components/TodayActivity'
import type { Habit, HabitCompletion, PomodoroSession } from '@/lib/types'

function makeHabit(id: string, name: string): Habit {
  return { id, name, short_name: '', sort_order: 0, updated_at: '', deleted_at: null }
}

function makeCompletion(habit_id: string, updated_at: string, note: string | null, deleted_at: string | null = null): HabitCompletion {
  return { id: `c-${habit_id}`, habit_id, date: '2026-05-24', note, completed_at: updated_at, updated_at, deleted_at }
}

function makePomodoro(
  started_at: string,
  habit_id: string | null,
  notes: string[],
  shared_indices: number[],
  duration_sec = 1500,
  deleted_at: string | null = null,
): PomodoroSession {
  return { id: `p-${started_at}`, started_at, duration_sec, notes, habit_id, shared_indices, task_id: null, marked_task_complete: false, updated_at: '', deleted_at }
}

const TODAY = '2026-05-24'

describe('buildTodayActivityRows', () => {
  it('returns empty for all-empty inputs', () => {
    expect(buildTodayActivityRows([], [], [], [], TODAY)).toEqual([])
  })

  it('orphan habit (no linked pomodoro): renders with no time, even when note is null', () => {
    const habits = [makeHabit('h1', '运动')]
    const completions = [makeCompletion('h1', '2026-05-24T10:00:00.000Z', null)]
    const rows = buildTodayActivityRows(habits, completions, [], [], TODAY)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'habit', habitName: '运动', noteLines: [] })
    expect(rows[0].time).not.toBe('')
  })

  it('orphan habit with non-empty note: row carries noteLines', () => {
    const habits = [makeHabit('h1', '运动')]
    const completions = [makeCompletion('h1', '2026-05-24T10:00:00.000Z', '跑步30分钟')]
    const rows = buildTodayActivityRows(habits, completions, [], [], TODAY)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'habit', habitName: '运动', noteLines: ['跑步30分钟'] })
    expect(rows[0].time).not.toBe('')
  })

  it('excludes deleted habit completion', () => {
    const habits = [makeHabit('h1', '运动')]
    const completions = [makeCompletion('h1', '2026-05-24T10:00:00.000Z', 'note', '2026-05-24T11:00:00.000Z')]
    expect(buildTodayActivityRows(habits, completions, [], [], TODAY)).toEqual([])
  })

  it('excludes pomodoro from yesterday', () => {
    const p = makePomodoro('2026-05-23T10:00:00.000Z', null, ['note'], [])
    expect(buildTodayActivityRows([], [], [p], [], TODAY)).toEqual([])
  })

  it('pomodoro linked to habit with no completion today: habit name shown, no ✓, all notes bound', () => {
    const habits = [makeHabit('h1', '阅读')]
    const p = makePomodoro('2026-05-24T10:00:00.000Z', 'h1', ['a', 'b'], [0, 1])
    const rows = buildTodayActivityRows(habits, [], [p], [], TODAY)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('pomodoro')
    expect(rows[0]).toMatchObject({ linkName: '阅读', linkKind: 'habit', linkCompleted: false })
    // Each pomodoro binds its OWN notes regardless of shared_indices.
    expect(rows[0].noteLines).toEqual(['a', 'b'])
  })

  it('shared_indices no longer filters: pomodoro always shows all its own notes', () => {
    const habits = [makeHabit('h1', '阅读')]
    const p = makePomodoro('2026-05-24T10:00:00.000Z', 'h1', ['a', 'b', 'c'], [0, 2])
    const rows = buildTodayActivityRows(habits, [], [p], [], TODAY)
    expect(rows).toHaveLength(1)
    expect(rows[0].noteLines).toEqual(['a', 'b', 'c'])
  })

  it('pomodoro without habit shows all notes and no link', () => {
    const p = makePomodoro('2026-05-24T10:00:00.000Z', null, ['a', 'b'], [])
    const rows = buildTodayActivityRows([], [], [p], [], TODAY)
    expect(rows).toHaveLength(1)
    expect(rows[0].habitName).toBeNull()
    expect(rows[0].linkName).toBeUndefined()
    expect(rows[0].noteLines).toEqual(['a', 'b'])
  })

  it('pomodoro linked to completed habit: shows habit name + ✓; checklist-only note absorbed under marker', () => {
    const habits = [makeHabit('h1', 'Tagesschau')]
    // 'TS20…' was typed in the checklist, not shared from this pomodoro.
    const completions = [makeCompletion('h1', '2026-05-24T14:36:00.000Z', 'TS20 2026.5.24')]
    const p = makePomodoro('2026-05-24T14:11:00.000Z', 'h1', ['MH 2026.4.17'], [])
    const rows = buildTodayActivityRows(habits, completions, [p], [], TODAY)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('pomodoro')
    expect(rows[0]).toMatchObject({ linkName: 'Tagesschau', linkKind: 'habit', linkCompleted: true })
    // own note first, then the checklist-only habit note (lossless)
    expect(rows[0].noteLines).toEqual(['MH 2026.4.17', 'TS20 2026.5.24'])
  })

  it('shared pomodoro note is NOT duplicated under the habit marker', () => {
    const habits = [makeHabit('h1', 'Tagesschau')]
    // The completion note equals the pomodoro note (it was shared at submit).
    const completions = [makeCompletion('h1', '2026-05-24T14:36:00.000Z', 'TS20')]
    const p = makePomodoro('2026-05-24T14:11:00.000Z', 'h1', ['TS20'], [0])
    const rows = buildTodayActivityRows(habits, completions, [p], [], TODAY)
    expect(rows).toHaveLength(1)
    // 'TS20' shows once (as the pomodoro's own note), not again as a habit line.
    expect(rows[0].noteLines).toEqual(['TS20'])
    expect(rows[0].linkCompleted).toBe(true)
  })

  it('completed habit with no note: marker shows ✓, no extra note lines', () => {
    const habits = [makeHabit('h1', 'Tagesschau')]
    const completions = [makeCompletion('h1', '2026-05-24T14:36:00.000Z', null)]
    const p = makePomodoro('2026-05-24T14:11:00.000Z', 'h1', [], [])
    const rows = buildTodayActivityRows(habits, completions, [p], [], TODAY)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ linkName: 'Tagesschau', linkCompleted: true })
    expect(rows[0].noteLines).toEqual([])
  })

  it('multiple pomodoros linked to same habit: each binds its own note, only earliest gets ✓', () => {
    const habits = [makeHabit('h1', '文献')]
    // All three notes were shared, so the completion note holds all three lines.
    const completions = [makeCompletion('h1', '2026-05-24T16:36:00.000Z', 'early\nmid\nlate')]
    const pomodoros = [
      makePomodoro('2026-05-24T16:00:00.000Z', 'h1', ['late'], [0]),
      makePomodoro('2026-05-24T14:11:00.000Z', 'h1', ['early'], [0]),
      makePomodoro('2026-05-24T15:00:00.000Z', 'h1', ['mid'], [0]),
    ]
    const rows = buildTodayActivityRows(habits, completions, pomodoros, [], TODAY)
    expect(rows).toHaveLength(3)
    // chronological — each pomodoro keeps ONLY its own note (no cross-contamination)
    expect(rows[0].noteLines).toEqual(['early'])
    expect(rows[1].noteLines).toEqual(['mid'])
    expect(rows[2].noteLines).toEqual(['late'])
    // habit name on every linked pomodoro; ✓ only on the earliest
    expect(rows.every(r => r.linkName === '文献')).toBe(true)
    expect(rows[0].linkCompleted).toBe(true)
    expect(rows[1].linkCompleted).toBe(false)
    expect(rows[2].linkCompleted).toBe(false)
  })

  it('orphan habit + pomodoros: sorted chronologically by sortKey', () => {
    const habits = [makeHabit('h1', '运动')]
    const completions = [makeCompletion('h1', '2026-05-24T14:00:00.000Z', '跑步')]
    const pomodoros = [makePomodoro('2026-05-24T10:00:00.000Z', null, ['番茄'], [])]
    const rows = buildTodayActivityRows(habits, completions, pomodoros, [], TODAY)
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe('pomodoro') // 10:00 < 14:00
    expect(rows[1].kind).toBe('habit')
  })

  it('habit completed AND linked to today\'s pomodoro: only the tail-bearing pomodoro row exists (no orphan)', () => {
    const habits = [makeHabit('h1', 'Tagesschau')]
    const completions = [makeCompletion('h1', '2026-05-24T14:36:00.000Z', 'TS20')]
    const p = makePomodoro('2026-05-24T14:11:00.000Z', 'h1', [], [])
    const rows = buildTodayActivityRows(habits, completions, [p], [], TODAY)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('pomodoro')
  })

  it('groups pomodoros by local logical day (DAY_OFFSET-aware), not UTC prefix', () => {
    const habits = [makeHabit('h1', '阅读')]
    // 02:00Z on the 24th (tests run under TZ=UTC, so local hour = 2).
    const p = makePomodoro('2026-05-24T02:00:00.000Z', 'h1', ['x'], [])
    // offset 0 → logical day is the 24th
    expect(buildTodayActivityRows(habits, [], [p], [], '2026-05-24', 0)).toHaveLength(1)
    // offset 4 → 02:00 < 04:00 → logical day rolls back to the 23rd
    expect(buildTodayActivityRows(habits, [], [p], [], '2026-05-24', 4)).toHaveLength(0)
    expect(buildTodayActivityRows(habits, [], [p], [], '2026-05-23', 4)).toHaveLength(1)
  })
})
