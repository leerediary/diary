import { describe, it, expect } from 'vitest'
import { buildPomodoroChartData, type ChartPoint } from '@/lib/pomodoro-chart-data'
import type { PomodoroSession } from '@/lib/types'

function makeSession(started_at: string): PomodoroSession {
  return {
    id: 'test-id',
    started_at,
    duration_sec: 1500,
    notes: [],
    habit_id: null,
    shared_indices: [],
    task_id: null,
    marked_task_complete: false,
    updated_at: '',
    deleted_at: null,
  }
}

describe('buildPomodoroChartData', () => {
  it('30-day window with zero sessions returns 30 points, all daily=0 cumul=0', () => {
    const result = buildPomodoroChartData([], 30, '2026-05-23')
    expect(result.length).toBe(30)
    for (const p of result) {
      expect(p.daily).toBe(0)
      expect(p.cumul).toBe(0)
    }
    expect(result[result.length - 1].date).toBe('05-23')
    expect(result[0].date).toBe('04-24')
  })

  it('7-day window with sessions on two days aggregates daily count', () => {
    const sessions = [
      makeSession('2026-05-22T10:00:00.000Z'),
      makeSession('2026-05-22T14:30:00.000Z'),
      makeSession('2026-05-20T08:00:00.000Z'),
    ]
    const result = buildPomodoroChartData(sessions, 7, '2026-05-23')
    expect(result.length).toBe(7)
    const day22 = result.find((p) => p.date === '05-22')
    expect(day22).toBeDefined()
    expect(day22!.daily).toBe(2)
    const day20 = result.find((p) => p.date === '05-20')
    expect(day20).toBeDefined()
    expect(day20!.daily).toBe(1)
    const otherDays = result.filter((p) => p.date !== '05-22' && p.date !== '05-20')
    for (const p of otherDays) {
      expect(p.daily).toBe(0)
    }
  })

  it('cumul is monotonically non-decreasing and ends equal to total daily within window', () => {
    const sessions = [
      makeSession('2026-05-22T10:00:00.000Z'),
      makeSession('2026-05-22T14:30:00.000Z'),
      makeSession('2026-05-20T08:00:00.000Z'),
    ]
    const result = buildPomodoroChartData(sessions, 7, '2026-05-23')
    const totalDaily = result.reduce((sum, p) => sum + p.daily, 0)
    expect(totalDaily).toBe(3)
    expect(result[result.length - 1].cumul).toBe(3)
    for (let i = 1; i < result.length; i++) {
      expect(result[i].cumul).toBeGreaterThanOrEqual(result[i - 1].cumul)
    }
  })

  it('sessions outside the window are excluded', () => {
    const sessions = [makeSession('2026-04-23T10:00:00.000Z')]
    // 30 days back from 2026-05-23 inclusive = 2026-04-24 through 2026-05-23
    // 2026-04-23 is OUT
    const result = buildPomodoroChartData(sessions, 30, '2026-05-23')
    for (const p of result) {
      expect(p.daily).toBe(0)
    }
    expect(result[result.length - 1].cumul).toBe(0)
  })

  it('90-day window spanning a year boundary returns 90 points in order', () => {
    const result = buildPomodoroChartData([], 90, '2026-02-15')
    expect(result.length).toBe(90)
    expect(result[0].date).toBe('11-18')
    expect(result[result.length - 1].date).toBe('02-15')
    // Verify no duplicate consecutive dates (MM-DD comparison is sufficient
    // within the same calendar year segment; year-crossing transitions are
    // confirmed by the length + known start/end dates).
    for (let i = 1; i < result.length; i++) {
      expect(result[i].date).not.toBe(result[i - 1].date)
    }
  })

  it('same-date sessions across timezones bin into the same calendar day', () => {
    const sessions = [
      makeSession('2026-05-23T01:00:00.000Z'),
      makeSession('2026-05-23T23:30:00.000Z'),
    ]
    const result = buildPomodoroChartData(sessions, 7, '2026-05-23')
    const day23 = result.find((p) => p.date === '05-23')
    expect(day23).toBeDefined()
    expect(day23!.daily).toBe(2)
  })
})
