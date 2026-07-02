import type { Habit, HabitCompletion, JournalEntry, LongTermTask, PomodoroSession } from '@/lib/types'

export type Entity = 'habits' | 'habit_completions' | 'journal_entries' | 'long_term_tasks' | 'pomodoro_sessions'

/**
 * The single owned storage abstraction for diary-web.
 *
 * Two implementations:
 *  - LocalRepository (Dexie/IndexedDB)        — future on-device source of truth (Phase 3+)
 *  - SupabaseRepository (behavior-preserving)  — backs the running app in Phase 1
 *
 * Binding semantics every implementation MUST honor:
 *  - Inserts create `id` with `crypto.randomUUID()` at insert time.
 *  - Every write sets `updated_at = new Date().toISOString()`. (Phase 1 uses the
 *    client clock; server-trigger authority is introduced in Phase 2.)
 *  - softDelete / deleteTask / un-checking a habit set `deleted_at = updated_at = now()`.
 *    Rows are never physically removed. Reads exclude `deleted_at != null` unless
 *    `includeDeleted` is passed.
 *  - rolloverTasks(date) is idempotent and date-anchored: re-running with the same
 *    `date` is a no-op.
 *
 * (The Phase-1 SupabaseRepository is an explicit compatibility shim and may preserve
 *  legacy hard-delete / non-idempotent behavior against the current Supabase schema;
 *  the full semantics above are realized in LocalRepository and become the Supabase
 *  behavior once the schema is migrated in Phase 2.)
 */
export interface Repository {
  // ── Generic sync-facing core (used by the future SyncEngine, Phase 6) ──

  /** List rows of an entity. `sinceUpdatedAt` filters to rows changed strictly
   *  after that ISO timestamp (tombstones included). `includeDeleted` returns
   *  tombstoned rows too. */
  list<T>(entity: Entity, opts?: { sinceUpdatedAt?: string; includeDeleted?: boolean }): Promise<T[]>
  /** Insert or update by `id`; stamps `updated_at`. Creates `id` if absent. */
  upsert<T>(entity: Entity, row: T): Promise<void>
  /** Tombstone a row by id: sets `deleted_at = updated_at = now()`. Never physical delete. */
  softDelete(entity: Entity, id: string): Promise<void>

  // ── App-facing queries (replace inline Supabase in actions.ts + pages) ──

  /** Live habits ordered by `sort_order`. */
  listHabits(): Promise<Habit[]>
  /** Live completions + journal for a given date (deleted_at filtered out). */
  getDay(date: string): Promise<{ completions: HabitCompletion[]; journal: JournalEntry | null }>
  /** A single habit by id (LIVE OR ARCHIVED), or null if no such row exists.
   *  Archived habits are returned so their read-only detail page renders (D-05). */
  getHabit(id: string): Promise<Habit | null>
  /** Create a new live habit. `sort_order` is assigned as max(existing sort_order) + 1
   *  (appends to the end of the checklist); `deleted_at` is null. */
  addHabit(name: string, short_name: string): Promise<void>
  /** Update a habit's `name`. `short_name` and `sort_order` are unchanged. */
  renameHabit(id: string, name: string): Promise<void>
  /** Update a habit's `short_name` (the compact monthly-grid column header). `name` is unchanged. */
  updateHabitShortName(id: string, short_name: string): Promise<void>
  /** Swap a habit's `sort_order` with its adjacent live-habit neighbor in `direction`.
   *  A no-op when the habit is already at the boundary. */
  reorderHabits(id: string, direction: 'up' | 'down'): Promise<void>
  /** Archive a habit by tombstoning its row (delegates to `softDelete('habits', id)`).
   *  The habit's `habit_completions` rows are NEVER touched — completion history is
   *  always preserved (D-01). */
  archiveHabit(id: string): Promise<void>
  /** Restore an archived habit: clears `deleted_at` to null and advances `updated_at`.
   *  The habit returns to the live set with its full completion history (D-02). */
  restoreHabit(id: string): Promise<void>
  /** Live completions for `[startDate, endDateExclusive)` (monthly grid). */
  listMonthCompletions(startDate: string, endDateExclusive: string): Promise<HabitCompletion[]>
  /** Live completions for one habit, newest date first (habit detail). */
  listHabitCompletions(habitId: string): Promise<HabitCompletion[]>
  /** true → upsert the (habit_id,date) completion, clearing any tombstone & preserving note.
   *  false → soft-delete that completion. */
  setHabitCompleted(habitId: string, date: string, completed: boolean): Promise<void>
  saveHabitNote(habitId: string, date: string, note: string): Promise<void>
  /** Save a completed pomodoro session. `id` must be a client-generated UUID
   *  (caller passes a full PomodoroSession; updated_at and deleted_at are
   *  normalized by the adapter). Only completed 25-min sessions are persisted
   *  (D-03 — there is no incomplete-session write path). */
  savePomodoroSession(session: PomodoroSession): Promise<void>
  /** List non-tombstoned pomodoro sessions with started_at >= sinceDate.
   *  `sinceDate` is a YYYY-MM-DD string; ISO-8601 lexicographic order makes
   *  the prefix comparison correct against full ISO timestamps in started_at. */
  listPomodoroSessions(sinceDate: string): Promise<PomodoroSession[]>
  /** Upsert the journal entry for `date` (unique by date). */
  saveJournal(date: string, content: string): Promise<void>
  /** Live tasks where `is_for_today && !completed`. */
  listTodayTasks(): Promise<LongTermTask[]>
  /** All live tasks. */
  listAllTasks(): Promise<LongTermTask[]>
  /** Create a top-level task. `isForToday` (default false) tags it for the
   *  Today list in one write — used by the today-page quick-add. */
  addTask(name: string, category: string, isForToday?: boolean): Promise<void>
  setTaskForToday(taskId: string, isForToday: boolean): Promise<void>
  /** Mark completed: completed=true, completed_at=now, is_for_today=false. */
  completeTask(taskId: string): Promise<void>
  /** Soft-delete a task. */
  deleteTask(taskId: string): Promise<void>
  /** Date-anchored idempotent rollover. For each task with
   *  `is_for_today && !completed && deleted_at==null && last_rollover_date !== date`:
   *  `delay_days += 1`, `is_for_today = false`, `last_rollover_date = date`.
   *  Re-running with the same `date` changes nothing. */
  rolloverTasks(date: string): Promise<void>
}
