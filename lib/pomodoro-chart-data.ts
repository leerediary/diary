// D-13/D-14 pure chart-data derivation. Given a list of completed pomodoro
// sessions and a day-window size, return one ChartPoint per day in the range
// [today - days + 1, today], where `daily` is the count of sessions whose
// started_at falls on that calendar date and `cumul` is the running total
// across the returned window (NOT all-time). Pure / no I/O / no React — the
// import-testable unit the validation strategy requires (10-VALIDATION.md).

import type { PomodoroSession } from '@/lib/types'
import { dayKey } from '@/lib/today'

export interface ChartPoint {
  /** 'MM-DD' for display on the X axis */
  date: string
  /** Sessions whose started_at falls on this local logical day (dayKey) */
  daily: number
  /** Running total: sum of daily within the returned window up to and including this date */
  cumul: number
}

/**
 * @param sessions  PomodoroSession[] — caller has already filtered tombstones (deleted_at == null)
 * @param days      window size: 7 | 30 | 90 (or any positive integer)
 * @param today     'YYYY-MM-DD' anchoring the end of the window (the chart ends on `today`)
 * @param offsetHours DAY_OFFSET hours; threaded in so this stays pure (caller reads it)
 */
export function buildPomodoroChartData(
  sessions: PomodoroSession[],
  days: number,
  today: string,
  offsetHours = 0,
): ChartPoint[] {
  // Build a date(YYYY-MM-DD) → count map from sessions, keyed by each session's
  // local logical day (dayKey, DAY_OFFSET-aware) so buckets line up with the
  // local `today`-anchored axis below. Was a UTC `.slice(0,10)`, which
  // disagreed with the local day for near-midnight sessions.
  const countMap = new Map<string, number>()
  for (const s of sessions) {
    if (!s.started_at) continue
    const d = dayKey(s.started_at, offsetHours)
    countMap.set(d, (countMap.get(d) ?? 0) + 1)
  }

  // Enumerate every day in [today - days + 1, today], inclusive both ends.
  const end = parseYmd(today)
  const points: ChartPoint[] = []
  let cumul = 0
  for (let i = days - 1; i >= 0; i--) {
    const cur = new Date(end)
    cur.setUTCDate(end.getUTCDate() - i)
    const iso = formatYmd(cur)
    const daily = countMap.get(iso) ?? 0
    cumul += daily
    points.push({ date: iso.slice(5), daily, cumul }) // 'MM-DD'
  }
  return points
}

function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function formatYmd(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
