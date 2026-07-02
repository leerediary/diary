/**
 * D-03 snapshot column model. Current/future month → live habits.
 * Past month → habits with >=1 completion that month, resolved against a
 * tombstone-inclusive habit list so archived habits keep their recorded
 * history (D-03/D-04).
 */
import { Habit, HabitCompletion } from '@/lib/types'

export function deriveMonthColumns(
  liveHabits: Habit[],
  allHabits: Habit[],
  completions: Pick<HabitCompletion, 'habit_id'>[],
  isCurrentMonth: boolean,
): Habit[] {
  if (isCurrentMonth) {
    return liveHabits
  }

  // Past month: column set is the habits that have >=1 completion that month
  const habitIdsInMonth = new Set(completions.map(c => c.habit_id))
  return allHabits
    .filter(h => habitIdsInMonth.has(h.id))
    .sort((a, b) => a.sort_order - b.sort_order)
}
