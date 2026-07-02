import type { Repository, Entity } from '@/lib/repository'
import type { Habit, HabitCompletion, JournalEntry, LongTermTask, PomodoroSession } from '@/lib/types'
import { LocalRepository } from '@/lib/local-repository'
import { enqueueOutbox } from '@/lib/sync-engine'

/**
 * A transparent delegation wrapper around LocalRepository that intercepts
 * every user-facing mutation and enqueues it into the persistent Dexie outbox.
 *
 * Integration point: repository-provider.ts returns this wrapper instead of
 * bare LocalRepository. All app code continues to use the Repository interface
 * unchanged — the sync concern is fully encapsulated here.
 *
 * CRITICAL: bulkLoad MUST NOT enqueue. It is the pull write path (Phase 6
 * SyncEngine.runCycle pull phase). Enqueueing it would create an infinite
 * sync loop and corrupt server-clock timestamps. bulkLoad is forwarded
 * directly to the inner LocalRepository with no side effects.
 *
 * Enqueue discipline: for every mutating method, we read back the row(s)
 * from the inner repo AFTER the local write, so the enqueued payload carries
 * the LocalRepository-stamped updated_at (not a stale client timestamp).
 */
export class SyncingLocalRepository implements Repository {
  private inner: LocalRepository

  constructor(inner?: LocalRepository) {
    this.inner = inner ?? new LocalRepository()
  }

  // ── Generic sync-core ──

  async list<T>(entity: Entity, opts?: { sinceUpdatedAt?: string; includeDeleted?: boolean }): Promise<T[]> {
    return this.inner.list<T>(entity, opts)
  }

  async upsert<T>(entity: Entity, row: T): Promise<void> {
    await this.inner.upsert(entity, row)
    // Read back the persisted row to capture LocalRepository-stamped updated_at.
    const persisted = row as T & { id?: string }
    if (persisted.id) {
      const rows = await this.inner.list<T & { id: string }>(entity, { includeDeleted: true })
      const saved = rows.find((r) => r.id === persisted.id)
      if (saved) {
        await enqueueOutbox(entity, 'upsert', saved)
      }
    }
  }

  async softDelete(entity: Entity, id: string): Promise<void> {
    await this.inner.softDelete(entity, id)
    await enqueueOutbox(entity, 'softDelete', { id })
  }

  /**
   * Sync-pull primitive: forwarded directly to inner LocalRepository with NO
   * outbox enqueue. This is load-bearing — intercepting this would cause every
   * pulled row to be re-queued, creating an infinite sync loop.
   */
  async bulkLoad(entity: Entity, rows: unknown[]): Promise<void> {
    await this.inner.bulkLoad(entity, rows)
  }

  /** Atomic multi-entity load — forwarded with NO enqueue (same rationale as
   *  bulkLoad: imported rows must not be re-queued into the sync outbox). */
  async bulkLoadAll(entries: ReadonlyArray<readonly [Entity, unknown[]]>): Promise<void> {
    await this.inner.bulkLoadAll(entries)
  }

  /**
   * Sync-pull cleanup primitive: forwarded with NO enqueue. The reconcile drops
   * a superseded duplicate row id (server collapsed it under a different id by
   * natural key); enqueueing a softDelete for that id would be wrong — no server
   * row exists under it. Same no-side-effect discipline as bulkLoad.
   */
  async hardDelete(entity: Entity, id: string): Promise<void> {
    await this.inner.hardDelete(entity, id)
  }

  // ── App-facing queries (pure delegation, no enqueue) ──

  async listHabits(): Promise<Habit[]> {
    return this.inner.listHabits()
  }

  async getDay(date: string): Promise<{ completions: HabitCompletion[]; journal: JournalEntry | null }> {
    return this.inner.getDay(date)
  }

  async getHabit(id: string): Promise<Habit | null> {
    return this.inner.getHabit(id)
  }

  async listMonthCompletions(startDate: string, endDateExclusive: string): Promise<HabitCompletion[]> {
    return this.inner.listMonthCompletions(startDate, endDateExclusive)
  }

  async listHabitCompletions(habitId: string): Promise<HabitCompletion[]> {
    return this.inner.listHabitCompletions(habitId)
  }

  async listPomodoroSessions(sinceDate: string): Promise<PomodoroSession[]> {
    return this.inner.listPomodoroSessions(sinceDate)
  }

  async listTodayTasks(): Promise<LongTermTask[]> {
    return this.inner.listTodayTasks()
  }

  async listAllTasks(): Promise<LongTermTask[]> {
    return this.inner.listAllTasks()
  }

  // ── App-facing mutations (delegate + enqueue) ──

  async setHabitCompleted(habitId: string, date: string, completed: boolean): Promise<void> {
    await this.inner.setHabitCompleted(habitId, date, completed)
    // Read back the affected completion row.
    const rows = await this.inner.list<HabitCompletion>('habit_completions', { includeDeleted: true })
    const row = rows.find((r) => r.habit_id === habitId && r.date === date)
    if (row) {
      await enqueueOutbox('habit_completions', completed ? 'upsert' : 'softDelete', row)
    }
  }

  async saveHabitNote(habitId: string, date: string, note: string): Promise<void> {
    await this.inner.saveHabitNote(habitId, date, note)
    const rows = await this.inner.list<HabitCompletion>('habit_completions', { includeDeleted: true })
    const row = rows.find((r) => r.habit_id === habitId && r.date === date)
    if (row) {
      await enqueueOutbox('habit_completions', 'upsert', row)
    }
  }

  async saveJournal(date: string, content: string): Promise<void> {
    await this.inner.saveJournal(date, content)
    const rows = await this.inner.list<JournalEntry>('journal_entries', { includeDeleted: true })
    const row = rows.find((r) => r.date === date)
    if (row) {
      await enqueueOutbox('journal_entries', 'upsert', row)
    }
  }

  async addTask(name: string, category: string, isForToday = false): Promise<void> {
    // Snapshot tasks before to identify the newly created row.
    const before = new Set((await this.inner.listAllTasks()).map((t) => t.id))
    await this.inner.addTask(name, category, isForToday)
    const after = await this.inner.list<LongTermTask>('long_term_tasks', { includeDeleted: true })
    for (const t of after) {
      if (!before.has(t.id)) {
        await enqueueOutbox('long_term_tasks', 'upsert', t)
        break
      }
    }
  }

  async setTaskForToday(taskId: string, isForToday: boolean): Promise<void> {
    await this.inner.setTaskForToday(taskId, isForToday)
    const rows = await this.inner.list<LongTermTask>('long_term_tasks', { includeDeleted: true })
    const row = rows.find((r) => r.id === taskId)
    if (row) {
      await enqueueOutbox('long_term_tasks', 'upsert', row)
    }
  }

  async completeTask(taskId: string): Promise<void> {
    await this.inner.completeTask(taskId)
    const rows = await this.inner.list<LongTermTask>('long_term_tasks', { includeDeleted: true })
    const row = rows.find((r) => r.id === taskId)
    if (row) {
      await enqueueOutbox('long_term_tasks', 'upsert', row)
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.inner.deleteTask(taskId)
    await enqueueOutbox('long_term_tasks', 'softDelete', { id: taskId })
  }

  async rolloverTasks(date: string): Promise<void> {
    // Snapshot updated_at for all tasks BEFORE the inner call.
    const snapshot = new Map(
      (await this.inner.list<LongTermTask>('long_term_tasks', { includeDeleted: true }))
        .map((t) => [t.id, t.updated_at]),
    )

    await this.inner.rolloverTasks(date)

    // After the inner call, enqueue only rows that are new or have a changed updated_at.
    const after = await this.inner.list<LongTermTask>('long_term_tasks', { includeDeleted: true })
    for (const t of after) {
      const prevUpdatedAt = snapshot.get(t.id)
      if (prevUpdatedAt === undefined || t.updated_at !== prevUpdatedAt) {
        await enqueueOutbox('long_term_tasks', 'upsert', t)
      }
    }
  }

  // ── Habit mutations (delegate + enqueue) ──

  async addHabit(name: string, short_name: string): Promise<void> {
    // Snapshot habit ids before to identify the newly created row.
    const before = new Set(
      (await this.inner.list<Habit>('habits', { includeDeleted: true })).map((h) => h.id),
    )
    await this.inner.addHabit(name, short_name)
    const after = await this.inner.list<Habit>('habits', { includeDeleted: true })
    for (const row of after) {
      if (!before.has(row.id)) {
        await enqueueOutbox('habits', 'upsert', row)
        break
      }
    }
  }

  async renameHabit(id: string, name: string): Promise<void> {
    await this.inner.renameHabit(id, name)
    const rows = await this.inner.list<Habit>('habits', { includeDeleted: true })
    const row = rows.find((r) => r.id === id)
    if (row) {
      await enqueueOutbox('habits', 'upsert', row)
    }
  }

  async updateHabitShortName(id: string, short_name: string): Promise<void> {
    await this.inner.updateHabitShortName(id, short_name)
    const rows = await this.inner.list<Habit>('habits', { includeDeleted: true })
    const row = rows.find((r) => r.id === id)
    if (row) {
      await enqueueOutbox('habits', 'upsert', row)
    }
  }

  async reorderHabits(id: string, direction: 'up' | 'down'): Promise<void> {
    // Snapshot updated_at for all habits BEFORE the inner call (reorder mutates TWO rows).
    const snapshot = new Map(
      (await this.inner.list<Habit>('habits', { includeDeleted: true }))
        .map((h) => [h.id, h.updated_at]),
    )
    await this.inner.reorderHabits(id, direction)
    const after = await this.inner.list<Habit>('habits', { includeDeleted: true })
    for (const row of after) {
      const prevUpdatedAt = snapshot.get(row.id)
      if (prevUpdatedAt === undefined || row.updated_at !== prevUpdatedAt) {
        await enqueueOutbox('habits', 'upsert', row)
      }
    }
  }

  async archiveHabit(id: string): Promise<void> {
    await this.inner.archiveHabit(id)
    await enqueueOutbox('habits', 'softDelete', { id })
  }

  async restoreHabit(id: string): Promise<void> {
    await this.inner.restoreHabit(id)
    const rows = await this.inner.list<Habit>('habits', { includeDeleted: true })
    const row = rows.find((r) => r.id === id)
    if (row) {
      await enqueueOutbox('habits', 'upsert', row)
    }
  }

  async savePomodoroSession(session: PomodoroSession): Promise<void> {
    await this.inner.savePomodoroSession(session)
    // Read back the persisted row to capture LocalRepository-stamped updated_at.
    const rows = await this.inner.list<PomodoroSession>('pomodoro_sessions', { includeDeleted: true })
    const row = rows.find((r) => r.id === session.id)
    if (row) {
      await enqueueOutbox('pomodoro_sessions', 'upsert', row)
    }
  }
}
