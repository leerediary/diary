import type { Entity } from '@/lib/repository'
import type { JournalEntry } from '@/lib/types'
import { db } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { createSupabaseRepository } from '@/lib/supabase-repository'
import { decideSyncAction, SyncAction, type SyncRow } from '@/lib/sync-decision'
import { getSyncState, setSyncState } from '@/lib/sync-state'

// PUSH_ORDER: stable entity order for outbox drain (push phase).
// Must be stable across cycles for deterministic ordering (D-09).
const PUSH_ORDER: Entity[] = ['habits', 'habit_completions', 'long_term_tasks', 'journal_entries', 'pomodoro_sessions']

// NATURAL_KEY: entities whose server row identity is a natural key (enforced by
// a UNIQUE constraint + ON CONFLICT upsert that may rewrite the row id), not the
// id. The pull phase uses these to recognize a server-rewritten id as the same
// logical record and avoid creating a duplicate local row. Entities absent here
// are reconciled by id only (their server upsert is ON CONFLICT (id)).
const NATURAL_KEY: Partial<Record<Entity, (r: SyncRow) => string>> = {
  // \u0000 separator: can't appear in a UUID or YYYY-MM-DD, so no key collision.
  habit_completions: (r) => `${(r as SyncRow & { habit_id: string }).habit_id}\u0000${(r as SyncRow & { date: string }).date}`,
  journal_entries: (r) => (r as SyncRow & { date: string }).date,
}

/**
 * Enqueue a local mutation into the persistent Dexie outbox.
 *
 * Uses the compound [entity+id] primary key — so a second offline mutation
 * to the same (entity, id) pair overwrites the prior entry (latest payload
 * only). This makes replay idempotent by construction: the server-side LWW
 * guard (0002 strict >) treats a replayed equal-timestamp write as a no-op.
 *
 * Called by SyncingLocalRepository after every successful local write.
 * Also called by SyncEngine.mergeJournalConflict for the merged journal entry.
 */
export async function enqueueOutbox(
  entity: Entity,
  operation: 'upsert' | 'softDelete',
  payload: unknown,
): Promise<void> {
  const row = payload as { id: string }
  await db.outbox.put({
    id: row.id,
    entity,
    operation,
    payload: operation === 'upsert' ? payload : null,
    queuedAt: new Date().toISOString(),
    failCount: 0,
  })
}

/**
 * SyncEngine: orchestrates the push-then-pull sync cycle.
 *
 * Push phase (this plan, 06-01):
 *   Drains the persistent Dexie outbox to the remote Supabase server in stable
 *   entity order. Guard-rejected writes (data=null, no error) are treated as
 *   success (remote already newer — Phase-5 B.4). Network failures increment
 *   failCount and break the entity loop; outbox entries are retained indefinitely
 *   (D-09: no max attempts).
 *
 * Pull phase: implemented in 06-02.
 *
 * Guard discipline: db is only accessed inside runCycle() (called client-side
 * by SyncTrigger). SyncEngine must not be constructed at module scope or during
 * build-time prerender (IndexedDB absent in Node).
 */
export class SyncEngine {
  constructor(
    private local: LocalRepository,
    // Optional injected remote — used in tests to provide a mock.
    // Production callers leave this undefined; createSupabaseRepository() is used.
    private remoteOverride?: Pick<ReturnType<typeof createSupabaseRepository>, 'list' | 'upsert' | 'softDelete'>,
  ) {}

  async runCycle(): Promise<void> {
    let retried = false
    while (true) {
      try {
        await this._runCycleInner()
        return
      } catch (e) {
        if (
          !retried &&
          e instanceof Error &&
          (e.name === 'InvalidStateError' || e.name === 'DatabaseClosedError')
        ) {
          console.warn('[SyncEngine] db-level error detected; attempting db reopen:', e.name)
          retried = true
          db.close()
          await db.open()
        } else {
          console.error('[SyncEngine] runCycle failed:', e)
          return
        }
      }
    }
  }

  private async _runCycleInner(): Promise<void> {
    const remote = this.remoteOverride ?? createSupabaseRepository()

    // ── PUSH PHASE ──
    // Drain the outbox in stable entity order, oldest-first per entity.
    const allEntries = await db.outbox.toArray()

    for (const entity of PUSH_ORDER) {
      const entries = allEntries
        .filter((e) => e.entity === entity)
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))

      for (const entry of entries) {
        try {
          if (entry.operation === 'upsert') {
            // Backfill completed_at for outbox entries created by pre-17.1 code
            // (outbox survives app rebuilds but pre-17.1 entries lack the NOT NULL column).
            const payload = entry.payload as Record<string, unknown> | null
            if (payload && entity === 'habit_completions' && !payload.completed_at) {
              ;(payload as Record<string, unknown>).completed_at = payload.updated_at
            }
            await remote.upsert(entity, entry.payload)
            // A guard-rejected stale/equal write returns data=null with NO error —
            // the server LWW guard (0002 strict >) means "remote already newer".
            // Treat as success: remove from outbox. (Phase-5 B.4 — idempotent replay.)
          } else {
            await remote.softDelete(entity, entry.id)
          }
          await db.outbox.delete([entity, entry.id])
        } catch (e) {
          // Re-throw db-level errors so runCycle's outer try-catch can handle reopen.
          if (e instanceof Error && (e.name === 'InvalidStateError' || e.name === 'DatabaseClosedError')) {
            throw e
          }
          // Network failure / RPC rejection: retain entry, increment failCount, continue.
          console.error(`sync push failed (${entity} ${entry.id.slice(0, 8)}):`, e)
          await db.outbox.update([entity, entry.id], {
            failCount: (entry.failCount ?? 0) + 1,
          })
          // Skip this entry; continue with remaining entries for this entity.
          continue
        }
      }
    }

    // ── PULL PHASE ──
    // Read the persisted high-water mark (server-clock only — never device clock).
    const lastMeta = await db.sync_meta.get('last_pulled_at')
    let lastPulledAt: string | undefined = lastMeta?.value

    // Bootstrap-seed rule (RESEARCH Q3): if last_pulled_at is unset and local rows
    // already exist (e.g. device bootstrapped via pullAll), seed last_pulled_at to
    // max(all local rows' updated_at) BEFORE the incremental pull — so the first
    // incremental cycle does not refetch every row.
    if (!lastPulledAt) {
      let maxLocalUpdatedAt = ''
      for (const entity of PUSH_ORDER) {
        const localRows = await this.local.list<SyncRow>(entity, { includeDeleted: true })
        for (const r of localRows) {
          if (r.updated_at > maxLocalUpdatedAt) maxLocalUpdatedAt = r.updated_at
        }
      }
      if (maxLocalUpdatedAt) {
        lastPulledAt = maxLocalUpdatedAt
        await db.sync_meta.put({ key: 'last_pulled_at', value: maxLocalUpdatedAt })
      }
    }

    // Build a Set of "entity:id" for all current outbox rows — looked up once so
    // decideSyncAction remains a pure synchronous call (no DB inside the loop).
    const outboxEntries = await db.outbox.toArray()
    const outboxSet = new Set(outboxEntries.map((e) => `${e.entity}:${e.id}`))

    // Track the maximum server-returned updated_at across APPLY/APPLY_TOMBSTONE/SKIP
    // rows (JOURNAL_CONFLICT rows are excluded so the conflicted row is re-encountered
    // next cycle — RESEARCH Q6 no-silent-loss-on-defer override of §4 sketch).
    let maxUpdatedAt = lastPulledAt ?? ''

    // Accumulate conflict dates across the pull loop; fed to banner state after the loop.
    const journalConflictDates: string[] = []

    for (const entity of PUSH_ORDER) {
      const remoteRows = await remote.list<SyncRow>(entity, {
        sinceUpdatedAt: lastPulledAt,
        includeDeleted: true,
      })

      // Build a local id-map for this entity to avoid N individual DB reads.
      const localRows = await this.local.list<SyncRow>(entity, { includeDeleted: true })
      const localById = new Map(localRows.map((r) => [r.id, r]))

      // Natural-key index (habit_completions / journal_entries only). The server
      // upsert reconciles by natural key and rewrites the row id to the latest
      // writer's (0009 lww_upsert_habit_completions: ON CONFLICT (habit_id,date)
      // DO UPDATE SET id = EXCLUDED.id). So a pulled row may be the SAME logical
      // record as a local row that has a DIFFERENT id. Matching by id alone would
      // insert a second local row and orphan the original — the duplicate-✓ bug.
      // We therefore fall back to a natural-key match and drop the superseded row.
      const naturalKeyOf = NATURAL_KEY[entity]
      const localByNaturalKey = naturalKeyOf
        ? new Map(localRows.map((r) => [naturalKeyOf(r), r]))
        : null

      for (const pulled of remoteRows) {
        // Prefer an exact id match; fall back to the natural-key match so a
        // server-rewritten id is recognized as the same record (not a new row).
        let localRow = localById.get(pulled.id) ?? null
        if (!localRow && localByNaturalKey) {
          localRow = localByNaturalKey.get(naturalKeyOf!(pulled)) ?? null
        }
        // Outbox membership keys on the LOCAL row's id (what was enqueued), which
        // may differ from pulled.id when ids have diverged.
        const inOutbox = outboxSet.has(`${entity}:${localRow?.id ?? pulled.id}`)
        const action = decideSyncAction(localRow, pulled, entity, inOutbox)

        if (action === SyncAction.APPLY || action === SyncAction.APPLY_TOMBSTONE) {
          // If the winning pulled row supersedes a local row under the same
          // natural key but with a DIFFERENT id, drop the old row FIRST. This
          // both removes the duplicate and frees the journal_entries `&date`
          // unique slot so the verbatim bulkLoad below cannot ConstraintError.
          if (localRow && localRow.id !== pulled.id) {
            await this.local.hardDelete(entity, localRow.id)
          }
          // bulkLoad writes the pulled row VERBATIM — preserves server id/updated_at/deleted_at.
          // NEVER use local.upsert here: upsert re-stamps updated_at=now() and clears deleted_at,
          // which would resurrect tombstones and corrupt server-clock authority (Pitfall 2).
          await this.local.bulkLoad(entity, [pulled])
          if (pulled.updated_at > maxUpdatedAt) maxUpdatedAt = pulled.updated_at
        } else if (action === SyncAction.SKIP) {
          // Local is newer; do nothing. Still advance the high-water mark so we
          // don't re-fetch this row on the next cycle.
          if (pulled.updated_at > maxUpdatedAt) maxUpdatedAt = pulled.updated_at
        } else if (action === SyncAction.JOURNAL_CONFLICT) {
          // JOURNAL_CONFLICT: merge winner-on-top + loser-below-divider (D-06/D-07).
          // On success: advance HWM normally (merged write is the new winner).
          // On error: do NOT advance HWM past this row's updated_at — the conflicted
          // row is re-encountered next cycle (RESEARCH Q6 no-silent-loss-on-defer).
          try {
            const conflictDate = await this.mergeJournalConflict(
              localRow as unknown as JournalEntry,
              pulled as unknown as JournalEntry,
            )
            journalConflictDates.push(conflictDate)
            // On success: advance HWM normally.
            if (pulled.updated_at > maxUpdatedAt) maxUpdatedAt = pulled.updated_at
          } catch (err) {
            console.error('[SyncEngine] mergeJournalConflict failed — deferring row:', err)
            // Do NOT advance maxUpdatedAt past this row's updated_at so it is
            // re-encountered next cycle. No silent loss.
          }
        }
      }
    }

    // Advance the high-water mark — server-clock values only, never new Date().
    if (maxUpdatedAt && maxUpdatedAt !== lastPulledAt) {
      await db.sync_meta.put({ key: 'last_pulled_at', value: maxUpdatedAt })
    }

    // ── BANNER STATE (D-10 threshold-gated) ──
    // D-10: unsynced banner only when failCount >= 3 OR oldest entry age > 5 min.
    // Threshold values (Claude's-Discretion D-10): 3 attempts / 5 minutes.
    // Brief/transient offline use shows nothing (D-04 invisible in steady state).
    const remainingOutbox = await db.outbox.toArray()
    const maxFailCount = remainingOutbox.reduce((m, e) => Math.max(m, e.failCount ?? 0), 0)
    const oldestEntry = remainingOutbox.reduce<typeof remainingOutbox[0] | null>(
      (oldest, e) => (!oldest || e.queuedAt < oldest.queuedAt ? e : oldest),
      null,
    )
    const oldestAgeMs = oldestEntry ? Date.now() - new Date(oldestEntry.queuedAt).getTime() : 0
    const unsyncedCount =
      maxFailCount >= 3 || oldestAgeMs > 5 * 60 * 1000 ? remainingOutbox.length : 0

    setSyncState({ ...getSyncState(), unsyncedCount, conflictDates: journalConflictDates })
  }

  /**
   * Merge a journal conflict: winner (newer updated_at) on top, loser appended
   * below a human-readable divider (D-06/D-07). The merged result is written back
   * locally as a NEW write (fresh updated_at) and enqueued to the outbox so the
   * next cycle pushes it as the new server winner.
   *
   * Tie rule: pulled.updated_at >= local.updated_at → pulled is winner (consistent
   * with LWW server-clock authority; ties go to the server-authoritative value).
   */
  private async mergeJournalConflict(
    local: JournalEntry,
    pulled: JournalEntry,
  ): Promise<string> {
    // D-07: winner = newer updated_at; tie → pulled wins (server-clock authority).
    const winner = pulled.updated_at >= local.updated_at ? pulled : local
    const loser = pulled.updated_at >= local.updated_at ? local : pulled

    // D-06: divider format per RESEARCH §user_constraints Claude's Discretion.
    const ts = new Date()
      .toLocaleString('zh-CN', { hour12: false })  // device-local (was Asia/Shanghai)
      .slice(0, 16)
    const divider = `\n\n--- 冲突副本 [${ts}] ---\n\n`
    const mergedContent = winner.content + divider + loser.content

    // Write back locally as a NEW write (saveJournal stamps a fresh updated_at=now()).
    // This is a live row for an existing live date — honors UNIQUE(date).
    await this.local.saveJournal(pulled.date, mergedContent)

    // Read the merged row back to get the fresh id/updated_at for outbox enqueue.
    const allRows = await this.local.list<JournalEntry>('journal_entries', { includeDeleted: false })
    const mergedRow = allRows.find((r) => r.date === pulled.date)
    if (!mergedRow) {
      throw new Error(`[SyncEngine] mergeJournalConflict: merged row not found for date ${pulled.date}`)
    }

    // Enqueue the merged row so the next cycle pushes it as the new winner (D-07).
    await enqueueOutbox('journal_entries', 'upsert', mergedRow)

    return pulled.date
  }
}
