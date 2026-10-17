import type { Repository, Entity } from '@/lib/repository'
import type { Habit, HabitCompletion, JournalEntry, LongTermTask, PomodoroSession } from '@/lib/types'
import { db, DiaryDB } from '@/lib/local-db'

const now = () => new Date().toISOString()

/**
 * Dexie/IndexedDB implementation of Repository — the on-device source of truth.
 * Fully realizes the sync-ready semantics (client UUID, updated_at stamping,
 * soft-delete tombstones, idempotent date-anchored rollover). Browser-only;
 * wired into the running app in Phase 3.
 */
export class LocalRepository implements Repository {
  constructor(private readonly d: DiaryDB = db) {}

  private table(entity: Entity) {
    return this.d.table(entity)
  }

  async list<T>(entity: Entity, opts?: { sinceUpdatedAt?: string; includeDeleted?: boolean }): Promise<T[]> {
    let rows = (await this.table(entity).toArray()) as Array<T & { updated_at: string; deleted_at: string | null }>
    if (opts?.sinceUpdatedAt) rows = rows.filter((r) => r.updated_at > opts.sinceUpdatedAt!)
    if (!opts?.includeDeleted) rows = rows.filter((r) => r.deleted_at == null)
    return rows as unknown as T[]
  }

  async upsert<T>(entity: Entity, row: T): Promise<void> {
    const r = row as T & { id?: string; updated_at?: string; deleted_at?: string | null }
    if (!r.id) r.id = crypto.randomUUID()
    r.updated_at = now()
    if (r.deleted_at === undefined) r.deleted_at = null
    await this.table(entity).put(r)
  }

  async softDelete(entity: Entity, id: string): Promise<void> {
    const ts = now()
    await this.table(entity).update(id, { deleted_at: ts, updated_at: ts })
  }

  /**
   * Hard-delete a single row by id — no tombstone, no outbox, no re-stamp.
   *
   * Used ONLY by the sync pull reconcile to drop a local row that the server
   * has collapsed into a DIFFERENT canonical id under the same natural key
   * (habit_completions[habit_id+date] / journal_entries[date]). The server's
   * `ON CONFLICT (natural key) DO UPDATE SET id = EXCLUDED.id` rewrites the row
   * id to the latest writer's; the loser device must drop its now-orphaned old
   * id locally. Pushing a tombstone for it would be wrong (the server row under
   * that id no longer exists), so this bypasses the outbox entirely.
   * Intentionally NOT on the Repository interface — local sync-internal only.
   */
  async hardDelete(entity: Entity, id: string): Promise<void> {
    await this.table(entity).delete(id)
  }

  /**
   * Sync-pull primitive: load rows EXACTLY as received — preserving server
   * `id`, `updated_at`, and `deleted_at` — via a raw Dexie bulkPut.
   *
   * This deliberately BYPASSES `upsert` (which regenerates ids and re-stamps
   * `updated_at = now()`). Re-stamping on a pull would destroy server-clock
   * authority and corrupt future LWW sync, so the bypass is load-bearing, not
   * an optimization. This is the same primitive the Phase 6 sync "pull" reuses.
   * Intentionally NOT on the Repository interface — it is local-only.
   */
  async bulkLoad(entity: Entity, rows: unknown[]): Promise<void> {
    await this.table(entity).bulkPut(rows as object[])
  }

  /**
   * Atomic multi-entity load: every entity in ONE Dexie `rw` transaction, so a
   * failure on any entity — a constraint violation (e.g. the `&date` unique
   * index on journal_entries) or a row missing its `id` keyPath — rolls back
   * ALL writes. The store is never left half-imported. Same verbatim semantics
   * as bulkLoad (no re-stamp, tombstones preserved). Used by data-import.ts;
   * intentionally NOT on the Repository interface — local-only.
   */
  async bulkLoadAll(entries: ReadonlyArray<readonly [Entity, unknown[]]>): Promise<void> {
    const stores = entries.map(([entity]) => entity)
    await this.d.transaction('rw', stores, async () => {
      for (const [entity, rows] of entries) {
        await this.table(entity).bulkPut(rows as object[])
      }
    })
  }

  // ── App-facing ──

  async listHabits(): Promise<Habit[]> {
    const rows = await this.d.habits.toArray()
    return rows.filter((h) => h.deleted_at == null).sort((a, b) => a.sort_order - b.sort_order)
  }

  async getDay(date: string): Promise<{ completions: HabitCompletion[]; journal: JournalEntry | null }> {
    const completions = (await this.d.habit_completions.where('date').equals(date).toArray()).filter(
      (c) => c.deleted_at == null
    )
    const journalRow = await this.d.journal_entries.where('date').equals(date).first()
    const journal = journalRow && journalRow.deleted_at == null ? journalRow : null
    return { completions, journal }
  }

  async getHabit(id: string): Promise<Habit | null> {
    const h = await this.d.habits.get(id)
    return h ?? null
  }

  async addHabit(name: string, short_name: string): Promise<void> {
    const rows = await this.d.habits.toArray()
    const nextOrder = rows.length ? Math.max(...rows.map((h) => h.sort_order)) + 1 : 1
    const row: Habit = {
      id: crypto.randomUUID(),
      name,
      short_name,
      sort_order: nextOrder,
      updated_at: now(),
      deleted_at: null,
    }
    await this.d.habits.put(row)
  }

  async renameHabit(id: string, name: string): Promise<void> {
    await this.d.habits.update(id, { name, updated_at: now() })
  }

  async updateHabitShortName(id: string, short_name: string): Promise<void> {
    await this.d.habits.update(id, { short_name, updated_at: now() })
  }

  async reorderHabits(id: string, direction: 'up' | 'down'): Promise<void> {
    const list = (await this.d.habits.toArray())
      .filter((h) => h.deleted_at == null)
      .sort((a, b) => a.sort_order - b.sort_order)
    const index = list.findIndex((h) => h.id === id)
    const neighborIndex = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || neighborIndex < 0 || neighborIndex >= list.length) return
    const self = list[index]
    const neighbor = list[neighborIndex]
    const ts = now()
    await this.d.habits.update(self.id, { sort_order: neighbor.sort_order, updated_at: ts })
    await this.d.habits.update(neighbor.id, { sort_order: self.sort_order, updated_at: ts })
  }

  async archiveHabit(id: string): Promise<void> {
    await this.softDelete('habits', id)
  }

  async restoreHabit(id: string): Promise<void> {
    const ts = now()
    await this.d.habits.update(id, { deleted_at: null, updated_at: ts })
  }

  async savePomodoroSession(session: PomodoroSession): Promise<void> {
    const row: PomodoroSession = {
      ...session,
      updated_at: now(),
      deleted_at: session.deleted_at ?? null,
    }
    await this.d.pomodoro_sessions.put(row)
  }

  async listPomodoroSessions(sinceDate: string): Promise<PomodoroSession[]> {
    const rows = await this.d.pomodoro_sessions
      .where('started_at')
      .aboveOrEqual(sinceDate)
      .toArray()
    return rows.filter((s) => s.deleted_at == null).sort((a, b) => a.started_at.localeCompare(b.started_at))
  }

  async listMonthCompletions(startDate: string, endDateExclusive: string): Promise<HabitCompletion[]> {
    const rows = await this.d.habit_completions
      .where('date')
      .between(startDate, endDateExclusive, true, false)
      .toArray()
    return rows.filter((c) => c.deleted_at == null)
  }

  async listHabitCompletions(habitId: string): Promise<HabitCompletion[]> {
    const rows = await this.d.habit_completions.where('[habit_id+date]').between([habitId, ''], [habitId, '￿']).toArray()
    return rows.filter((c) => c.deleted_at == null).sort((a, b) => b.date.localeCompare(a.date))
  }

  private async findCompletion(habitId: string, date: string): Promise<HabitCompletion | undefined> {
    return this.d.habit_completions.where('[habit_id+date]').equals([habitId, date]).first()
  }

  async setHabitCompleted(habitId: string, date: string, completed: boolean): Promise<void> {
    const existing = await this.findCompletion(habitId, date)
    if (completed) {
      const row: HabitCompletion = {
        id: existing?.id ?? crypto.randomUUID(),
        habit_id: habitId,
        date,
        note: existing?.note ?? null,
        completed_at: now(), // D-01: always refresh on tap
        updated_at: now(),
        deleted_at: null, // clears any prior tombstone
      }
      await this.d.habit_completions.put(row)
    } else if (existing) {
      const ts = now()
      await this.d.habit_completions.update(existing.id, { deleted_at: ts, updated_at: ts })
    }
  }

  async saveHabitNote(habitId: string, date: string, note: string): Promise<void> {
    const existing = await this.findCompletion(habitId, date)
    const row: HabitCompletion = {
      id: existing?.id ?? crypto.randomUUID(),
      habit_id: habitId,
      date,
      note,
      completed_at: existing?.completed_at ?? now(), // D-02: preserve existing tap time; new row fallback
      updated_at: now(),
      deleted_at: existing?.deleted_at ?? null,
    }
    await this.d.habit_completions.put(row)
  }

  async saveJournal(date: string, content: string): Promise<void> {
    const existing = await this.d.journal_entries.where('date').equals(date).first()
    const row: JournalEntry = {
      id: existing?.id ?? crypto.randomUUID(),
      date,
      content,
      updated_at: now(),
      deleted_at: null,
    }
    await this.d.journal_entries.put(row)
  }

  async listTodayTasks(): Promise<LongTermTask[]> {
    const rows = await this.d.long_term_tasks.toArray()
    return rows
      .filter((t) => t.deleted_at == null && t.is_for_today && !t.completed)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  async listAllTasks(): Promise<LongTermTask[]> {
    const rows = await this.d.long_term_tasks.toArray()
    // Order by created_at so the task tree is stable and consistent across
    // backends (Dexie keys by id/UUID, SQLite by rowid — both unordered
    // otherwise). created_at ISO strings sort chronologically as text.
    return rows
      .filter((t) => t.deleted_at == null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  async addTask(name: string, category: string, isForToday = false): Promise<void> {
    const ts = now()
    const row: LongTermTask = {
      id: crypto.randomUUID(),
      name,
      category,
      parent_id: null,
      is_for_today: isForToday,
      delay_days: 0,
      completed: false,
      completed_at: null,
      created_at: ts,
      last_rollover_date: null,
      updated_at: ts,
      deleted_at: null,
    }
    await this.d.long_term_tasks.put(row)
  }

  async setTaskForToday(taskId: string, isForToday: boolean): Promise<void> {
    await this.d.long_term_tasks.update(taskId, { is_for_today: isForToday, updated_at: now() })
  }

  async completeTask(taskId: string): Promise<void> {
    const ts = now()
    await this.d.long_term_tasks.update(taskId, {
      completed: true,
      completed_at: ts,
      is_for_today: false,
      updated_at: ts,
    })
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.softDelete('long_term_tasks', taskId)
  }

  async rolloverTasks(date: string): Promise<void> {
    await this.d.transaction('rw', this.d.long_term_tasks, async () => {
      const rows = await this.d.long_term_tasks.toArray()
      for (const t of rows) {
        if (t.deleted_at == null && t.is_for_today && !t.completed && t.last_rollover_date !== date) {
          await this.d.long_term_tasks.update(t.id, {
            delay_days: t.delay_days + 1,
            is_for_today: false,
            last_rollover_date: date,
            updated_at: now(),
          })
        }
      }
    })
  }
}
