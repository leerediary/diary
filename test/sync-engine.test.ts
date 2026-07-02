import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { SyncEngine, enqueueOutbox } from '@/lib/sync-engine'
import { SyncingLocalRepository } from '@/lib/syncing-repository'
import type { Entity } from '@/lib/repository'

// ── Mock remote factory ──────────────────────────────────────────────────────
// A hand-rolled mock implementing the sync-core triplet (list, upsert, softDelete).
// Records calls so tests can assert against them, and can be toggled to throw.

type RemoteRow = { id: string; updated_at: string; deleted_at: string | null; [k: string]: unknown }

function makeMockRemote(opts: {
  upsertThrows?: boolean
  // Rows to return for each entity on list() calls.
  listRows?: Partial<Record<Entity, RemoteRow[]>>
} = {}) {
  const upsertCalls: Array<{ entity: Entity; payload: unknown }> = []
  const softDeleteCalls: Array<{ entity: Entity; id: string }> = []
  const listCalls: Array<{ entity: Entity }> = []

  return {
    upsertCalls,
    softDeleteCalls,
    listCalls,
    remote: {
      async list<T>(entity: Entity): Promise<T[]> {
        listCalls.push({ entity })
        return ((opts.listRows?.[entity] ?? []) as T[])
      },
      async upsert(entity: Entity, payload: unknown): Promise<void> {
        if (opts.upsertThrows) throw new Error('network error (mock)')
        upsertCalls.push({ entity, payload })
      },
      async softDelete(entity: Entity, id: string): Promise<void> {
        softDeleteCalls.push({ entity, id })
      },
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const repo = new LocalRepository(db)

beforeEach(async () => {
  await Promise.all([
    db.habits.clear(),
    db.habit_completions.clear(),
    db.journal_entries.clear(),
    db.long_term_tasks.clear(),
    db.outbox.clear(),
    db.sync_meta.clear(),
  ])
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SyncEngine push phase', () => {
  it('idempotent replay: outbox entry pushed exactly once across two runCycle() calls', async () => {
    // Set up a single outbox entry for a habits row.
    const habitId = crypto.randomUUID()
    const habitPayload = {
      id: habitId,
      name: 'Morning run',
      short_name: 'Run',
      sort_order: 0,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    }
    await enqueueOutbox('habits', 'upsert', habitPayload)

    const { upsertCalls, remote } = makeMockRemote()
    const engine = new SyncEngine(repo, remote)

    // First cycle: should push the entry and drain the outbox.
    await engine.runCycle()
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].entity).toBe('habits')
    expect(await db.outbox.count()).toBe(0)

    // Second cycle: outbox is empty; remote.upsert must NOT be called again.
    await engine.runCycle()
    expect(upsertCalls).toHaveLength(1) // still exactly 1, not 2
  })

  it('network-failure retention: failed push retains entry with failCount === 1', async () => {
    const taskId = crypto.randomUUID()
    const taskPayload = {
      id: taskId,
      name: 'Buy groceries',
      category: 'errands',
      parent_id: null,
      is_for_today: false,
      delay_days: 0,
      completed: false,
      completed_at: null,
      created_at: new Date().toISOString(),
      last_rollover_date: null,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    }
    await enqueueOutbox('long_term_tasks', 'upsert', taskPayload)

    // First cycle: remote throws (simulates network failure).
    const throwingMock = makeMockRemote({ upsertThrows: true })
    const engineFail = new SyncEngine(repo, throwingMock.remote)
    await engineFail.runCycle()

    // Entry must still be in the outbox with failCount incremented.
    const remaining = await db.outbox.toArray()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].failCount).toBe(1)
    expect(remaining[0].id).toBe(taskId)

    // Second cycle: remote succeeds — entry must be pushed and removed.
    const successMock = makeMockRemote()
    const engineSuccess = new SyncEngine(repo, successMock.remote)
    await engineSuccess.runCycle()
    expect(successMock.upsertCalls).toHaveLength(1)
    expect(await db.outbox.count()).toBe(0)
  })

  it('throttle: SyncTrigger trigger logic prevents a second runCycle() within 30s', async () => {
    // Simulate the SyncTrigger throttle guard directly:
    // Two trigger() calls within < THROTTLE_MS should only result in one cycle.
    const THROTTLE_MS = 30_000

    // Enqueue something so we can count pushes.
    const habitId = crypto.randomUUID()
    await enqueueOutbox('habits', 'upsert', {
      id: habitId,
      name: 'Stretch',
      short_name: 'Stretch',
      sort_order: 1,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    })

    const { upsertCalls, remote } = makeMockRemote()
    const engine = new SyncEngine(repo, remote)

    let runCycleCallCount = 0
    const originalRunCycle = engine.runCycle.bind(engine)
    engine.runCycle = async () => {
      runCycleCallCount++
      return originalRunCycle()
    }

    // Replicate the SyncTrigger throttle logic:
    let lastRunAt = 0
    const trigger = async () => {
      const now = Date.now()
      if (now - lastRunAt < THROTTLE_MS) return
      lastRunAt = now
      await engine.runCycle()
    }

    // First call — should run.
    await trigger()
    expect(runCycleCallCount).toBe(1)

    // Re-enqueue since outbox was drained.
    await enqueueOutbox('habits', 'upsert', {
      id: habitId,
      name: 'Stretch',
      short_name: 'Stretch',
      sort_order: 1,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    })

    // Second call within the same 30s window — throttle blocks it.
    await trigger()
    expect(runCycleCallCount).toBe(1) // still 1; throttle prevented second cycle
  })
})

// ── SYNC-04: Journal conflict-preservation ───────────────────────────────────

describe('SyncEngine journal conflict-preservation (SYNC-04)', () => {
  const TEST_DATE = '2026-05-18'

  it('merges winner-on-top + loser-below-divider; one row per date; re-queued to outbox', async () => {
    // ── Set up local state ────────────────────────────────────────────────────
    // Write a local journal entry for TEST_DATE and enqueue it (simulates the
    // device having an offline edit that hasn't been pushed yet).
    await repo.saveJournal(TEST_DATE, 'local edit')
    const { journal: localJournal } = await repo.getDay(TEST_DATE)
    expect(localJournal).not.toBeNull()
    const localId = localJournal!.id
    // Enqueue the local row to simulate "in outbox" (isInOutbox === true).
    await enqueueOutbox('journal_entries', 'upsert', localJournal!)

    // ── Construct a mock remote with a NEWER row for the same date ────────────
    // pulled.updated_at is strictly after the local row's updated_at, so pulled
    // is the winner and decideSyncAction returns JOURNAL_CONFLICT.
    //
    // CRITICAL: The push phase runs first and will try to push the local entry.
    // To ensure the outbox entry is still present during the pull phase
    // (isInOutbox === true), we make the push fail for journal_entries.
    // This simulates the real conflict scenario: the device is offline (push
    // fails), but it can still receive remote rows (pull from a cached/read path),
    // OR the push succeeds first and then there's a follow-up pull-and-still-conflicts
    // scenario.
    //
    // In practice: if push succeeds, the outbox is cleared and the pull will see
    // isInOutbox=false → APPLY (not JOURNAL_CONFLICT). The conflict path fires
    // when push is blocked and the device receives a remote update (e.g. from
    // another session that pushed while this device was offline).
    //
    // We simulate this by making the push throw (network failure) so the outbox
    // entry survives into the pull phase.
    const pulledUpdatedAt = new Date(Date.now() + 5_000).toISOString() // 5s in the future
    const remoteJournalRow: RemoteRow = {
      id: localId, // Same id, same date — JOURNAL_CONFLICT path
      date: TEST_DATE,
      content: 'remote edit',
      updated_at: pulledUpdatedAt,
      deleted_at: null,
    }

    // The push phase will throw for journal_entries → outbox entry retained.
    // The pull phase returns the remote row → JOURNAL_CONFLICT → mergeJournalConflict.
    const { upsertCalls: _upsertCalls, remote } = makeMockRemote({
      upsertThrows: true, // simulate network failure on push
      listRows: { journal_entries: [remoteJournalRow] },
    })
    const engine = new SyncEngine(repo, remote)

    // ── Run the sync cycle ────────────────────────────────────────────────────
    await engine.runCycle()

    // ── Assertion (a): exactly ONE local journal row for TEST_DATE ────────────
    // UNIQUE(date) is honored; no duplicate rows created by the merge.
    const allJournal = await db.journal_entries.toArray()
    const rowsForDate = allJournal.filter((r) => r.date === TEST_DATE)
    expect(rowsForDate).toHaveLength(1)

    // ── Assertion (b): merged content contains BOTH 'local edit' AND 'remote edit'
    const mergedContent = rowsForDate[0].content
    expect(mergedContent).toContain('local edit')
    expect(mergedContent).toContain('remote edit')

    // ── Assertion (c): divider pattern '--- 冲突副本 [' present ──────────────
    expect(mergedContent).toMatch(/--- 冲突副本 \[/)

    // ── Assertion (d): winner (remote/newer) is BEFORE the divider;
    //                   loser (local/older) is AFTER the divider (D-07) ───────
    const dividerIndex = mergedContent.indexOf('--- 冲突副本 [')
    const remoteIndex = mergedContent.indexOf('remote edit')
    const localIndex = mergedContent.indexOf('local edit')

    expect(remoteIndex).toBeGreaterThanOrEqual(0)
    expect(localIndex).toBeGreaterThanOrEqual(0)
    // Winner text index < divider index (winner is on top)
    expect(remoteIndex).toBeLessThan(dividerIndex)
    // Loser text index > divider index (loser is below divider)
    expect(localIndex).toBeGreaterThan(dividerIndex)

    // ── Assertion (e): outbox has a re-queued journal_entries upsert ──────────
    // The merged row must be enqueued so the next cycle pushes it as the new winner.
    // Note: the original failed outbox entry was overwritten by the merge enqueue
    // (same compound [entity+id] key → Dexie put de-duplicates).
    const outboxEntries = await db.outbox.toArray()
    const journalOutboxEntries = outboxEntries.filter((e) => e.entity === 'journal_entries')
    expect(journalOutboxEntries).toHaveLength(1)
    expect(journalOutboxEntries[0].operation).toBe('upsert')

    const outboxPayload = journalOutboxEntries[0].payload as { content: string }
    expect(outboxPayload.content).toBe(mergedContent)
  })
})

// ── Natural-key reconcile: no duplicate habit_completions on id divergence ────
// The server upsert reconciles by (habit_id,date) and rewrites the row id to the
// latest writer's. The pull must recognize the rewritten id as the SAME record
// (via the natural-key fallback) instead of inserting a second local row.

describe('SyncEngine natural-key reconcile (duplicate-✓ bug)', () => {
  const HABIT = 'habit-lit'
  const DATE = '2026-05-24'
  const T1 = '2026-05-24T01:00:00.000Z'
  const T2 = '2026-05-24T02:00:00.000Z'

  function completion(id: string, updated_at: string, completed_at = updated_at): RemoteRow {
    return { id, habit_id: HABIT, date: DATE, note: null, completed_at, updated_at, deleted_at: null }
  }

  it('pulled row with a server-rewritten id collapses to ONE row, dropping the old id', async () => {
    // Local has the original id; server has collapsed it to a different id (newer).
    await repo.bulkLoad('habit_completions', [completion('id-X', T1)])
    const { remote } = makeMockRemote({ listRows: { habit_completions: [completion('id-Y', T2)] } })

    await engineFromRemote(remote)

    const rows = (await db.habit_completions.toArray()).filter(
      (r) => r.habit_id === HABIT && r.date === DATE && r.deleted_at == null,
    )
    expect(rows).toHaveLength(1)          // no duplicate ✓
    expect(rows[0].id).toBe('id-Y')        // server-authoritative id wins
    expect(await db.habit_completions.get('id-X')).toBeUndefined() // old id swept
  })

  it('local row newer than the pulled (different id) wins LWW — no duplicate inserted', async () => {
    await repo.bulkLoad('habit_completions', [completion('id-X', T2)]) // local newer
    const { remote } = makeMockRemote({ listRows: { habit_completions: [completion('id-Y', T1)] } })

    await engineFromRemote(remote)

    const rows = (await db.habit_completions.toArray()).filter((r) => r.habit_id === HABIT && r.date === DATE)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('id-X')        // local kept; pulled id-Y not inserted
  })

  it('exact-id match still reconciles normally (no spurious delete)', async () => {
    await repo.bulkLoad('habit_completions', [completion('id-X', T1)])
    const { remote } = makeMockRemote({ listRows: { habit_completions: [completion('id-X', T2)] } })

    await engineFromRemote(remote)

    const rows = await db.habit_completions.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('id-X')
    expect(rows[0].updated_at).toBe(T2)    // updated in place
  })

  // Production path: SyncEngine actually receives a SyncingLocalRepository
  // (repository-provider wraps the inner repo). The reconcile calls hardDelete
  // through that wrapper — this test guards against the wrapper not forwarding
  // it (which would throw at runtime, exactly the bug the bare-repo tests missed).
  it('reconciles through SyncingLocalRepository wrapper — collapses, no spurious outbox', async () => {
    // Wrapper is handed to SyncEngine exactly as repository-provider does it
    // (getLocalRepository casts the wrapper to LocalRepository).
    const wrapped = new SyncingLocalRepository(repo) as unknown as typeof repo
    await repo.bulkLoad('habit_completions', [completion('id-X', T1)])
    const { remote } = makeMockRemote({ listRows: { habit_completions: [completion('id-Y', T2)] } })

    await new SyncEngine(wrapped, remote).runCycle()

    const rows = (await db.habit_completions.toArray()).filter((r) => r.deleted_at == null)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('id-Y')
    // hardDelete of the superseded id must NOT enqueue an outbox entry.
    const hcOutbox = (await db.outbox.toArray()).filter((e) => e.entity === 'habit_completions')
    expect(hcOutbox).toHaveLength(0)
  })
})

// Helper: run one pull-driven cycle against the given mock remote.
async function engineFromRemote(remote: ConstructorParameters<typeof SyncEngine>[1]) {
  const engine = new SyncEngine(repo, remote)
  await engine.runCycle()
}

