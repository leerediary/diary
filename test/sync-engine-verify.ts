// SyncEngine end-to-end verification harness — Phase 6 / Plan 06-02.
//
// Drives the full SyncEngine.runCycle() against the DISPOSABLE LOCAL Supabase
// stack via the ANON key, using a fake-indexeddb LocalRepository on the local
// side. Proves push→remote, pull+LWW apply, tombstone propagation, and
// last_pulled_at high-water mark in a binary N/N PASS / exit-1 report.
//
// Mirrors test/lww-verify.ts structure exactly: same check()/report[]/failures
// harness, same D-04 local-only host guard, same aligned-table report format.
//
// Run (local stack ONLY — D-04; never the live project, never `supabase db push`):
//   supabase start
//   supabase db reset
//   export NEXT_PUBLIC_SUPABASE_URL="$(supabase status -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).API_URL))')"
//   export NEXT_PUBLIC_SUPABASE_ANON_KEY="$(supabase status -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).ANON_KEY))'"
//   npm run verify:sync
//   supabase stop
//
// fake-indexeddb shims IndexedDB in Node so LocalRepository + Dexie work.
// Anon key only — secret-key path deleted in Phase 3 (SEC-02).
import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import type { Habit } from '@/lib/types'
import { db } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { SyncEngine, enqueueOutbox } from '@/lib/sync-engine'
import { createSupabaseRepository } from '@/lib/supabase-repository'

// ── D-04 hard guard: env present AND local-only, or refuse loudly ──
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!url || !anon) {
  console.error(
    'Missing env. Export the LOCAL stack creds from `supabase status` first:\n' +
      '  export NEXT_PUBLIC_SUPABASE_URL="$(supabase status -o json | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).API_URL))\')"\n' +
      '  export NEXT_PUBLIC_SUPABASE_ANON_KEY="$(supabase status -o json | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).ANON_KEY))\')"',
  )
  process.exit(1)
}
{
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.error(
      `REFUSING to run the sync-engine verify harness against a non-local Supabase URL (D-04). ` +
        `Point at the local stack only (got host="${host}"). No write was performed.`,
    )
    process.exit(1)
  }
}

// ── Harness helpers (identical shape to lww-verify.ts) ──
const failures: string[] = []
const report: Array<[string, string, string, string, string]> = []
function check(scope: string, name: string, expected: unknown, got: unknown, pass: boolean) {
  report.push([scope, name, String(expected), String(got), pass ? 'PASS' : 'FAIL'])
  if (!pass) failures.push(`${scope} / ${name}: expected ${expected}, got ${got}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Remote adapter (real Supabase RPC against the local stack).
const remote = createSupabaseRepository()

// Local DB helpers — reset tables between test scenarios.
async function clearLocal() {
  await Promise.all([
    db.habits.clear(),
    db.habit_completions.clear(),
    db.journal_entries.clear(),
    db.long_term_tasks.clear(),
    db.outbox.clear(),
    db.sync_meta.clear(),
  ])
}

async function main() {
  // ── Scenario 1: PUSH ──
  // Enqueue a habit upsert into the outbox, run cycle, assert it appears in remote.
  {
    await clearLocal()
    const local = new LocalRepository(db)
    const engine = new SyncEngine(local, remote)

    const habitId = randomUUID()
    const habit: Habit = {
      id: habitId,
      name: 'SYNC-VERIFY-habit',
      short_name: 'sv',
      sort_order: 99,
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted_at: null,
    }
    // Load it locally (bypassing SyncingLocalRepository; directly enqueue).
    await local.bulkLoad('habits', [habit])
    await enqueueOutbox('habits', 'upsert', habit)

    await engine.runCycle()

    const remoteRows = await remote.list<Habit>('habits', { includeDeleted: true })
    const pushed = remoteRows.find((r) => r.id === habitId)
    check(
      'push',
      'S1 outbox upsert appears in remote after runCycle()',
      'habit present in remote',
      pushed ? `present, name=${pushed.name}` : 'absent',
      !!pushed && pushed.name === 'SYNC-VERIFY-habit',
    )
  }

  // ── Scenario 2: PULL + LWW APPLY ──
  // Inject a newer row directly into remote, clear local, run cycle, assert local
  // has the pulled row verbatim (same updated_at as server-returned value).
  {
    await clearLocal()
    const local = new LocalRepository(db)
    const engine = new SyncEngine(local, remote)

    const habitId = randomUUID()
    const staleHabit: Habit = {
      id: habitId,
      name: 'PULL-TEST-stale',
      short_name: 'pt',
      sort_order: 88,
      updated_at: '2020-01-01T00:00:00.000Z',
      deleted_at: null,
    }
    // Push a stale version first so the row exists in remote.
    await local.bulkLoad('habits', [staleHabit])
    await enqueueOutbox('habits', 'upsert', staleHabit)
    const engine0 = new SyncEngine(local, remote)
    await engine0.runCycle()
    // Wait briefly then push a newer version.
    await sleep(50)
    const newerHabit: Habit = {
      id: habitId,
      name: 'PULL-TEST-newer',
      short_name: 'pt',
      sort_order: 88,
      updated_at: '2099-01-01T00:00:00.000Z', // far-future guard key → accepted by server
      deleted_at: null,
    }
    await enqueueOutbox('habits', 'upsert', newerHabit)
    await engine0.runCycle() // push the newer version to remote

    // Confirm the newer version is on the server.
    const remoteRows = await remote.list<Habit>('habits', { includeDeleted: true })
    const serverRow = remoteRows.find((r) => r.id === habitId)

    // Now clear local entirely and re-run cycle — should pull the server version.
    await clearLocal()
    const local2 = new LocalRepository(db)
    const engine2 = new SyncEngine(local2, remote)
    await engine2.runCycle()

    const localRows = await local2.list<Habit>('habits', { includeDeleted: true })
    const localRow = localRows.find((r) => r.id === habitId)
    const verbatim = !!localRow && !!serverRow && localRow.updated_at === serverRow.updated_at
    check(
      'pull',
      'S2 pull APPLY verbatim — local updated_at matches server updated_at',
      'local.updated_at == server.updated_at',
      verbatim
        ? `MATCH local=${localRow?.updated_at}`
        : `MISMATCH local=${localRow?.updated_at} server=${serverRow?.updated_at}`,
      verbatim,
    )
    check(
      'pull',
      'S2 pull APPLY — name is the server-canonical value',
      'PULL-TEST-newer',
      localRow?.name ?? 'absent',
      localRow?.name === 'PULL-TEST-newer',
    )
  }

  // ── Scenario 3: TOMBSTONE PROPAGATION ──
  // Push a live row, soft-delete it on remote (via remote.softDelete), run cycle,
  // assert local row has deleted_at set and is excluded from the live list.
  {
    await clearLocal()
    const local = new LocalRepository(db)

    const habitId = randomUUID()
    const h: Habit = {
      id: habitId,
      name: 'TOMBSTONE-TEST',
      short_name: 'ts',
      sort_order: 77,
      updated_at: '2020-06-01T00:00:00.000Z',
      deleted_at: null,
    }
    // Push row to remote.
    await local.bulkLoad('habits', [h])
    await enqueueOutbox('habits', 'upsert', h)
    const engine0 = new SyncEngine(local, remote)
    await engine0.runCycle()

    // Soft-delete it on the remote side directly.
    await sleep(50)
    await remote.softDelete('habits', habitId)

    // Clear local and re-run — pull should propagate the tombstone.
    await clearLocal()
    const local2 = new LocalRepository(db)
    const engine2 = new SyncEngine(local2, remote)
    await engine2.runCycle()

    const allRows = await local2.list<Habit>('habits', { includeDeleted: true })
    const tombstoned = allRows.find((r) => r.id === habitId)
    const liveRows = await local2.list<Habit>('habits', { includeDeleted: false })
    const inLive = liveRows.some((r) => r.id === habitId)

    check(
      'tombstone',
      'S3 tombstone propagated — local deleted_at is set',
      'deleted_at != null',
      tombstoned ? `deleted_at=${tombstoned.deleted_at}` : 'row absent',
      !!tombstoned && tombstoned.deleted_at != null,
    )
    check(
      'tombstone',
      'S3 tombstone propagated — excluded from live list',
      'inLive=false',
      `inLive=${inLive}`,
      inLive === false,
    )
    check(
      'tombstone',
      'S3 tombstone propagated — APPLY_TOMBSTONE does not erase the row',
      'row exists with includeDeleted=true',
      tombstoned ? 'present' : 'absent',
      !!tombstoned,
    )
  }

  // ── Scenario 4: HIGH-WATER MARK ──
  // After a cycle that pulls rows, assert sync_meta.last_pulled_at equals the
  // max server updated_at among pulled rows (server-clock value, not a device timestamp).
  {
    await clearLocal()
    const local = new LocalRepository(db)

    // Push two habits to remote with distinct updated_at values.
    const id1 = randomUUID()
    const id2 = randomUUID()
    const h1: Habit = {
      id: id1, name: 'HWM-1', short_name: 'h1', sort_order: 10,
      updated_at: '2020-01-01T00:00:00.000Z', deleted_at: null,
    }
    const h2: Habit = {
      id: id2, name: 'HWM-2', short_name: 'h2', sort_order: 11,
      updated_at: '2020-02-01T00:00:00.000Z', deleted_at: null,
    }
    await local.bulkLoad('habits', [h1, h2])
    await enqueueOutbox('habits', 'upsert', h1)
    await enqueueOutbox('habits', 'upsert', h2)
    const engine0 = new SyncEngine(local, remote)
    await engine0.runCycle() // push both to remote

    // Get server-returned updated_at values.
    const remoteHabits = await remote.list<Habit>('habits', { includeDeleted: true })
    const rh1 = remoteHabits.find((r) => r.id === id1)
    const rh2 = remoteHabits.find((r) => r.id === id2)
    const expectedMax = [rh1?.updated_at ?? '', rh2?.updated_at ?? ''].sort().reverse()[0]

    // Clear local and pull.
    await clearLocal()
    const local2 = new LocalRepository(db)
    const engine2 = new SyncEngine(local2, remote)
    await engine2.runCycle()

    const meta = await db.sync_meta.get('last_pulled_at')
    const hwm = meta?.value ?? ''

    // The HWM must be >= expectedMax (other rows from previous scenarios may be newer).
    const hwmOk = !!hwm && hwm >= expectedMax
    check(
      'high-water-mark',
      'S4 last_pulled_at >= max(server updated_at of pushed rows)',
      `>=${expectedMax.slice(0, 23)}`,
      hwm.slice(0, 23),
      hwmOk,
    )
    // The HWM must NOT be a device timestamp (it's a server-returned value so it won't
    // be in the far future; it will be a realistic server clock value).
    const hwmIsServerClock = hwm !== '' && new Date(hwm).getUTCFullYear() <= 2030
    check(
      'high-water-mark',
      'S4 last_pulled_at is server-clock value (not new Date() future)',
      'year <= 2030',
      hwm ? `year=${new Date(hwm).getUTCFullYear()}` : 'empty',
      hwmIsServerClock,
    )
  }

  // ── Report (aligned table, Phase-2 style — identical to lww-verify.ts) ──
  const w = [18, 64, 30, 40, 6]
  const line = (c: string[]) => '| ' + c.map((x, i) => x.padEnd(w[i])).join(' | ') + ' |'
  console.log('\n## SYNC VERIFY Report\n')
  console.log(line(['scope', 'check', 'expected', 'got', 'res']))
  console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|')
  for (const row of report) console.log(line(row))
  console.log()

  if (failures.length) {
    console.error(`SYNC VERIFY: FAIL (${failures.length})`)
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`SYNC VERIFY: PASS (${report.length}/${report.length}) — local Supabase stack, anon key, zero production risk`)
  process.exit(0)
}

main().catch((e) => {
  console.error('SYNC VERIFY: ERROR', e?.message ?? e)
  process.exit(1)
})
