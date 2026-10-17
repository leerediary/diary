import Dexie, { type Table } from 'dexie'
import type { Entity } from '@/lib/repository'
import type { Habit, HabitCompletion, JournalEntry, LongTermTask, PomodoroSession } from '@/lib/types'

// Single-user diary store. Data volume is tiny (one person's diary), so we
// index only what IndexedDB can key on reliably and filter the rest in memory.
// NOTE: `is_for_today` (boolean) and nullable `parent_id` are intentionally NOT
// indexed — IndexedDB cannot use boolean keys and skips null keys; filtering
// these in memory is correct and cheap at this scale.

/**
 * An entry in the offline outbox — a mutation that has been committed locally
 * but not yet pushed to the remote. The compound [entity+id] primary key means
 * a second offline mutation to the same row overwrites the prior entry (latest
 * payload only), making replay idempotent by construction.
 */
export interface OutboxEntry {
  id: string                         // UUID of the ROW being synced (same as entity row id)
  entity: Entity                     // 'habits' | 'habit_completions' | 'journal_entries' | 'long_term_tasks'
  operation: 'upsert' | 'softDelete'
  payload: unknown                   // full row snapshot at mutation time (for upsert) OR null (for softDelete)
  queuedAt: string                   // ISO timestamp when enqueued (for banner age threshold)
  failCount: number                  // incremented per failed push attempt (for banner threshold)
}

/**
 * A key-value row in the sync_meta table. Distinct from lib/types.ts SyncMeta
 * (which is the per-entity sync-column interface). Named SyncMetaRow to avoid
 * the collision.
 */
export interface SyncMetaRow {
  key: string    // e.g. 'last_pulled_at'
  value: string  // ISO timestamp or other serialized value
}

export class DiaryDB extends Dexie {
  habits!: Table<Habit, string>
  habit_completions!: Table<HabitCompletion, string>
  journal_entries!: Table<JournalEntry, string>
  long_term_tasks!: Table<LongTermTask, string>
  outbox!: Table<OutboxEntry, [string, string]>
  sync_meta!: Table<SyncMetaRow, string>
  pomodoro_sessions!: Table<PomodoroSession, string>

  constructor() {
    super('diary-web')
    this.version(1).stores({
      habits: 'id, sort_order, updated_at',
      habit_completions: 'id, [habit_id+date], date, updated_at',
      journal_entries: 'id, &date, updated_at',
      long_term_tasks: 'id, updated_at, created_at',
    })
    this.version(2).stores({
      // All v1 stores repeated verbatim (Dexie additive version bump requirement)
      habits: 'id, sort_order, updated_at',
      habit_completions: 'id, [habit_id+date], date, updated_at',
      journal_entries: 'id, &date, updated_at',
      long_term_tasks: 'id, updated_at, created_at',
      // New tables added in v2
      outbox: '[entity+id], entity, queuedAt',
      sync_meta: 'key',
    })
    this.version(3).stores({
      // All v2 stores repeated verbatim (Dexie additive version bump requirement)
      habits: 'id, sort_order, updated_at',
      habit_completions: 'id, [habit_id+date], date, updated_at',
      journal_entries: 'id, &date, updated_at',
      long_term_tasks: 'id, updated_at, created_at',
      outbox: '[entity+id], entity, queuedAt',
      sync_meta: 'key',
      // New in v3:
      pomodoro_sessions: 'id, started_at, updated_at',
    })
    this.version(4)
      .stores({
        // All v3 stores repeated verbatim (Dexie additive version bump requirement).
        // The `notes` field is an array — not indexable in IndexedDB — so the
        // schema strings are byte-identical to v3. Only row shape changes.
        habits: 'id, sort_order, updated_at',
        habit_completions: 'id, [habit_id+date], date, updated_at',
        journal_entries: 'id, &date, updated_at',
        long_term_tasks: 'id, updated_at, created_at',
        outbox: '[entity+id], entity, queuedAt',
        sync_meta: 'key',
        pomodoro_sessions: 'id, started_at, updated_at',
      })
      .upgrade(async (tx) => {
        // Phase 11 D-04: PomodoroSession.note (string|null) → notes (string[]).
        // Non-empty note → wrap in single-element array. Null/empty → [].
        // The legacy `note` key is deleted from each row to keep shape clean.
        await tx
          .table('pomodoro_sessions')
          .toCollection()
          .modify((row: { note?: string | null; notes?: string[] }) => {
            const oldNote = row.note ?? null
            row.notes = oldNote && oldNote !== '' ? [oldNote] : []
            delete row.note
          })
      })

    this.version(5)
      .stores({
        // All v4 stores repeated verbatim (Dexie additive version bump requirement).
        // `shared_indices` is a non-indexed number[] field — same shape as `notes`.
        habits: 'id, sort_order, updated_at',
        habit_completions: 'id, [habit_id+date], date, updated_at',
        journal_entries: 'id, &date, updated_at',
        long_term_tasks: 'id, updated_at, created_at',
        outbox: '[entity+id], entity, queuedAt',
        sync_meta: 'key',
        pomodoro_sessions: 'id, started_at, updated_at',
      })
      .upgrade(async (tx) => {
        // Phase 12 D-08: backfill shared_indices.
        // Rule: [] when habit_id is null OR notes is empty.
        // Otherwise [0..notes.length-1] — matches Phase 11 behavior of appending the full notes.join('\n') to the linked habit.
        await tx
          .table('pomodoro_sessions')
          .toCollection()
          .modify((row: { habit_id?: string | null; notes?: string[]; shared_indices?: number[] }) => {
            if (Array.isArray(row.shared_indices)) return // already migrated; idempotent
            const habitId = row.habit_id ?? null
            const notes = Array.isArray(row.notes) ? row.notes : []
            if (habitId == null || notes.length === 0) {
              row.shared_indices = []
            } else {
              row.shared_indices = Array.from({ length: notes.length }, (_, i) => i)
            }
          })
      })

    this.version(6)
      .stores({
        // All v5 stores repeated verbatim (Dexie additive version bump requirement).
        // `task_id` is a non-indexed nullable string — same treatment as `habit_id`.
        // The pomodoro_sessions schema string is byte-identical to v5.
        habits: 'id, sort_order, updated_at',
        habit_completions: 'id, [habit_id+date], date, updated_at',
        journal_entries: 'id, &date, updated_at',
        long_term_tasks: 'id, updated_at, created_at',
        outbox: '[entity+id], entity, queuedAt',
        sync_meta: 'key',
        pomodoro_sessions: 'id, started_at, updated_at',
      })
      .upgrade(async (tx) => {
        // Phase 14 D-02: backfill task_id = null on all existing rows.
        // Legacy sessions are habit-linked or unlinked — none have a task. Idempotent: skip rows
        // that already have a defined task_id key (re-running the upgrade is a no-op).
        await tx
          .table('pomodoro_sessions')
          .toCollection()
          .modify((row: { task_id?: string | null }) => {
            if (row.task_id !== undefined) return // already migrated
            row.task_id = null
          })
      })

    this.version(7)
      .stores({
        // All v6 stores repeated verbatim (Dexie additive version bump requirement).
        // `marked_task_complete` is a non-indexed boolean — no schema string change.
        habits: 'id, sort_order, updated_at',
        habit_completions: 'id, [habit_id+date], date, updated_at',
        journal_entries: 'id, &date, updated_at',
        long_term_tasks: 'id, updated_at, created_at',
        outbox: '[entity+id], entity, queuedAt',
        sync_meta: 'key',
        pomodoro_sessions: 'id, started_at, updated_at',
      })
      .upgrade(async (tx) => {
        // Phase 14-04 D-20: backfill marked_task_complete = false on all existing rows.
        // No opportunistic per-task heuristic — legacy precision loss is accepted (see 14-CONTEXT followup).
        // Idempotent: skip rows that already have a defined marked_task_complete key.
        await tx
          .table('pomodoro_sessions')
          .toCollection()
          .modify((row: { marked_task_complete?: boolean }) => {
            if (row.marked_task_complete !== undefined) return // already migrated
            row.marked_task_complete = false
          })
      })

    // Phase 17.1 D-10: Dexie v8 — add completed_at to habit_completions.
    // Schema string is byte-identical to v7 (completed_at is not indexed).
    // Upgrade backfills completed_at = updated_at with IS NULL guard.
    this.version(8)
      .stores({
        habits: 'id, sort_order, updated_at',
        habit_completions: 'id, [habit_id+date], date, updated_at',
        journal_entries: 'id, &date, updated_at',
        long_term_tasks: 'id, updated_at, created_at',
        outbox: '[entity+id], entity, queuedAt',
        sync_meta: 'key',
        pomodoro_sessions: 'id, started_at, updated_at',
      })
      .upgrade(async (tx) => {
        await tx
          .table('habit_completions')
          .toCollection()
          .modify((row: { completed_at?: string; updated_at?: string }) => {
            if (row.completed_at !== undefined) return // already migrated
            row.completed_at = row.updated_at ?? ''
          })
      })

    // v9 — one-time cleanup of duplicate habit_completions left by the pre-fix
    // sync. The server collapses rows by (habit_id,date) and rewrites the row id
    // to the latest writer's; the loser device pulled that row as a NEW id while
    // keeping its original, so two live rows shared one (habit_id,date) — the
    // duplicate-✓ bug. The sync pull now reconciles by natural key, but rows that
    // already diverged must be swept once here. journal_entries cannot dup (its
    // `&date` index is unique), so only habit_completions needs this.
    // Rule: per (habit_id,date) group, keep the row with the newest updated_at;
    // hard-delete the rest (no tombstone — the kept row is the server's truth).
    // Schema string byte-identical to v8 (no index change).
    this.version(9)
      .stores({
        habits: 'id, sort_order, updated_at',
        habit_completions: 'id, [habit_id+date], date, updated_at',
        journal_entries: 'id, &date, updated_at',
        long_term_tasks: 'id, updated_at, created_at',
        outbox: '[entity+id], entity, queuedAt',
        sync_meta: 'key',
        pomodoro_sessions: 'id, started_at, updated_at',
      })
      .upgrade(async (tx) => {
        const rows = await tx
          .table('habit_completions')
          .toArray() as Array<{ id: string; habit_id: string; date: string; updated_at: string }>
        const winnerByKey = new Map<string, { id: string; updated_at: string }>()
        for (const r of rows) {
          const key = `${r.habit_id} ${r.date}`
          const cur = winnerByKey.get(key)
          // Keep the newest updated_at; ties keep the first seen (stable, arbitrary
          // but consistent — both rows carry identical natural-key semantics).
          if (!cur || r.updated_at > cur.updated_at) winnerByKey.set(key, { id: r.id, updated_at: r.updated_at })
        }
        const loserIds = rows
          .filter((r) => winnerByKey.get(`${r.habit_id} ${r.date}`)!.id !== r.id)
          .map((r) => r.id)
        if (loserIds.length > 0) await tx.table('habit_completions').bulkDelete(loserIds)
      })
  }
}

// Constructing DiaryDB does NOT open IndexedDB — Dexie auto-opens lazily on the
// first table operation. So this module-scope instance is safe to import during
// Node build-time prerender. INVARIANT: never run a query at module scope or
// during render — only inside client effects/handlers (browser has IndexedDB;
// the prerender pass does not). Do not add an eager db.open() here.
export const db = new DiaryDB()
