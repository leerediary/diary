// lib/sqlite-repository.ts — Native-SQLite implementation of the Repository
// interface. Drop-in peer of LocalRepository (Dexie/IndexedDB): same method
// surface, same semantics (tombstones, ordering, idempotent date-anchored
// rollover), parameterized SQL only.
//
// Talks exclusively through `window.diaryBridge` (see lib/sqlite-bridge.ts).
// Only the four entity tables live here — the sync-engine queue + cursor tables
// stay in Dexie inside the WKWebView (Frozen-Layer Watchlist, pitfall P-05;
// referenced in 08-PATTERNS.md). Modifying that invariant would force a change
// to lib/sync-engine.ts which violates D-03.
//
// Architectural invariants enforced in this file:
//   - D-03: byte-unchanged frozen sync layer (no edits to sync-engine.ts /
//     sync-decision.ts / syncing-repository.ts).
//   - D-04: the Repository interface is honored exactly, including
//     list opts `sinceUpdatedAt` (STRICT `>` — never `>=` — see P-02) and
//     `includeDeleted`.
//   - P-01: bulkLoad preserves server-supplied updated_at; never re-stamps.
//   - P-03: boolean columns (is_for_today, completed) deserialize as JS
//     booleans, not 0/1 integers.
//   - P-04: nullable columns (deleted_at, parent_id, completed_at,
//     last_rollover_date, note) deserialize as JS `null`, not `undefined`.
//   - P-06: journal_entries.date is UNIQUE; INSERT OR REPLACE honors it.

import type { Repository, Entity } from '@/lib/repository'
import type { Habit, HabitCompletion, JournalEntry, LongTermTask, PomodoroSession } from '@/lib/types'
import { type DiaryBridge, getBridge } from '@/lib/sqlite-bridge'

const ENTITIES: readonly Entity[] = ['habits', 'habit_completions', 'journal_entries', 'long_term_tasks', 'pomodoro_sessions']

function assertEntity(entity: string): asserts entity is Entity {
  if (!(ENTITIES as readonly string[]).includes(entity)) {
    throw new Error(`[SqliteLocalRepository] illegal entity: ${entity}`)
  }
}

// Module-scope schema-ready promise — concurrent constructors all await the
// same promise so the four CREATE TABLE IF NOT EXISTS statements never race.
let schemaReady: Promise<void> | null = null

const now = () => new Date().toISOString()

// Serialize a JS value to a SQLite-safe parameter. Booleans → 0/1, undefined → null.
function serializeValue(v: unknown): unknown {
  if (v === undefined) return null
  if (v === true) return 1
  if (v === false) return 0
  return v
}

// Deserialize a raw SQLite row into the strongly-typed shape the rest of the
// app expects: booleans for is_for_today/completed (P-03), JS null (not
// undefined) for every nullable column (P-04).
function deserializeRow<T>(entity: Entity, row: Record<string, unknown>): T {
  const r: Record<string, unknown> = { ...row }

  // Universal nullable: deleted_at — every entity has it.
  if (r.deleted_at === undefined) r.deleted_at = null

  switch (entity) {
    case 'habits':
      // habits has no nullable nor boolean specific to it beyond deleted_at.
      break
    case 'habit_completions':
      if (r.note === undefined) r.note = null
      if (r.completed_at === undefined) r.completed_at = r.updated_at as string // D-06 backfill fallback
      break
    case 'journal_entries':
      // journal_entries has no other nullable beyond deleted_at.
      break
    case 'long_term_tasks':
      // P-03: integer → boolean
      r.is_for_today = r.is_for_today === 1 || r.is_for_today === true
      r.completed = r.completed === 1 || r.completed === true
      // P-04: nullable normalization
      if (r.parent_id === undefined) r.parent_id = null
      if (r.completed_at === undefined) r.completed_at = null
      if (r.last_rollover_date === undefined) r.last_rollover_date = null
      break
    case 'pomodoro_sessions':
      // Phase 11: notes is JSON-serialized text[]. Parse defensively — corrupt or
      // pre-migration rows fall back to []. The legacy `note` key is ignored
      // (not part of the typed PomodoroSession shape after Phase 11).
      if (typeof r.notes === 'string') {
        try {
          const v = JSON.parse(r.notes)
          r.notes = Array.isArray(v) ? v.filter((x: unknown) => typeof x === 'string') : []
        } catch {
          r.notes = []
        }
      } else if (!Array.isArray(r.notes)) {
        r.notes = []
      }
      // Phase 12: shared_indices is JSON-serialized integer[]. Defensive parse.
      if (typeof r.shared_indices === 'string') {
        try {
          const v = JSON.parse(r.shared_indices)
          r.shared_indices = Array.isArray(v) ? v.filter((x: unknown) => typeof x === 'number') : []
        } catch {
          r.shared_indices = []
        }
      } else if (!Array.isArray(r.shared_indices)) {
        r.shared_indices = []
      }
      if (r.habit_id === undefined) r.habit_id = null
      if (r.task_id === undefined) r.task_id = null
      r.marked_task_complete = r.marked_task_complete === 1 || r.marked_task_complete === true
      break
  }
  return r as T
}

/**
 * Phase 11: serialize entity-specific fields for SQLite storage.
 * Mirrors deserializeRow on the write path. SQLite has no native array type,
 * so pomodoro_sessions.notes (string[]) is JSON-stringified before INSERT.
 * All other entities pass through unchanged.
 */
function serializeRowForDb(entity: Entity, row: Record<string, unknown>): Record<string, unknown> {
  const r = { ...row }
  switch (entity) {
    case 'pomodoro_sessions':
      if (Array.isArray(r.notes)) {
        r.notes = JSON.stringify(r.notes)
      } else {
        r.notes = '[]'
      }
      if (Array.isArray(r.shared_indices)) {
        r.shared_indices = JSON.stringify(r.shared_indices)
      } else {
        r.shared_indices = '[]'
      }
      break
    // Other entities pass through — no serialization needed.
  }
  return r
}

/**
 * SQLite implementation of Repository — selected by repository-provider.ts when
 * the native shell (Plan 08-02) has injected `window.diaryBridge`. Web builds
 * never instantiate this class.
 */
export class SqliteLocalRepository implements Repository {
  private readonly bridge: DiaryBridge | null

  // Bridge may be passed explicitly (used by the Node-side test harness in
  // test/sqlite-repository.test.ts + test/sqlite-converge-verify.ts). When
  // absent, every public method calls getBridge() lazily — the bridge is not
  // touched at module-init time because the Swift WKUserScript injects
  // window.diaryBridge atDocumentStart, which is after this module is loaded.
  constructor(bridge?: DiaryBridge) {
    this.bridge = bridge ?? null
  }

  private getBridgeRef(): DiaryBridge {
    return this.bridge ?? getBridge()
  }

  private execute(sql: string, params: unknown[] = []): Promise<void> {
    return this.getBridgeRef().execute(sql, params.map(serializeValue))
  }

  private query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.getBridgeRef().query<T>(sql, params.map(serializeValue))
  }

  // ── Schema bootstrap ──

  private async ensureSchema(): Promise<void> {
    if (!schemaReady) {
      schemaReady = (async () => {
        const bridge = this.getBridgeRef()
        // habits
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS habits (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             short_name TEXT,
             sort_order INTEGER NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(`CREATE INDEX IF NOT EXISTS habits_updated_at ON habits(updated_at)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS habits_sort_order ON habits(sort_order)`, [])

        // habit_completions
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS habit_completions (
             id TEXT PRIMARY KEY,
             habit_id TEXT NOT NULL,
             date TEXT NOT NULL,
             note TEXT,
             completed_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS hc_habit_date ON habit_completions(habit_id, date)`,
          [],
        )
        await bridge.execute(`CREATE INDEX IF NOT EXISTS hc_date ON habit_completions(date)`, [])
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS hc_updated_at ON habit_completions(updated_at)`,
          [],
        )

        // Phase 17.1 D-11: Add completed_at column with pragma_table_info guard.
        // Two-step: ALTER TABLE then UPDATE (SQLite ADD COLUMN cannot backfill in one step).
        const hasCompletedAt = await bridge.query<{ name: string }>(
          `SELECT name FROM pragma_table_info('habit_completions') WHERE name = 'completed_at'`,
          [],
        )
        if (hasCompletedAt.length === 0) {
          await bridge.execute(
            `ALTER TABLE habit_completions ADD COLUMN completed_at TEXT`,
            [],
          )
          await bridge.execute(
            `UPDATE habit_completions SET completed_at = updated_at WHERE completed_at IS NULL`,
            [],
          )
        }

        // Bugfix (2026-06-05): collapse duplicate habit_completions left by the
        // pre-fix sync. The server rewrites the row id on ON CONFLICT (habit_id,
        // date); the client INSERT OR REPLACE only dedupes on the id PK, and this
        // table had NO UNIQUE(habit_id,date) — so a pulled row with a rewritten id
        // accumulated alongside the original (two live rows → duplicate ✓ in 今日活动).
        // One-time, idempotent (guarded by the unique-index existence): keep the
        // newest updated_at per (habit_id,date), drop the rest, THEN add a UNIQUE
        // index so future INSERT OR REPLACE self-heals — matching the server
        // constraint and the journal_entries(date) UNIQUE already in this schema.
        const hasHcUnique = await bridge.query<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'hc_habit_date_unique'`,
          [],
        )
        if (hasHcUnique.length === 0) {
          await bridge.execute(
            `DELETE FROM habit_completions
               WHERE id NOT IN (
                 SELECT id FROM habit_completions hc
                  WHERE hc.updated_at = (
                    SELECT MAX(x.updated_at) FROM habit_completions x
                     WHERE x.habit_id = hc.habit_id AND x.date = hc.date
                  )
                  GROUP BY hc.habit_id, hc.date
               )`,
            [],
          )
          await bridge.execute(
            `CREATE UNIQUE INDEX hc_habit_date_unique ON habit_completions(habit_id, date)`,
            [],
          )
        }

        // journal_entries — date is UNIQUE (P-06)
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS journal_entries (
             id TEXT PRIMARY KEY,
             date TEXT NOT NULL UNIQUE,
             content TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(`CREATE INDEX IF NOT EXISTS je_updated_at ON journal_entries(updated_at)`, [])

        // long_term_tasks
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS long_term_tasks (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             category TEXT NOT NULL,
             parent_id TEXT,
             is_for_today INTEGER NOT NULL DEFAULT 0,
             delay_days INTEGER NOT NULL DEFAULT 0,
             completed INTEGER NOT NULL DEFAULT 0,
             completed_at TEXT,
             created_at TEXT NOT NULL,
             last_rollover_date TEXT,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(`CREATE INDEX IF NOT EXISTS ltt_updated_at ON long_term_tasks(updated_at)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS ltt_created_at ON long_term_tasks(created_at)`, [])

        // pomodoro_sessions
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS pomodoro_sessions (
             id TEXT PRIMARY KEY,
             started_at TEXT NOT NULL,
             duration_sec INTEGER NOT NULL,
             note TEXT,
             habit_id TEXT,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(`CREATE INDEX IF NOT EXISTS ps_started_at ON pomodoro_sessions(started_at)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS ps_updated_at ON pomodoro_sessions(updated_at)`, [])

        // Phase 11: migrate pomodoro_sessions.note → notes (JSON-serialized text[]).
        // Guarded by pragma_table_info for idempotent re-entry.
        const hasNotesCol = await bridge.query<{ name: string }>(
          `SELECT name FROM pragma_table_info('pomodoro_sessions') WHERE name = 'notes'`,
          [],
        )
        if (hasNotesCol.length === 0) {
          await bridge.execute(
            `ALTER TABLE pomodoro_sessions ADD COLUMN notes TEXT NOT NULL DEFAULT '[]'`,
            [],
          )
          // Backfill: wrap non-empty `note` content in a JSON array.
          await bridge.execute(
            `UPDATE pomodoro_sessions
                SET notes = json_array(note)
              WHERE note IS NOT NULL
                AND note <> ''
                AND notes = '[]'`,
            [],
          )
        }

        // Phase 12: migrate pomodoro_sessions add shared_indices (JSON-serialized integer[]).
        // Guarded by pragma_table_info for idempotent re-entry.
        const hasSharedIndicesCol = await bridge.query<{ name: string }>(
          `SELECT name FROM pragma_table_info('pomodoro_sessions') WHERE name = 'shared_indices'`,
          [],
        )
        if (hasSharedIndicesCol.length === 0) {
          await bridge.execute(
            `ALTER TABLE pomodoro_sessions ADD COLUMN shared_indices TEXT NOT NULL DEFAULT '[]'`,
            [],
          )
          // Backfill per D-08/D-09 rule: shared_indices = [0..notes.length-1] when habit_id IS NOT NULL AND notes is a non-empty JSON array.
          // Otherwise leave as the column DEFAULT '[]'.
          await bridge.execute(
            `UPDATE pomodoro_sessions
                SET shared_indices = (
                  SELECT json_group_array(je.key)
                  FROM json_each(pomodoro_sessions.notes) AS je
                )
              WHERE habit_id IS NOT NULL
                AND notes IS NOT NULL
                AND notes <> '[]'
                AND shared_indices = '[]'`,
            [],
          )
        }

        // Phase 14 D-03: migrate pomodoro_sessions add task_id (nullable TEXT, no DEFAULT).
        // Guarded by pragma_table_info for idempotent re-entry. No backfill —
        // legacy rows leave task_id NULL by default.
        const hasTaskIdCol = await bridge.query<{ name: string }>(
          `SELECT name FROM pragma_table_info('pomodoro_sessions') WHERE name = 'task_id'`,
          [],
        )
        if (hasTaskIdCol.length === 0) {
          await bridge.execute(
            `ALTER TABLE pomodoro_sessions ADD COLUMN task_id TEXT`,
            [],
          )
        }

        // Phase 14-04 D-21: migrate pomodoro_sessions add marked_task_complete (INTEGER 0/1 boolean, NOT NULL DEFAULT 0).
        // Guarded by pragma_table_info for idempotent re-entry. Backfill is implicit via DEFAULT 0.
        const hasMarkedTaskCompleteCol = await bridge.query<{ name: string }>(
          `SELECT name FROM pragma_table_info('pomodoro_sessions') WHERE name = 'marked_task_complete'`,
          [],
        )
        if (hasMarkedTaskCompleteCol.length === 0) {
          await bridge.execute(
            `ALTER TABLE pomodoro_sessions ADD COLUMN marked_task_complete INTEGER NOT NULL DEFAULT 0`,
            [],
          )
        }
      })()
    }
    return schemaReady
  }

  // ── Generic sync-facing core (Repository interface) ──

  async list<T>(
    entity: Entity,
    opts?: { sinceUpdatedAt?: string; includeDeleted?: boolean },
  ): Promise<T[]> {
    assertEntity(entity)
    await this.ensureSchema()
    let sql = `SELECT * FROM ${entity} WHERE 1=1`
    const params: unknown[] = []
    if (opts?.sinceUpdatedAt) {
      // STRICT > — never >= — pitfall P-02
      sql += ` AND updated_at > ?`
      params.push(opts.sinceUpdatedAt)
    }
    if (!opts?.includeDeleted) {
      sql += ` AND deleted_at IS NULL`
    }
    const rows = await this.query<Record<string, unknown>>(sql, params)
    return rows.map((r) => deserializeRow<T>(entity, r))
  }

  async upsert<T>(entity: Entity, row: T): Promise<void> {
    assertEntity(entity)
    await this.ensureSchema()
    const r = serializeRowForDb(entity, { ...(row as Record<string, unknown>) }) as Record<string, unknown> & {
      id?: string
      updated_at?: string
      deleted_at?: string | null
    }
    if (!r.id) r.id = crypto.randomUUID()
    r.updated_at = now()
    if (r.deleted_at === undefined) r.deleted_at = null

    const keys = Object.keys(r)
    const placeholders = keys.map(() => '?').join(', ')
    const values = keys.map((k) => r[k])
    await this.execute(
      `INSERT OR REPLACE INTO ${entity} (${keys.join(', ')}) VALUES (${placeholders})`,
      values,
    )
  }

  async softDelete(entity: Entity, id: string): Promise<void> {
    assertEntity(entity)
    await this.ensureSchema()
    const ts = now()
    await this.execute(
      `UPDATE ${entity} SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      [ts, ts, id],
    )
  }

  /**
   * Hard-delete a single row by id — no tombstone, no outbox, no re-stamp.
   * Mirror of LocalRepository.hardDelete (Dexie). Used ONLY by the sync pull
   * reconcile to drop a local row the server collapsed into a DIFFERENT id
   * under the same natural key (the server rewrites the row id on
   * ON CONFLICT (habit_id,date) / (date)). Pushing a tombstone for the dropped
   * id would be wrong (no server row exists under it), so this bypasses the
   * outbox. Not on the Repository interface — local sync-internal only.
   */
  async hardDelete(entity: Entity, id: string): Promise<void> {
    assertEntity(entity)
    await this.ensureSchema()
    await this.execute(`DELETE FROM ${entity} WHERE id = ?`, [id])
  }

  /**
   * Sync-pull primitive: load rows EXACTLY as received — preserving server
   * `id`, `updated_at`, and `deleted_at` — via INSERT OR REPLACE with the raw
   * payload. DELIBERATELY bypasses `upsert` (which re-stamps `updated_at = now()`).
   * Re-stamping on a pull would destroy server-clock authority and corrupt
   * future LWW sync (pitfall P-01). Not on the Repository interface — same
   * shape as LocalRepository.bulkLoad. Wrapped in a single BEGIN/COMMIT for
   * a tight transaction.
   */
  async bulkLoad(entity: Entity, rows: unknown[]): Promise<void> {
    assertEntity(entity)
    await this.ensureSchema()
    if (rows.length === 0) return
    await this.execute('BEGIN', [])
    try {
      for (const row of rows) {
        const r = serializeRowForDb(entity, row as Record<string, unknown>)
        const keys = Object.keys(r)
        const placeholders = keys.map(() => '?').join(', ')
        const values = keys.map((k) => r[k])
        await this.execute(
          `INSERT OR REPLACE INTO ${entity} (${keys.join(', ')}) VALUES (${placeholders})`,
          values,
        )
      }
      await this.execute('COMMIT', [])
    } catch (e) {
      await this.execute('ROLLBACK', []).catch(() => {})
      throw e
    }
  }

  /**
   * Atomic multi-entity load — every entity inside ONE BEGIN/COMMIT, so any
   * failed row rolls back all writes (mirrors LocalRepository.bulkLoadAll).
   * Used by data-import.ts; preserves server `updated_at`/tombstones verbatim.
   */
  async bulkLoadAll(entries: ReadonlyArray<readonly [Entity, unknown[]]>): Promise<void> {
    await this.ensureSchema()
    await this.execute('BEGIN', [])
    try {
      for (const [entity, rows] of entries) {
        assertEntity(entity)
        for (const row of rows) {
          const r = serializeRowForDb(entity, row as Record<string, unknown>)
          const keys = Object.keys(r)
          const placeholders = keys.map(() => '?').join(', ')
          const values = keys.map((k) => r[k])
          await this.execute(
            `INSERT OR REPLACE INTO ${entity} (${keys.join(', ')}) VALUES (${placeholders})`,
            values,
          )
        }
      }
      await this.execute('COMMIT', [])
    } catch (e) {
      await this.execute('ROLLBACK', []).catch(() => {})
      throw e
    }
  }

  // ── App-facing methods (mirror lib/local-repository.ts one-for-one) ──

  async listHabits(): Promise<Habit[]> {
    await this.ensureSchema()
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM habits WHERE deleted_at IS NULL ORDER BY sort_order ASC`,
      [],
    )
    return rows.map((r) => deserializeRow<Habit>('habits', r))
  }

  async getDay(
    date: string,
  ): Promise<{ completions: HabitCompletion[]; journal: JournalEntry | null }> {
    await this.ensureSchema()
    const completionsRaw = await this.query<Record<string, unknown>>(
      `SELECT * FROM habit_completions WHERE date = ? AND deleted_at IS NULL`,
      [date],
    )
    const completions = completionsRaw.map((r) => deserializeRow<HabitCompletion>('habit_completions', r))

    const journalRaw = await this.query<Record<string, unknown>>(
      `SELECT * FROM journal_entries WHERE date = ? LIMIT 1`,
      [date],
    )
    const journalRow = journalRaw[0]
      ? deserializeRow<JournalEntry>('journal_entries', journalRaw[0])
      : null
    const journal = journalRow && journalRow.deleted_at == null ? journalRow : null
    return { completions, journal }
  }

  async getHabit(id: string): Promise<Habit | null> {
    await this.ensureSchema()
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM habits WHERE id = ? LIMIT 1`,
      [id],
    )
    if (!rows[0]) return null
    return deserializeRow<Habit>('habits', rows[0])
  }

  async addHabit(name: string, short_name: string): Promise<void> {
    await this.ensureSchema()
    const maxRows = await this.query<{ m: number | null }>(
      'SELECT MAX(sort_order) AS m FROM habits',
      [],
    )
    const nextOrder = (maxRows[0]?.m ?? 0) + 1
    const row: Habit = {
      id: crypto.randomUUID(),
      name,
      short_name,
      sort_order: nextOrder,
      updated_at: now(),
      deleted_at: null,
    }
    const keys = Object.keys(row) as (keyof Habit)[]
    const placeholders = keys.map(() => '?').join(', ')
    const values = keys.map((k) => (row as unknown as Record<string, unknown>)[k as string])
    await this.execute(
      `INSERT OR REPLACE INTO habits (${keys.join(', ')}) VALUES (${placeholders})`,
      values,
    )
  }

  async renameHabit(id: string, name: string): Promise<void> {
    await this.ensureSchema()
    await this.execute(
      `UPDATE habits SET name = ?, updated_at = ? WHERE id = ?`,
      [name, now(), id],
    )
  }

  async updateHabitShortName(id: string, short_name: string): Promise<void> {
    await this.ensureSchema()
    await this.execute(
      `UPDATE habits SET short_name = ?, updated_at = ? WHERE id = ?`,
      [short_name, now(), id],
    )
  }

  async reorderHabits(id: string, direction: 'up' | 'down'): Promise<void> {
    await this.ensureSchema()
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM habits WHERE deleted_at IS NULL ORDER BY sort_order ASC`,
      [],
    )
    const list = rows.map((r) => deserializeRow<Habit>('habits', r))
    const index = list.findIndex((h) => h.id === id)
    const neighborIndex = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || neighborIndex < 0 || neighborIndex >= list.length) return
    const self = list[index]
    const neighbor = list[neighborIndex]
    const ts = now()
    await this.execute(
      `UPDATE habits SET sort_order = ?, updated_at = ? WHERE id = ?`,
      [neighbor.sort_order, ts, self.id],
    )
    await this.execute(
      `UPDATE habits SET sort_order = ?, updated_at = ? WHERE id = ?`,
      [self.sort_order, ts, neighbor.id],
    )
  }

  async archiveHabit(id: string): Promise<void> {
    await this.softDelete('habits', id)
  }

  async restoreHabit(id: string): Promise<void> {
    await this.ensureSchema()
    const ts = now()
    await this.execute(
      `UPDATE habits SET deleted_at = NULL, updated_at = ? WHERE id = ?`,
      [ts, id],
    )
  }

  async savePomodoroSession(session: PomodoroSession): Promise<void> {
    await this.ensureSchema()
    const row: Record<string, unknown> = {
      ...session,
      updated_at: now(),
      deleted_at: session.deleted_at ?? null,
    }
    // Phase 11: notes must be JSON-serialized for SQLite (no native array type).
    const serialized = serializeRowForDb('pomodoro_sessions', row)
    const keys = Object.keys(serialized)
    const placeholders = keys.map(() => '?').join(', ')
    const values = keys.map((k) => serialized[k])
    await this.execute(
      `INSERT OR REPLACE INTO pomodoro_sessions (${keys.join(', ')}) VALUES (${placeholders})`,
      values,
    )
  }

  async listPomodoroSessions(sinceDate: string): Promise<PomodoroSession[]> {
    await this.ensureSchema()
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM pomodoro_sessions WHERE started_at >= ? AND deleted_at IS NULL ORDER BY started_at ASC`,
      [sinceDate],
    )
    return rows.map((r) => deserializeRow<PomodoroSession>('pomodoro_sessions', r))
  }

  async listMonthCompletions(
    startDate: string,
    endDateExclusive: string,
  ): Promise<HabitCompletion[]> {
    await this.ensureSchema()
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM habit_completions WHERE date >= ? AND date < ? AND deleted_at IS NULL`,
      [startDate, endDateExclusive],
    )
    return rows.map((r) => deserializeRow<HabitCompletion>('habit_completions', r))
  }

  async listHabitCompletions(habitId: string): Promise<HabitCompletion[]> {
    await this.ensureSchema()
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM habit_completions WHERE habit_id = ? AND deleted_at IS NULL ORDER BY date DESC`,
      [habitId],
    )
    return rows.map((r) => deserializeRow<HabitCompletion>('habit_completions', r))
  }

  private async findCompletion(
    habitId: string,
    date: string,
  ): Promise<HabitCompletion | undefined> {
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM habit_completions WHERE habit_id = ? AND date = ? LIMIT 1`,
      [habitId, date],
    )
    return rows[0] ? deserializeRow<HabitCompletion>('habit_completions', rows[0]) : undefined
  }

  async setHabitCompleted(habitId: string, date: string, completed: boolean): Promise<void> {
    await this.ensureSchema()
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
      const keys = Object.keys(row) as (keyof HabitCompletion)[]
      const placeholders = keys.map(() => '?').join(', ')
      const values = keys.map((k) => (row as unknown as Record<string, unknown>)[k as string])
      await this.execute(
        `INSERT OR REPLACE INTO habit_completions (${keys.join(', ')}) VALUES (${placeholders})`,
        values,
      )
    } else if (existing) {
      const ts = now()
      await this.execute(
        `UPDATE habit_completions SET deleted_at = ?, updated_at = ? WHERE id = ?`,
        [ts, ts, existing.id],
      )
    }
  }

  async saveHabitNote(habitId: string, date: string, note: string): Promise<void> {
    await this.ensureSchema()
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
    const keys = Object.keys(row) as (keyof HabitCompletion)[]
    const placeholders = keys.map(() => '?').join(', ')
    const values = keys.map((k) => (row as unknown as Record<string, unknown>)[k as string])
    await this.execute(
      `INSERT OR REPLACE INTO habit_completions (${keys.join(', ')}) VALUES (${placeholders})`,
      values,
    )
  }

  async saveJournal(date: string, content: string): Promise<void> {
    await this.ensureSchema()
    // Honors UNIQUE(date) per P-06 via INSERT OR REPLACE.
    const existingRows = await this.query<Record<string, unknown>>(
      `SELECT * FROM journal_entries WHERE date = ? LIMIT 1`,
      [date],
    )
    const existing = existingRows[0]
      ? deserializeRow<JournalEntry>('journal_entries', existingRows[0])
      : undefined
    const row: JournalEntry = {
      id: existing?.id ?? crypto.randomUUID(),
      date,
      content,
      updated_at: now(),
      deleted_at: null,
    }
    const keys = Object.keys(row) as (keyof JournalEntry)[]
    const placeholders = keys.map(() => '?').join(', ')
    const values = keys.map((k) => (row as unknown as Record<string, unknown>)[k as string])
    await this.execute(
      `INSERT OR REPLACE INTO journal_entries (${keys.join(', ')}) VALUES (${placeholders})`,
      values,
    )
  }

  async listTodayTasks(): Promise<LongTermTask[]> {
    await this.ensureSchema()
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM long_term_tasks WHERE deleted_at IS NULL AND is_for_today = 1 AND completed = 0 ORDER BY created_at ASC`,
      [],
    )
    return rows.map((r) => deserializeRow<LongTermTask>('long_term_tasks', r))
  }

  async listAllTasks(): Promise<LongTermTask[]> {
    await this.ensureSchema()
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM long_term_tasks WHERE deleted_at IS NULL ORDER BY created_at ASC`,
      [],
    )
    return rows.map((r) => deserializeRow<LongTermTask>('long_term_tasks', r))
  }

  async addTask(name: string, category: string, isForToday = false): Promise<void> {
    await this.ensureSchema()
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
    const keys = Object.keys(row) as (keyof LongTermTask)[]
    const placeholders = keys.map(() => '?').join(', ')
    const values = keys.map((k) => (row as unknown as Record<string, unknown>)[k as string])
    await this.execute(
      `INSERT OR REPLACE INTO long_term_tasks (${keys.join(', ')}) VALUES (${placeholders})`,
      values,
    )
  }

  async setTaskForToday(taskId: string, isForToday: boolean): Promise<void> {
    await this.ensureSchema()
    await this.execute(
      `UPDATE long_term_tasks SET is_for_today = ?, updated_at = ? WHERE id = ?`,
      [isForToday, now(), taskId],
    )
  }

  async completeTask(taskId: string): Promise<void> {
    await this.ensureSchema()
    const ts = now()
    await this.execute(
      `UPDATE long_term_tasks SET completed = 1, completed_at = ?, is_for_today = 0, updated_at = ? WHERE id = ?`,
      [ts, ts, taskId],
    )
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.softDelete('long_term_tasks', taskId)
  }

  async rolloverTasks(date: string): Promise<void> {
    await this.ensureSchema()
    await this.execute('BEGIN', [])
    try {
      const rows = await this.query<Record<string, unknown>>(
        `SELECT * FROM long_term_tasks`,
        [],
      )
      const tasks = rows.map((r) => deserializeRow<LongTermTask>('long_term_tasks', r))
      for (const t of tasks) {
        if (
          t.deleted_at == null &&
          t.is_for_today &&
          !t.completed &&
          t.last_rollover_date !== date
        ) {
          await this.execute(
            `UPDATE long_term_tasks SET delay_days = ?, is_for_today = 0, last_rollover_date = ?, updated_at = ? WHERE id = ?`,
            [t.delay_days + 1, date, now(), t.id],
          )
        }
      }
      await this.execute('COMMIT', [])
    } catch (e) {
      await this.execute('ROLLBACK', []).catch(() => {})
      throw e
    }
  }
}
