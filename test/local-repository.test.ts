import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import type { Habit, PomodoroSession } from '@/lib/types'

const repo = new LocalRepository(db)

beforeEach(async () => {
  await Promise.all([
    db.habits.clear(),
    db.habit_completions.clear(),
    db.journal_entries.clear(),
    db.long_term_tasks.clear(),
    db.pomodoro_sessions.clear(),
  ])
})

describe('LocalRepository', () => {
  it('creates journal with uuid id + updated_at; getDay returns it', async () => {
    await repo.saveJournal('2026-05-18', 'hello')
    const { journal } = await repo.getDay('2026-05-18')
    expect(journal).not.toBeNull()
    expect(journal!.content).toBe('hello')
    expect(journal!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(journal!.updated_at).toBeTruthy()
    expect(journal!.deleted_at).toBeNull()
  })

  it('saveJournal twice same date → single row, content updated, updated_at advances', async () => {
    await repo.saveJournal('2026-05-18', 'first')
    const a = (await repo.getDay('2026-05-18')).journal!
    await new Promise((r) => setTimeout(r, 5))
    await repo.saveJournal('2026-05-18', 'second')
    const all = await db.journal_entries.toArray()
    expect(all).toHaveLength(1)
    const b = (await repo.getDay('2026-05-18')).journal!
    expect(b.content).toBe('second')
    expect(b.updated_at >= a.updated_at).toBe(true)
  })

  it('habit completion true→false→true preserves row & note; soft-deletes', async () => {
    await repo.setHabitCompleted('h1', '2026-05-18', true)
    await repo.saveHabitNote('h1', '2026-05-18', 'did it')
    const c1 = (await repo.getDay('2026-05-18')).completions
    expect(c1).toHaveLength(1)
    const id1 = c1[0].id
    expect(c1[0].note).toBe('did it')

    await repo.setHabitCompleted('h1', '2026-05-18', false)
    expect((await repo.getDay('2026-05-18')).completions).toHaveLength(0)
    const withDeleted = await repo.list<{ id: string; deleted_at: string | null }>('habit_completions', {
      includeDeleted: true,
    })
    expect(withDeleted).toHaveLength(1)
    expect(withDeleted[0].deleted_at).not.toBeNull()

    await repo.setHabitCompleted('h1', '2026-05-18', true)
    const c2 = (await repo.getDay('2026-05-18')).completions
    expect(c2).toHaveLength(1)
    expect(c2[0].id).toBe(id1) // same logical row
    expect(c2[0].deleted_at).toBeNull()
  })

  it('deleteTask soft-deletes (row stays as tombstone)', async () => {
    await repo.addTask('task A', 'cat')
    const t = (await repo.listAllTasks())[0]
    await repo.deleteTask(t.id)
    expect(await repo.listAllTasks()).toHaveLength(0)
    const all = await db.long_term_tasks.toArray()
    expect(all).toHaveLength(1)
    expect(all[0].deleted_at).not.toBeNull()
  })

  it('rolloverTasks is idempotent and date-anchored', async () => {
    await repo.addTask('task X', 'cat')
    const t0 = (await repo.listAllTasks())[0]
    await repo.setTaskForToday(t0.id, true)

    await repo.rolloverTasks('2026-05-18')
    let t = (await db.long_term_tasks.get(t0.id))!
    expect(t.delay_days).toBe(1)
    expect(t.is_for_today).toBe(false)
    expect(t.last_rollover_date).toBe('2026-05-18')

    // Same date again → no-op
    await repo.rolloverTasks('2026-05-18')
    t = (await db.long_term_tasks.get(t0.id))!
    expect(t.delay_days).toBe(1)

    // Different date but task no longer is_for_today → unchanged
    await repo.rolloverTasks('2026-05-19')
    t = (await db.long_term_tasks.get(t0.id))!
    expect(t.delay_days).toBe(1)
  })

  it('addTask(…, isForToday=true) creates a task already in listTodayTasks', async () => {
    await repo.addTask('quick today task', '临时', true)
    const today = await repo.listTodayTasks()
    expect(today.map((t) => t.name)).toEqual(['quick today task'])
    expect(today[0].is_for_today).toBe(true)
    // Default (omitted) stays false — backward-compatible.
    await repo.addTask('plain task', 'cat')
    expect((await repo.listTodayTasks()).map((t) => t.name)).toEqual(['quick today task'])
  })

  it('list(sinceUpdatedAt) returns only rows changed after the timestamp, incl. tombstones', async () => {
    await repo.addTask('old', 'cat')
    const cutoff = new Date().toISOString()
    await new Promise((r) => setTimeout(r, 5))
    await repo.addTask('new', 'cat')
    const changed = await repo.list<{ name: string }>('long_term_tasks', {
      sinceUpdatedAt: cutoff,
      includeDeleted: true,
    })
    expect(changed.map((r) => r.name)).toEqual(['new'])
  })

  describe('habit editing', () => {
    it('addHabit creates a live habit with uuid id, deleted_at null, sort_order set', async () => {
      await repo.addHabit('阅读', '阅读')
      const habits = await repo.listHabits()
      expect(habits).toHaveLength(1)
      expect(habits[0].id).toMatch(/^[0-9a-f-]{36}$/)
      expect(habits[0].name).toBe('阅读')
      expect(habits[0].short_name).toBe('阅读')
      expect(habits[0].deleted_at).toBeNull()
      expect(typeof habits[0].sort_order).toBe('number')
    })

    it('addHabit appends sort_order greater than every existing habit', async () => {
      await repo.addHabit('A', 'A')
      await repo.addHabit('B', 'B')
      const habits = await repo.listHabits()
      expect(habits).toHaveLength(2)
      expect(habits[0].name).toBe('A')
      expect(habits[1].name).toBe('B')
      expect(habits[1].sort_order).toBeGreaterThan(habits[0].sort_order)
    })

    it('renameHabit updates name only and advances updated_at', async () => {
      await repo.addHabit('旧习惯', '旧')
      const habits = await repo.listHabits()
      const id = habits[0].id
      const origShortName = habits[0].short_name
      const origSortOrder = habits[0].sort_order
      const origUpdatedAt = habits[0].updated_at
      await new Promise((r) => setTimeout(r, 5))
      await repo.renameHabit(id, '晨跑')
      const all = await repo.list<Habit>('habits', { includeDeleted: true })
      const h = all.find((r) => r.id === id)!
      expect(h.name).toBe('晨跑')
      expect(h.short_name).toBe(origShortName)
      expect(h.sort_order).toBe(origSortOrder)
      expect(h.updated_at >= origUpdatedAt).toBe(true)
    })

    it('updateHabitShortName updates short_name only', async () => {
      await repo.addHabit('跑步', '跑步')
      const habits = await repo.listHabits()
      const id = habits[0].id
      const origName = habits[0].name
      await repo.updateHabitShortName(id, '跑')
      const all = await repo.list<Habit>('habits', { includeDeleted: true })
      const h = all.find((r) => r.id === id)!
      expect(h.short_name).toBe('跑')
      expect(h.name).toBe(origName)
    })

    it('archiveHabit tombstones the habit and never touches completions', async () => {
      await repo.addHabit('测试', '测试')
      const habits = await repo.listHabits()
      const habitId = habits[0].id
      await repo.setHabitCompleted(habitId, '2026-05-18', true)
      await repo.archiveHabit(habitId)
      const live = await repo.listHabits()
      expect(live).toHaveLength(0)
      const withDeleted = await repo.list<Habit>('habits', { includeDeleted: true })
      expect(withDeleted).toHaveLength(1)
      expect(withDeleted[0].deleted_at).not.toBeNull()
      const completions = await repo.listHabitCompletions(habitId)
      expect(completions).toHaveLength(1)
    })

    it('restoreHabit clears the tombstone and advances updated_at; listHabits includes it again', async () => {
      await repo.addHabit('测试', '测试')
      const habits = await repo.listHabits()
      const id = habits[0].id
      await repo.archiveHabit(id)
      const archived = (await repo.list<Habit>('habits', { includeDeleted: true })).find((r) => r.id === id)!
      const archivedUpdatedAt = archived.updated_at
      await new Promise((r) => setTimeout(r, 5))
      await repo.restoreHabit(id)
      const live = await repo.listHabits()
      expect(live).toHaveLength(1)
      expect(live[0].deleted_at).toBeNull()
      expect(live[0].updated_at >= archivedUpdatedAt).toBe(true)
    })

    it('reorderHabits up swaps adjacent sort_order', async () => {
      await repo.addHabit('A', 'A')
      await repo.addHabit('B', 'B')
      let habits = await repo.listHabits()
      expect(habits.map((h) => h.name)).toEqual(['A', 'B'])
      const bId = habits[1].id
      await repo.reorderHabits(bId, 'up')
      habits = await repo.listHabits()
      expect(habits.map((h) => h.name)).toEqual(['B', 'A'])
      // Reorder again at boundary → no-op
      await repo.reorderHabits(bId, 'up')
      habits = await repo.listHabits()
      expect(habits.map((h) => h.name)).toEqual(['B', 'A'])
    })

    it('getHabit returns an archived habit (D-05)', async () => {
      await repo.addHabit('测试', '测试')
      const habits = await repo.listHabits()
      const id = habits[0].id
      await repo.archiveHabit(id)
      const h = await repo.getHabit(id)
      expect(h).not.toBeNull()
      expect(h!.id).toBe(id)
      expect(h!.deleted_at).not.toBeNull()
    })

    it('round-trip: add → archive → restore → rename preserves uuid and completion count', async () => {
      await repo.addHabit('初始', '初')
      const habits = await repo.listHabits()
      const id = habits[0].id
      await repo.setHabitCompleted(id, '2026-05-18', true)
      await repo.archiveHabit(id)
      await repo.restoreHabit(id)
      await repo.renameHabit(id, '重命名')
      const h = await repo.getHabit(id)
      expect(h!.id).toBe(id)
      const completions = await repo.listHabitCompletions(id)
      expect(completions).toHaveLength(1)
    })
  })

  describe('PomodoroSession', () => {
    it('savePomodoroSession persists a row with all D-02 fields + sync meta', async () => {
      const s: PomodoroSession = {
        id: crypto.randomUUID(),
        started_at: '2026-05-23T10:00:00.000Z',
        duration_sec: 1500,
        notes: ['看了三个TS博客'],
        habit_id: null,
        shared_indices: [],
        task_id: null,
        marked_task_complete: false,
        updated_at: '',
        deleted_at: null,
      }
      await repo.savePomodoroSession(s)
      const list = await repo.listPomodoroSessions('2026-05-23')
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(s.id)
      expect(list[0].started_at).toBe(s.started_at)
      expect(list[0].duration_sec).toBe(1500)
      expect(list[0].notes).toEqual(['看了三个TS博客'])
      expect(list[0].habit_id).toBeNull()
      expect(list[0].deleted_at).toBeNull()
      expect(list[0].updated_at).toBeTruthy()
    })

    it('savePomodoroSession with habit_id set persists the link', async () => {
      const s: PomodoroSession = {
        id: crypto.randomUUID(),
        started_at: '2026-05-23T10:00:00.000Z',
        duration_sec: 1500,
        notes: [],
        habit_id: 'h-uuid',
        shared_indices: [],
        task_id: null,
        marked_task_complete: false,
        updated_at: '',
        deleted_at: null,
      }
      await repo.savePomodoroSession(s)
      const list = await repo.listPomodoroSessions('2026-05-23')
      expect(list).toHaveLength(1)
      expect(list[0].habit_id).toBe('h-uuid')
    })

    it('listPomodoroSessions filters by started_at >= sinceDate', async () => {
      await repo.savePomodoroSession({
        id: crypto.randomUUID(), started_at: '2026-05-20T08:00:00.000Z', duration_sec: 1500,
        notes: [], habit_id: null, shared_indices: [], task_id: null, marked_task_complete: false, updated_at: '', deleted_at: null,
      })
      await repo.savePomodoroSession({
        id: crypto.randomUUID(), started_at: '2026-05-22T10:00:00.000Z', duration_sec: 1500,
        notes: [], habit_id: null, shared_indices: [], task_id: null, marked_task_complete: false, updated_at: '', deleted_at: null,
      })
      await repo.savePomodoroSession({
        id: crypto.randomUUID(), started_at: '2026-05-23T14:00:00.000Z', duration_sec: 1500,
        notes: [], habit_id: null, shared_indices: [], task_id: null, marked_task_complete: false, updated_at: '', deleted_at: null,
      })
      const list = await repo.listPomodoroSessions('2026-05-22')
      expect(list).toHaveLength(2)
    })

    it('listPomodoroSessions excludes tombstoned rows', async () => {
      const s: PomodoroSession = {
        id: crypto.randomUUID(), started_at: '2026-05-23T10:00:00.000Z', duration_sec: 1500,
        notes: [], habit_id: null, shared_indices: [], task_id: null, marked_task_complete: false, updated_at: '', deleted_at: null,
      }
      await repo.savePomodoroSession(s)
      await repo.softDelete('pomodoro_sessions', s.id)
      const list = await repo.listPomodoroSessions('2026-05-01')
      expect(list).toHaveLength(0)
      const all = await repo.list<PomodoroSession>('pomodoro_sessions', { includeDeleted: true })
      expect(all).toHaveLength(1)
      expect(all[0].deleted_at).not.toBeNull()
    })

    it('savePomodoroSession is idempotent on the same id', async () => {
      const id = crypto.randomUUID()
      const s1: PomodoroSession = {
        id, started_at: '2026-05-23T10:00:00.000Z', duration_sec: 1500,
        notes: ['first'], habit_id: null, shared_indices: [], task_id: null, marked_task_complete: false, updated_at: '', deleted_at: null,
      }
      const s2: PomodoroSession = {
        id, started_at: '2026-05-23T10:00:00.000Z', duration_sec: 1500,
        notes: ['second'], habit_id: null, shared_indices: [], task_id: null, marked_task_complete: false, updated_at: '', deleted_at: null,
      }
      await repo.savePomodoroSession(s1)
      await repo.savePomodoroSession(s2)
      const list = await repo.listPomodoroSessions('2026-05-23')
      expect(list).toHaveLength(1)
      expect(list[0].notes).toEqual(['second'])
    })

    it('savePomodoroSession preserves shared_indices round-trip', async () => {
      const s: PomodoroSession = {
        id: crypto.randomUUID(),
        started_at: '2026-05-23T12:00:00.000Z',
        duration_sec: 1500,
        notes: ['a', 'b', 'c'],
        habit_id: 'h1',
        shared_indices: [0, 2],
        task_id: null,
        marked_task_complete: false,
        updated_at: '',
        deleted_at: null,
      }
      await repo.savePomodoroSession(s)
      const list = await repo.listPomodoroSessions('2026-05-23')
      expect(list).toHaveLength(1)
      expect(list[0].shared_indices).toEqual([0, 2])
    })
  })
})
