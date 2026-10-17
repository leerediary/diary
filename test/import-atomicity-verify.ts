// Import atomicity verification (Phase 19 review fix — Finding #1).
//
// Reproduces the exact failure the manual browser test (C组) surfaced: an import
// whose 4th entity (long_term_tasks) has a row missing its `id` keyPath. Before
// the fix, per-entity bulkLoad committed habits/habit_completions in separate
// transactions, then threw on long_term_tasks → a half-imported store. After the
// fix, importData routes through LocalRepository.bulkLoadAll (one rw transaction),
// so the bad row rolls back ALL writes and the store is left untouched.
//
// Also asserts the journal_entries `&date` unique-index collision rolls back too,
// and that a fully-valid import still succeeds (no regression).
//
// Run: npx tsx test/import-atomicity-verify.ts
import 'fake-indexeddb/auto'
import { db } from '@/lib/local-db'
import { importData } from '@/lib/data-import'
import { EXPORT_FORMAT, EXPORT_VERSION } from '@/lib/data-export'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}`)
  if (!cond) failures++
}

function contract(data: Record<string, unknown[]>) {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      habits: [],
      habit_completions: [],
      journal_entries: [],
      long_term_tasks: [],
      pomodoro_sessions: [],
      ...data,
    },
  })
}

async function storeCounts() {
  return {
    habits: await db.habits.count(),
    habit_completions: await db.habit_completions.count(),
    journal_entries: await db.journal_entries.count(),
    long_term_tasks: await db.long_term_tasks.count(),
    pomodoro_sessions: await db.pomodoro_sessions.count(),
  }
}

async function reset() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
}

async function main() {
  // ── Case 1: valid import succeeds (no regression) ──
  await reset()
  await importData(
    contract({
      habits: [{ id: 'h1', name: 'A', short_name: 'A', sort_order: 0, updated_at: '2026-06-04T00:00:00Z', deleted_at: null }],
      long_term_tasks: [{ id: 't1', name: 'task', category: '', is_for_today: false, parent_id: null, sort_order: 0, completed_at: null, updated_at: '2026-06-04T00:00:00Z', created_at: '2026-06-04T00:00:00Z', deleted_at: null }],
    }),
  )
  let c = await storeCounts()
  check('valid import writes habits', c.habits === 1)
  check('valid import writes long_term_tasks', c.long_term_tasks === 1)

  // ── Case 2: bad row in 4th entity → whole import rolls back (THE bug) ──
  await reset()
  let threw = false
  try {
    await importData(
      contract({
        habits: [{ id: 'h1', name: 'A', short_name: 'A', sort_order: 0, updated_at: '2026-06-04T00:00:00Z', deleted_at: null }],
        habit_completions: [{ id: 'hc1', habit_id: 'h1', date: '2026-06-04', note: '', updated_at: '2026-06-04T00:00:00Z', deleted_at: null }],
        long_term_tasks: [{ /* MISSING id */ name: 'bad', category: '', is_for_today: false, parent_id: null, sort_order: 0, completed_at: null, updated_at: '2026-06-04T00:00:00Z', created_at: '2026-06-04T00:00:00Z', deleted_at: null }],
      }),
    )
  } catch {
    threw = true
  }
  c = await storeCounts()
  check('bad-row import throws', threw)
  check('bad-row import rolls back habits (was the half-import bug)', c.habits === 0)
  check('bad-row import rolls back habit_completions', c.habit_completions === 0)
  check('bad-row import leaves store entirely empty', Object.values(c).every((n) => n === 0))

  // ── Case 3: journal &date unique-index collision rolls back ──
  await reset()
  // Seed an existing journal for 2026-06-04 (id=A).
  await db.journal_entries.put({ id: 'A', date: '2026-06-04', content: 'existing', updated_at: '2026-06-04T00:00:00Z', deleted_at: null } as never)
  threw = false
  try {
    await importData(
      contract({
        habits: [{ id: 'h9', name: 'Z', short_name: 'Z', sort_order: 0, updated_at: '2026-06-04T00:00:00Z', deleted_at: null }],
        // Same date 2026-06-04 but different id=B → violates &date unique index.
        journal_entries: [{ id: 'B', date: '2026-06-04', content: 'incoming', updated_at: '2026-06-05T00:00:00Z', deleted_at: null }],
      }),
    )
  } catch {
    threw = true
  }
  c = await storeCounts()
  check('&date collision throws', threw)
  check('&date collision rolls back the new habit', c.habits === 0)
  check('&date collision leaves original journal intact (count 1)', c.journal_entries === 1)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} CHECK(S) FAILED`)
  await db.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
