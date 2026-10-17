import { describe, it, expect } from 'vitest'
import { deriveMonthColumns } from '@/lib/month-columns'
import type { Habit, HabitCompletion } from '@/lib/types'

describe('deriveMonthColumns', () => {
  it('current month → columns are exactly the live habits', () => {
    const liveHabits: Habit[] = [
      { id: 'h1', name: 'Habit A', short_name: 'HA', sort_order: 1, updated_at: '2026-01-01', deleted_at: null },
      { id: 'h2', name: 'Habit B', short_name: 'HB', sort_order: 2, updated_at: '2026-01-01', deleted_at: null },
    ]
    const archived: Habit = {
      id: 'h3', name: 'Archived', short_name: 'AR', sort_order: 3, updated_at: '2026-01-01', deleted_at: '2026-05-01',
    }
    const allHabits = [...liveHabits, archived]
    const result = deriveMonthColumns(liveHabits, allHabits, [], true)
    expect(result).toEqual(liveHabits)
    expect(result).toHaveLength(2)
  })

  it('past month with completions including an archived habit → both habits in the column set', () => {
    const habitA: Habit = {
      id: 'h1', name: 'Habit A', short_name: 'HA', sort_order: 1, updated_at: '2026-01-01', deleted_at: null,
    }
    const habitB: Habit = {
      id: 'h2', name: 'Habit B (archived)', short_name: 'HB', sort_order: 2, updated_at: '2026-01-01', deleted_at: '2026-05-01',
    }
    const liveHabits: Habit[] = [habitA]
    const allHabits: Habit[] = [habitA, habitB]
    const completions: Pick<HabitCompletion, 'habit_id'>[] = [
      { habit_id: 'h1' },
      { habit_id: 'h2' },
    ]
    const result = deriveMonthColumns(liveHabits, allHabits, completions, false)
    expect(result).toHaveLength(2)
    expect(result.map(h => h.id)).toContain('h1')
    expect(result.map(h => h.id)).toContain('h2')
  })

  it('past month with zero completions → empty column set', () => {
    const liveHabits: Habit[] = [
      { id: 'h1', name: 'Habit A', short_name: 'HA', sort_order: 1, updated_at: '2026-01-01', deleted_at: null },
    ]
    const allHabits: Habit[] = liveHabits
    const result = deriveMonthColumns(liveHabits, allHabits, [], false)
    expect(result).toEqual([])
  })

  it('past month result is sorted by sort_order', () => {
    const habitA: Habit = {
      id: 'h1', name: 'Habit A', short_name: 'HA', sort_order: 5, updated_at: '2026-01-01', deleted_at: null,
    }
    const habitB: Habit = {
      id: 'h2', name: 'Habit B', short_name: 'HB', sort_order: 1, updated_at: '2026-01-01', deleted_at: null,
    }
    const liveHabits: Habit[] = [habitA, habitB]
    const allHabits: Habit[] = [habitA, habitB]
    const completions: Pick<HabitCompletion, 'habit_id'>[] = [
      { habit_id: 'h1' },
      { habit_id: 'h2' },
    ]
    const result = deriveMonthColumns(liveHabits, allHabits, completions, false)
    expect(result).toHaveLength(2)
    expect(result[0].sort_order).toBe(1)
    expect(result[1].sort_order).toBe(5)
  })
})
