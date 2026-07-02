// Phase 8 / Plan 08-01 — SqliteLocalRepository convergence harness (verify:sqlite).
//
// Identical scenario set + identical 36 check() assertions as test/sync-converge-verify.ts
// (the Dexie-backed Phase-7 harness), but the entity-table backend is swapped for
// SqliteLocalRepository running against a Node-side better-sqlite3 bridge. The frozen
// sync layer (SyncEngine, SyncingLocalRepository, sync-decision, outbox, sync_meta)
// is UNCHANGED — outbox + sync_meta still live in fake-indexeddb-backed Dexie
// (Frozen-Layer Watchlist, pitfall P-05); only the four entity tables move to SQLite.
//
// Two-device model (T-7-07): unchanged from sync-converge-verify.ts. Device A and
// Device B alternate snapshots; between turns clearLocal() wipes BOTH the four
// SQLite entity tables (via the bridge) AND the Dexie outbox + sync_meta tables.
// SyncEngine reconstructs each device's view by pulling from the shared LOCAL
// Supabase. Convergence is judged by server-returned updated_at on both views.
//
// Run (local stack ONLY — D-04/T-7-09; never the live project, never `supabase db push`):
//   supabase start
//   supabase db reset
//   export NEXT_PUBLIC_SUPABASE_URL="$(supabase status -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).API_URL))')"
//   export NEXT_PUBLIC_SUPABASE_ANON_KEY="$(supabase status -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).ANON_KEY))')"
//   export VERIFY_OWNER_EMAIL="<owner email from Supabase Studio → Authentication → Users>"
//   export VERIFY_OWNER_PASSWORD="<owner password>"
//   npm run verify:sqlite
//   supabase stop
//
// fake-indexeddb shims IndexedDB in Node so Dexie (outbox + sync_meta) still works.
// better-sqlite3 backs the four entity tables; the temp DB file is unlinked on exit.
import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Habit, HabitCompletion, JournalEntry, LongTermTask } from '@/lib/types'
import type { Entity } from '@/lib/repository'
import { db } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import type { DiaryBridge } from '@/lib/sqlite-bridge'
import { SqliteLocalRepository } from '@/lib/sqlite-repository'
import { SyncEngine, enqueueOutbox } from '@/lib/sync-engine'
import { createSupabaseRepository } from '@/lib/supabase-repository'
import { getAuthClient } from '@/lib/supabase'
import { createBrowserClient } from '@/lib/supabase'

// ── Node-side better-sqlite3 bridge (08-PATTERNS.md §5, 08-RESEARCH.md Phase 8 Test Plan #2) ──
// File-backed so multiple SqliteLocalRepository instances within the same run see the same DB
// (mirrors how WKWebView's diary.db is one shared file). Installed onto globalThis.window so
// any code path reaching getBridge() also resolves; SqliteLocalRepository is also constructed
// with the explicit bridge argument below to avoid relying on the global at instantiation time.
const SQLITE_PATH = join(tmpdir(), `sqlite-converge-verify-${Date.now()}.db`)
const sqliteDb = new Database(SQLITE_PATH)
const bridge: DiaryBridge = {
  async execute(sql: string, params: unknown[]): Promise<void> {
    sqliteDb.prepare(sql).run(...(params as never[]))
  },
  async query<T>(sql: string, params: unknown[]): Promise<T[]> {
    return sqliteDb.prepare(sql).all(...(params as never[])) as T[]
  },
}
;(globalThis as { window?: { diaryBridge?: DiaryBridge } }).window = { diaryBridge: bridge }

// Cleanup hook — close handle + unlink temp DB on process exit (08-PATTERNS.md §5)
process.on('exit', () => {
  try { sqliteDb.close() } catch {}
  try { unlinkSync(SQLITE_PATH) } catch {}
})

// Helper: D-03-preserving instantiation. SyncEngine and clearLocal type their
// `local: LocalRepository`, but SqliteLocalRepository implements the same
// Repository surface (list/upsert/softDelete + bulkLoad + the app-facing methods
// SyncEngine actually calls — list, bulkLoad). Cast preserves byte-unchanged
// invariant on lib/syncing-repository.ts and lib/sync-engine.ts.
function newLocal(): LocalRepository {
  return new SqliteLocalRepository(bridge) as unknown as LocalRepository
}

// ── D-04 / T-7-09 hard guard: env present AND local-only AND owner creds present, or refuse loudly ──
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const VERIFY_OWNER_EMAIL = process.env.VERIFY_OWNER_EMAIL
const VERIFY_OWNER_PASSWORD = process.env.VERIFY_OWNER_PASSWORD

if (!url || !anon || !VERIFY_OWNER_EMAIL || !VERIFY_OWNER_PASSWORD) {
  console.error(
    'Missing env. Export the LOCAL stack creds + owner credentials first:\n' +
      '  export NEXT_PUBLIC_SUPABASE_URL="$(supabase status -o json | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).API_URL))\')"\n' +
      '  export NEXT_PUBLIC_SUPABASE_ANON_KEY="$(supabase status -o json | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).ANON_KEY))\')" \n' +
      '  export VERIFY_OWNER_EMAIL="<owner email from Supabase Studio → Authentication → Users>"\n' +
      '  export VERIFY_OWNER_PASSWORD="<owner password>"\n' +
      '\n' +
      'Missing: ' +
      [!url && 'NEXT_PUBLIC_SUPABASE_URL', !anon && 'NEXT_PUBLIC_SUPABASE_ANON_KEY', !VERIFY_OWNER_EMAIL && 'VERIFY_OWNER_EMAIL', !VERIFY_OWNER_PASSWORD && 'VERIFY_OWNER_PASSWORD']
        .filter(Boolean)
        .join(', '),
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
      `REFUSING to run the converge verify harness against a non-local Supabase URL (D-04/T-7-09). ` +
        `Point at the local stack only (got host="${host}"). No write was performed.`,
    )
    process.exit(1)
  }
}

// ── Harness helpers (identical shape to sync-engine-verify.ts / lww-verify.ts) ──
const failures: string[] = []
const report: Array<[string, string, string, string, string]> = []
function check(scope: string, name: string, expected: unknown, got: unknown, pass: boolean) {
  report.push([scope, name, String(expected), String(got), pass ? 'PASS' : 'FAIL'])
  if (!pass) failures.push(`${scope} / ${name}: expected ${expected}, got ${got}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Remote adapter (shared, one instance against the local stack) ──
const remote = createSupabaseRepository()

// ── C3 helper: a remote wrapper that throws on the first upsert for journal_entries ──
// This simulates Device B being offline (push fails / network error) so its outbox
// entry for journal_entries survives into the pull phase — the only code path that
// reaches decideSyncAction with isInOutbox=true. Without this, the push-phase drains
// B's outbox entry (guard-rejected = no error = deleted from outbox) before the pull
// builds its outboxSet, so JOURNAL_CONFLICT is never triggered in a real-network test.
function makePushFailRemote(realRemote: ReturnType<typeof createSupabaseRepository>) {
  let journalPushFailed = false
  return {
    list: realRemote.list.bind(realRemote),
    softDelete: realRemote.softDelete.bind(realRemote),
    async upsert<T>(entity: string, row: T): Promise<void> {
      if (entity === 'journal_entries' && !journalPushFailed) {
        journalPushFailed = true
        throw new Error('[C3-test] Simulated network failure on push — retaining outbox entry for conflict detection')
      }
      return realRemote.upsert(entity as Parameters<typeof realRemote.upsert>[0], row as Parameters<typeof realRemote.upsert>[1])
    },
  } as ReturnType<typeof createSupabaseRepository>
}

// ── Local DB helpers ──
// clearLocal: reset all local tables + outbox + sync_meta between device "turns".
// Frozen-Layer Watchlist: the four entity tables live in SQLite (cleared via the
// bridge); outbox + sync_meta remain in fake-indexeddb-backed Dexie (cleared via db.*).
async function clearLocal() {
  // SQLite entity tables — schema may not yet exist on first call before any
  // SqliteLocalRepository method has run ensureSchema(). Construct one (idempotent)
  // and run a no-op list to force schema creation; then DELETE FROM each table.
  await newLocal().list<Habit>('habits')
  await Promise.all([
    bridge.execute('DELETE FROM habits', []),
    bridge.execute('DELETE FROM habit_completions', []),
    bridge.execute('DELETE FROM journal_entries', []),
    bridge.execute('DELETE FROM long_term_tasks', []),
    // Dexie tables — outbox + sync_meta are part of the frozen sync layer (D-03)
    db.outbox.clear(),
    db.sync_meta.clear(),
  ])
}

// clearRemoteEntity: delete all rows for an entity on the local Supabase stack
// (test isolation — runs as owner, after sign-in)
async function clearRemoteEntity(entity: Entity) {
  const sb = getAuthClient()
  await sb.from(entity).delete().gte('updated_at', '2000-01-01')
}

// reconstructFromRemote: clear local then pull all from remote (read-only view of this "device")
async function reconstructFromRemote(): Promise<LocalRepository> {
  await clearLocal()
  const local = newLocal()
  const engine = new SyncEngine(local, remote)
  await engine.runCycle()
  return local
}

async function main() {
  // ── Sign in as owner (required for all scenarios) ──
  console.log('\nSigning in as owner...')
  const { data: { session }, error: signInError } = await getAuthClient().auth.signInWithPassword({
    email: VERIFY_OWNER_EMAIL!,
    password: VERIFY_OWNER_PASSWORD!,
  })
  if (signInError || !session) {
    console.error('CONVERGE VERIFY: ERROR — sign-in failed:', signInError?.message ?? 'no session returned')
    console.error('Make sure the owner account exists in the local Supabase stack (Studio → Authentication → Users).')
    process.exit(1)
  }
  const ownerUid = session.user.id
  console.log(`Signed in as ${VERIFY_OWNER_EMAIL} (uid: ${ownerUid.slice(0, 8)}...)`)

  // ── C1: Same-row double-edit → LWW winner converges on both devices ──
  // (D-10 scenario 1 — T-7-08 server-clock baseline)
  {
    await clearRemoteEntity('habits')
    await clearLocal()

    // Device A: create habit with an older updated_at, push to remote
    const habitId = randomUUID()
    const habitA: Habit = {
      id: habitId,
      name: 'C1-Device-A',
      short_name: 'c1a',
      sort_order: 1,
      updated_at: '2020-01-01T00:00:00.000Z',  // older guard key — A's offline write
      deleted_at: null,
    }
    const localA = newLocal()
    await localA.bulkLoad('habits', [habitA])
    await enqueueOutbox('habits', 'upsert', habitA)
    const engineA = new SyncEngine(localA, remote)
    await engineA.runCycle()  // A pushes to remote

    // Verify A's row is on the server before B edits
    const serverRowsAfterA = await remote.list<Habit>('habits', { includeDeleted: true })
    const serverRowA = serverRowsAfterA.find((r) => r.id === habitId)

    // Device B: reconstructed from remote (offline view), edits same row with far-future updated_at
    await clearLocal()
    await sleep(50)
    const habitB: Habit = {
      id: habitId,
      name: 'C1-Device-B-winner',
      short_name: 'c1b',
      sort_order: 1,
      updated_at: '2099-01-01T00:00:00.000Z',  // far-future → B wins LWW
      deleted_at: null,
    }
    const localB = newLocal()
    await localB.bulkLoad('habits', [habitB])
    await enqueueOutbox('habits', 'upsert', habitB)
    const engineB = new SyncEngine(localB, remote)
    await engineB.runCycle()  // B pushes winner to remote

    // Get server-canonical row after B's push (server-clock authority, T-7-08)
    const serverRowsAfterB = await remote.list<Habit>('habits', { includeDeleted: true })
    const serverRowB = serverRowsAfterB.find((r) => r.id === habitId)

    // Reconstruct A from remote — both devices should converge to B's version
    const reconA = await reconstructFromRemote()
    const reconARows = await reconA.list<Habit>('habits', { includeDeleted: true })
    const reconARow = reconARows.find((r) => r.id === habitId)

    // Reconstruct B from remote (B already pulled in runCycle, but we re-verify)
    const reconB = await reconstructFromRemote()
    const reconBRows = await reconB.list<Habit>('habits', { includeDeleted: true })
    const reconBRow = reconBRows.find((r) => r.id === habitId)

    // Assertions: A and B both have B's name; both updated_at match server-returned value (T-7-08)
    check(
      'C1-LWW',
      'C1 both devices converge to LWW winner (B wins)',
      'name=C1-Device-B-winner on both',
      `A=${reconARow?.name ?? 'absent'}, B=${reconBRow?.name ?? 'absent'}`,
      reconARow?.name === 'C1-Device-B-winner' && reconBRow?.name === 'C1-Device-B-winner',
    )
    const aMatchesServer = !!reconARow && !!serverRowB && reconARow.updated_at === serverRowB.updated_at
    const bMatchesServer = !!reconBRow && !!serverRowB && reconBRow.updated_at === serverRowB.updated_at
    check(
      'C1-LWW',
      'C1 converged updated_at equals SERVER-returned value (not device clock, T-7-08)',
      'local.updated_at == server.updated_at on both',
      `A-match=${aMatchesServer}, B-match=${bMatchesServer}`,
      aMatchesServer && bMatchesServer,
    )
    check(
      'C1-LWW',
      'C1 A and B converged updated_at are byte-identical',
      'reconA.updated_at == reconB.updated_at',
      `A=${reconARow?.updated_at?.slice(0, 23) ?? 'absent'}, B=${reconBRow?.updated_at?.slice(0, 23) ?? 'absent'}`,
      !!reconARow && !!reconBRow && reconARow.updated_at === reconBRow.updated_at,
    )
  }

  // ── C2: Delete-vs-edit + tombstone non-resurrection (BOTH directions) ──
  // (D-10 scenario 2 — T-7-04 core; both directions are distinct decideSyncAction paths)
  {
    await clearRemoteEntity('habits')

    // ── C2 Direction 1: A soft-deletes, B (stale offline) edits → tombstone wins ──
    {
      await clearLocal()
      const habitId = randomUUID()
      // Seed row on remote (push via A)
      const seedHabit: Habit = {
        id: habitId,
        name: 'C2-dir1-seed',
        short_name: 'c2d1',
        sort_order: 2,
        updated_at: '2020-01-01T00:00:00.000Z',
        deleted_at: null,
      }
      const localSeed = newLocal()
      await localSeed.bulkLoad('habits', [seedHabit])
      await enqueueOutbox('habits', 'upsert', seedHabit)
      const engineSeed = new SyncEngine(localSeed, remote)
      await engineSeed.runCycle()

      // Get server row id after seed push
      const serverRowsSeed = await remote.list<Habit>('habits', { includeDeleted: true })
      const serverSeedRow = serverRowsSeed.find((r) => r.id === habitId)

      // A: soft-delete the row on remote (tombstone), then push
      await sleep(50)
      await remote.softDelete('habits', habitId)

      // B: reconstructed offline with stale edit (does not know about A's delete)
      await clearLocal()
      const staleHabit: Habit = {
        id: habitId,
        name: 'C2-dir1-B-stale-edit',
        short_name: 'c2b',
        sort_order: 2,
        updated_at: '2010-01-01T00:00:00.000Z',  // stale — tombstone is newer
        deleted_at: null,
      }
      const localB = newLocal()
      await localB.bulkLoad('habits', [staleHabit])
      await enqueueOutbox('habits', 'upsert', staleHabit)
      const engineB = new SyncEngine(localB, remote)
      await engineB.runCycle()  // B tries to push stale edit; guard rejects; pulls tombstone

      // Reconstruct A from remote
      const reconA = await reconstructFromRemote()
      const reconARows = await reconA.list<Habit>('habits', { includeDeleted: true })
      const reconARow = reconARows.find((r) => r.id === habitId)
      const reconALive = await reconA.list<Habit>('habits', { includeDeleted: false })
      const reconAInLive = reconALive.some((r) => r.id === habitId)

      // B's local view after runCycle (which pulled the tombstone)
      const localBRows = await localB.list<Habit>('habits', { includeDeleted: true })
      const localBRow = localBRows.find((r) => r.id === habitId)
      const localBLive = await localB.list<Habit>('habits', { includeDeleted: false })
      const localBInLive = localBLive.some((r) => r.id === habitId)

      check(
        'C2-dir1',
        'C2.1 A-deletes/B-edits: tombstone wins (A side: deleted_at set)',
        'deleted_at != null',
        reconARow ? `deleted_at=${reconARow.deleted_at}` : 'row absent',
        !!reconARow && reconARow.deleted_at != null,
      )
      check(
        'C2-dir1',
        'C2.1 A-deletes/B-edits: excluded from A live list (non-resurrection)',
        'inLive=false',
        `inLive=${reconAInLive}`,
        reconAInLive === false,
      )
      check(
        'C2-dir1',
        'C2.1 A-deletes/B-edits: tombstone wins (B side: deleted_at set)',
        'deleted_at != null',
        localBRow ? `deleted_at=${localBRow.deleted_at}` : 'row absent',
        !!localBRow && localBRow.deleted_at != null,
      )
      check(
        'C2-dir1',
        'C2.1 A-deletes/B-edits: excluded from B live list (non-resurrection)',
        'inLive=false',
        `inLive=${localBInLive}`,
        localBInLive === false,
      )
      check(
        'C2-dir1',
        'C2.1 A-deletes/B-edits: row retained with includeDeleted=true on both',
        'present on both',
        `A=${reconARow ? 'present' : 'absent'}, B=${localBRow ? 'present' : 'absent'}`,
        !!reconARow && !!localBRow,
      )
      check(
        'C2-dir1',
        'C2.1 A-deletes/B-edits: both views byte-identical deleted_at',
        'A.deleted_at == B.deleted_at',
        `A=${reconARow?.deleted_at ?? 'null'}, B=${localBRow?.deleted_at ?? 'null'}`,
        !!reconARow && !!localBRow && reconARow.deleted_at === localBRow.deleted_at,
      )
    }

    // ── C2 Direction 2: B soft-deletes, A (stale offline) edits → tombstone wins ──
    {
      await clearRemoteEntity('habits')
      await clearLocal()
      const habitId = randomUUID()
      // Seed row on remote (push via engine)
      const seedHabit: Habit = {
        id: habitId,
        name: 'C2-dir2-seed',
        short_name: 'c2d2',
        sort_order: 3,
        updated_at: '2020-01-01T00:00:00.000Z',
        deleted_at: null,
      }
      const localSeed = newLocal()
      await localSeed.bulkLoad('habits', [seedHabit])
      await enqueueOutbox('habits', 'upsert', seedHabit)
      const engineSeed = new SyncEngine(localSeed, remote)
      await engineSeed.runCycle()

      // B: soft-delete on remote
      await sleep(50)
      await remote.softDelete('habits', habitId)

      // A: reconstructed offline, stale edit
      await clearLocal()
      const staleHabit: Habit = {
        id: habitId,
        name: 'C2-dir2-A-stale-edit',
        short_name: 'c2a',
        sort_order: 3,
        updated_at: '2010-01-01T00:00:00.000Z',  // stale — tombstone is newer
        deleted_at: null,
      }
      const localA = newLocal()
      await localA.bulkLoad('habits', [staleHabit])
      await enqueueOutbox('habits', 'upsert', staleHabit)
      const engineA = new SyncEngine(localA, remote)
      await engineA.runCycle()  // A tries to push stale edit; guard rejects; pulls tombstone

      // Reconstruct B from remote
      const reconB = await reconstructFromRemote()
      const reconBRows = await reconB.list<Habit>('habits', { includeDeleted: true })
      const reconBRow = reconBRows.find((r) => r.id === habitId)
      const reconBLive = await reconB.list<Habit>('habits', { includeDeleted: false })
      const reconBInLive = reconBLive.some((r) => r.id === habitId)

      // A's local view after runCycle
      const localARows = await localA.list<Habit>('habits', { includeDeleted: true })
      const localARow = localARows.find((r) => r.id === habitId)
      const localALive = await localA.list<Habit>('habits', { includeDeleted: false })
      const localAInLive = localALive.some((r) => r.id === habitId)

      check(
        'C2-dir2',
        'C2.2 B-deletes/A-edits: tombstone wins (B side: deleted_at set)',
        'deleted_at != null',
        reconBRow ? `deleted_at=${reconBRow.deleted_at}` : 'row absent',
        !!reconBRow && reconBRow.deleted_at != null,
      )
      check(
        'C2-dir2',
        'C2.2 B-deletes/A-edits: excluded from B live list (non-resurrection)',
        'inLive=false',
        `inLive=${reconBInLive}`,
        reconBInLive === false,
      )
      check(
        'C2-dir2',
        'C2.2 B-deletes/A-edits: tombstone wins (A side: deleted_at set)',
        'deleted_at != null',
        localARow ? `deleted_at=${localARow.deleted_at}` : 'row absent',
        !!localARow && localARow.deleted_at != null,
      )
      check(
        'C2-dir2',
        'C2.2 B-deletes/A-edits: excluded from A live list (non-resurrection)',
        'inLive=false',
        `inLive=${localAInLive}`,
        localAInLive === false,
      )
      check(
        'C2-dir2',
        'C2.2 B-deletes/A-edits: row retained with includeDeleted=true on both',
        'present on both',
        `B=${reconBRow ? 'present' : 'absent'}, A=${localARow ? 'present' : 'absent'}`,
        !!reconBRow && !!localARow,
      )
      check(
        'C2-dir2',
        'C2.2 B-deletes/A-edits: both views byte-identical deleted_at',
        'B.deleted_at == A.deleted_at',
        `B=${reconBRow?.deleted_at ?? 'null'}, A=${localARow?.deleted_at ?? 'null'}`,
        !!reconBRow && !!localARow && reconBRow.deleted_at === localARow.deleted_at,
      )
    }
  }

  // ── C3: Cross-device journal conflict end-to-end with `--- 冲突副本 ---` divider ──
  // (D-10 scenario 3 — mirrors 06-HUMAN-UAT.md Test 2 choreography in script)
  //
  // JOURNAL_CONFLICT triggers in decideSyncAction when: entity='journal_entries' AND
  // isInOutbox=true (outbox has this row's id) AND both sides live AND contents differ
  // AND pulled.updated_at >= local.updated_at. The engine matches rows by id, so:
  // - Both devices must share the same row id (uuid1) for the same journal date.
  // - B must have uuid1 in outbox with different content AND a stale updated_at so:
  //   (a) the push is REJECTED by the LWW guard (server keeps A's newer "AAA-A"),
  //   (b) the pull sees A's uuid1/"AAA-A" (pulled >= local stale), AND
  //   (c) isInOutbox('journal_entries:uuid1') = true → JOURNAL_CONFLICT.
  //
  // Real-world equivalent: both devices had the same row (from a previous sync),
  // then both went offline and edited the same date's journal.
  {
    await clearRemoteEntity('journal_entries')
    await clearLocal()

    const journalDate = '2099-07-02'  // fixed date for this scenario

    // Phase 1: Establish shared row uuid on BOTH devices via a neutral first push.
    // A pushes a neutral/empty entry to establish uuid1 on the server.
    // Both A and B will pull this uuid1 to "know" the row id.
    const sharedId = randomUUID()
    const seedRow: JournalEntry = {
      id: sharedId,
      date: journalDate,
      content: '',  // neutral seed — will be replaced by A and B's offline edits
      updated_at: '2000-01-01T00:00:00.000Z',  // far-past seed so both A and B overwrite
      deleted_at: null,
    }
    const seedLocal = newLocal()
    await seedLocal.bulkLoad('journal_entries', [seedRow])
    await enqueueOutbox('journal_entries', 'upsert', seedRow)
    const seedEngine = new SyncEngine(seedLocal, remote)
    await seedEngine.runCycle()  // push neutral seed to remote
    // Server now has uuid1/"" with server-stamped updated_at (call it T_seed)

    // Device A: starts from remote (pulls uuid1), edits offline to "AAA-A" with a
    // guard key older than server's T_seed would be... Actually A needs a newer guard
    // key than the seed so A's push succeeds and becomes the server baseline.
    // A uses FAR_FUTURE to ensure A's push wins over the seed.
    await clearLocal()
    const localA = newLocal()
    const aOfflineRow: JournalEntry = {
      id: sharedId,  // same id as seed
      date: journalDate,
      content: 'AAA-A',
      updated_at: '2050-01-01T00:00:00.000Z',  // newer than seed → A's push overwrites seed on server
      deleted_at: null,
    }
    await localA.bulkLoad('journal_entries', [aOfflineRow])
    await enqueueOutbox('journal_entries', 'upsert', aOfflineRow)
    const engineA = new SyncEngine(localA, remote)
    await engineA.runCycle()  // A pushes "AAA-A" (wins over empty seed) → server has uuid1/"AAA-A"
    // Server updated_at is now set by server trigger to the real server clock (T_A)

    // Verify A's row is on the server
    const serverRowsAfterA = await remote.list<JournalEntry>('journal_entries', { includeDeleted: true })
    const serverRowA = serverRowsAfterA.find((r) => r.date === journalDate)
    check(
      'C3-journal',
      'C3 pre-check: A pushed "AAA-A" to remote',
      'content contains AAA-A',
      serverRowA ? `content=${serverRowA.content}` : 'absent',
      !!serverRowA && serverRowA.content.includes('AAA-A'),
    )

    // Device B: starts from the seed's state (uuid1, empty content), edits offline to "BBB-B"
    // B uses a stale guard key (older than T_A) so B's push is REJECTED by LWW guard.
    // B uses uuid1 (same id) so decideSyncAction can compare same-id local vs pulled.
    // B's local row: {id: uuid1, date: journalDate, content: "BBB-B", updated_at: stale}
    // Outbox: {entity: 'journal_entries', id: uuid1, ...}
    // When B runs pull: server has uuid1/"AAA-A" (T_A), local has uuid1/"BBB-B" (stale)
    //   → pulled.updated_at (T_A) >= local.updated_at (stale) AND isInOutbox=true AND
    //     contents differ → JOURNAL_CONFLICT
    await clearLocal()
    const localB = newLocal()
    const bOfflineRow: JournalEntry = {
      id: sharedId,  // same id as A's row on server
      date: journalDate,
      content: 'BBB-B',
      updated_at: '2020-01-01T00:00:00.000Z',  // stale — server's T_A is the real clock (~2026) → T_A > 2020 → LWW rejects B's push
      deleted_at: null,
    }
    await localB.bulkLoad('journal_entries', [bOfflineRow])
    await enqueueOutbox('journal_entries', 'upsert', bOfflineRow)
    // B's first runCycle uses a push-failing remote for journal_entries: the push throws
    // (simulating B being offline / network error), which retains the outbox entry.
    // The pull phase then runs with the outbox entry still present → isInOutbox=true →
    // decideSyncAction returns JOURNAL_CONFLICT → mergeJournalConflict fires.
    // Without this, the guard-rejected push removes the outbox entry before the pull
    // builds its outboxSet, making JOURNAL_CONFLICT unreachable in a real-network test.
    const engineB = new SyncEngine(localB, makePushFailRemote(remote))
    // B's first runCycle():
    //   Push phase: B tries to push uuid1/"BBB-B" → push-fail remote THROWS → outbox entry retained
    //   Pull phase: B pulls uuid1/"AAA-A" (T_A); local has uuid1/"BBB-B" (stale), isInOutbox=true, live, differ
    //              → decideSyncAction returns JOURNAL_CONFLICT
    //   mergeJournalConflict: winner="AAA-A" (pulled T_A >= local 2020), loser="BBB-B"
    //                         merged = "AAA-A\n\n--- 冲突副本 [..] ---\n\nBBB-B"
    //                         saves merged to local, enqueues for next cycle
    await engineB.runCycle()
    // Second cycle (real remote): B pushes the merged row (enqueued by mergeJournalConflict in first cycle)
    const engineBReal = new SyncEngine(localB, remote)
    await engineBReal.runCycle()

    // Reconstruct A from remote (A pulls merged entry)
    const reconA = await reconstructFromRemote()
    const reconARows = await reconA.list<JournalEntry>('journal_entries', { includeDeleted: false })
    const reconARow = reconARows.find((r) => r.date === journalDate)

    // B's local view after cycles
    const localBRowsAfter = await localB.list<JournalEntry>('journal_entries', { includeDeleted: false })
    const localBRow = localBRowsAfter.find((r) => r.date === journalDate)

    // C3 assertions
    check(
      'C3-journal',
      'C3 A converged content contains both segments (AAA-A)',
      'content includes AAA-A',
      reconARow ? `includes=${reconARow.content.includes('AAA-A')}` : 'absent',
      !!reconARow && reconARow.content.includes('AAA-A'),
    )
    check(
      'C3-journal',
      'C3 A converged content contains both segments (BBB-B)',
      'content includes BBB-B',
      reconARow ? `includes=${reconARow.content.includes('BBB-B')}` : 'absent',
      !!reconARow && reconARow.content.includes('BBB-B'),
    )
    check(
      'C3-journal',
      'C3 A converged content contains 冲突副本 divider',
      'content includes --- 冲突副本',
      reconARow ? `includes=${reconARow.content.includes('--- 冲突副本')}` : 'absent',
      !!reconARow && reconARow.content.includes('--- 冲突副本'),
    )
    check(
      'C3-journal',
      'C3 B converged content contains both segments (AAA-A)',
      'content includes AAA-A',
      localBRow ? `includes=${localBRow.content.includes('AAA-A')}` : 'absent',
      !!localBRow && localBRow.content.includes('AAA-A'),
    )
    check(
      'C3-journal',
      'C3 B converged content contains both segments (BBB-B)',
      'content includes BBB-B',
      localBRow ? `includes=${localBRow.content.includes('BBB-B')}` : 'absent',
      !!localBRow && localBRow.content.includes('BBB-B'),
    )
    check(
      'C3-journal',
      'C3 B converged content contains 冲突副本 divider',
      'content includes --- 冲突副本',
      localBRow ? `includes=${localBRow.content.includes('--- 冲突副本')}` : 'absent',
      !!localBRow && localBRow.content.includes('--- 冲突副本'),
    )
    // Byte-identical on both devices
    check(
      'C3-journal',
      'C3 A and B converged content byte-identical',
      'A.content == B.content',
      !!reconARow && !!localBRow && reconARow.content === localBRow.content ? 'IDENTICAL' : `A-len=${reconARow?.content.length ?? 0}, B-len=${localBRow?.content.length ?? 0}`,
      !!reconARow && !!localBRow && reconARow.content === localBRow.content,
    )
    // Exactly one live row for date D (UNIQUE date preserved)
    const allForDateA = await reconA.list<JournalEntry>('journal_entries', { includeDeleted: true })
    const liveForDateA = allForDateA.filter((r) => r.date === journalDate && r.deleted_at == null)
    check(
      'C3-journal',
      'C3 exactly one live journal row for date D (UNIQUE date preserved)',
      '1 live row',
      `${liveForDateA.length} live row(s)`,
      liveForDateA.length === 1,
    )
    // Convergence uses server-returned updated_at (T-7-08)
    const serverRowsAfterC3 = await remote.list<JournalEntry>('journal_entries', { includeDeleted: true })
    const serverRowC3 = serverRowsAfterC3.find((r) => r.date === journalDate)
    check(
      'C3-journal',
      'C3 A updated_at matches server-returned value (T-7-08)',
      'A.updated_at == server.updated_at',
      !!reconARow && !!serverRowC3 && reconARow.updated_at === serverRowC3.updated_at ? 'MATCH' : `A=${reconARow?.updated_at?.slice(0, 23)}, server=${serverRowC3?.updated_at?.slice(0, 23)}`,
      !!reconARow && !!serverRowC3 && reconARow.updated_at === serverRowC3.updated_at,
    )
  }

  // ── C4: habit_completions toggle + rolloverTasks cross-device idempotency ──
  // (D-10 scenario 4)
  {
    await clearRemoteEntity('habits')
    await clearRemoteEntity('habit_completions')
    await clearRemoteEntity('long_term_tasks')
    await clearLocal()

    // First seed a habit to reference
    const habitId = randomUUID()
    const seedHabit: Habit = {
      id: habitId,
      name: 'C4-habit',
      short_name: 'c4h',
      sort_order: 4,
      updated_at: '2020-01-01T00:00:00.000Z',
      deleted_at: null,
    }
    const localSeed = newLocal()
    await localSeed.bulkLoad('habits', [seedHabit])
    await enqueueOutbox('habits', 'upsert', seedHabit)
    const engineSeed = new SyncEngine(localSeed, remote)
    await engineSeed.runCycle()

    // C4a: habit_completions toggle convergence
    // Device A: toggle ON (checked) → push
    const compDate = '2099-07-04'
    await clearLocal()
    const localA = newLocal()
    await localA.setHabitCompleted(habitId, compDate, true)
    const aCompRows = await localA.list<HabitCompletion>('habit_completions', { includeDeleted: false })
    const aCompRow = aCompRows.find((r) => r.habit_id === habitId && r.date === compDate)!
    await enqueueOutbox('habit_completions', 'upsert', aCompRow)
    const engineA = new SyncEngine(localA, remote)
    await engineA.runCycle()  // A pushes toggle-ON

    // Device B: reconstructed offline, toggles same (habit_id,date) OFF (soft-delete)
    await clearLocal()
    await sleep(50)
    const localB = newLocal()
    // Pull to get the row that A pushed
    await new SyncEngine(localB, remote).runCycle()
    // Now B toggles OFF (soft-delete)
    const bCompRowPulled = await localB.list<HabitCompletion>('habit_completions', { includeDeleted: true })
    const bCompRow = bCompRowPulled.find((r) => r.habit_id === habitId && r.date === compDate)
    if (bCompRow) {
      await localB.softDelete('habit_completions', bCompRow.id)
      await enqueueOutbox('habit_completions', 'softDelete', bCompRow)
    }
    const engineB = new SyncEngine(localB, remote)
    await engineB.runCycle()  // B pushes toggle-OFF (tombstone)

    // Reconstruct both from remote
    const reconA = await reconstructFromRemote()
    const reconAComps = await reconA.list<HabitCompletion>('habit_completions', { includeDeleted: true })
    const reconAComp = reconAComps.filter((r) => r.habit_id === habitId && r.date === compDate)

    const reconB = await reconstructFromRemote()
    const reconBComps = await reconB.list<HabitCompletion>('habit_completions', { includeDeleted: true })
    const reconBComp = reconBComps.filter((r) => r.habit_id === habitId && r.date === compDate)

    // Exactly one row for (habit_id,date) — UNIQUE preserved
    check(
      'C4-toggle',
      'C4a exactly one row for (habit_id+date) on A (UNIQUE preserved)',
      '1 row',
      `${reconAComp.length} row(s)`,
      reconAComp.length === 1,
    )
    check(
      'C4-toggle',
      'C4a exactly one row for (habit_id+date) on B (UNIQUE preserved)',
      '1 row',
      `${reconBComp.length} row(s)`,
      reconBComp.length === 1,
    )
    // Final state identical on both
    check(
      'C4-toggle',
      'C4a both devices have identical final deleted_at state',
      'A.deleted_at == B.deleted_at',
      `A=${reconAComp[0]?.deleted_at ?? 'null'}, B=${reconBComp[0]?.deleted_at ?? 'null'}`,
      reconAComp.length === 1 && reconBComp.length === 1 && reconAComp[0]?.deleted_at === reconBComp[0]?.deleted_at,
    )

    // C4b: rolloverTasks cross-device idempotency (same-date re-run is a no-op)
    await clearRemoteEntity('long_term_tasks')
    await clearLocal()
    const rolloverDate = '2099-07-04'
    // Seed a task that is for-today on device A
    const taskId = randomUUID()
    const task: LongTermTask = {
      id: taskId,
      name: 'C4-rollover-task',
      category: 'test',
      parent_id: null,
      is_for_today: true,
      delay_days: 0,
      completed: false,
      completed_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      last_rollover_date: null,
      updated_at: '2020-01-01T00:00:00.000Z',
      deleted_at: null,
    }
    const localC4A = newLocal()
    await localC4A.bulkLoad('long_term_tasks', [task])
    await enqueueOutbox('long_term_tasks', 'upsert', task)
    const engineC4A = new SyncEngine(localC4A, remote)
    await engineC4A.runCycle()  // push task to remote

    // Device A: rolloverTasks(rolloverDate) → pushes updated row
    await localC4A.rolloverTasks(rolloverDate)
    const afterRolloverA = await localC4A.list<LongTermTask>('long_term_tasks', { includeDeleted: true })
    const rolledA = afterRolloverA.find((r) => r.id === taskId)!
    await enqueueOutbox('long_term_tasks', 'upsert', rolledA)
    await engineC4A.runCycle()  // push rolled row

    // Get server state after A's rollover
    const serverTasksAfterA = await remote.list<LongTermTask>('long_term_tasks', { includeDeleted: true })
    const serverTaskA = serverTasksAfterA.find((r) => r.id === taskId)

    // Device B: reconstruct from remote, rolloverTasks(SAME date) again
    await clearLocal()
    const localC4B = newLocal()
    await new SyncEngine(localC4B, remote).runCycle()  // pull A's rolled row
    await localC4B.rolloverTasks(rolloverDate)  // same-date re-run → should be no-op (last_rollover_date === rolloverDate)
    const afterRolloverB = await localC4B.list<LongTermTask>('long_term_tasks', { includeDeleted: true })
    const rolledB = afterRolloverB.find((r) => r.id === taskId)!
    await enqueueOutbox('long_term_tasks', 'upsert', rolledB)
    await new SyncEngine(localC4B, remote).runCycle()  // push B's view

    // Reconstruct both from remote
    const finalA = await reconstructFromRemote()
    const finalARows = await finalA.list<LongTermTask>('long_term_tasks', { includeDeleted: true })
    const finalATask = finalARows.find((r) => r.id === taskId)

    const finalB = await reconstructFromRemote()
    const finalBRows = await finalB.list<LongTermTask>('long_term_tasks', { includeDeleted: true })
    const finalBTask = finalBRows.find((r) => r.id === taskId)

    check(
      'C4-rollover',
      'C4b A delay_days incremented by exactly 1 after rollover',
      'delay_days=1',
      `delay_days=${finalATask?.delay_days ?? 'absent'}`,
      finalATask?.delay_days === 1,
    )
    check(
      'C4-rollover',
      'C4b last_rollover_date matches rollover date on A',
      `last_rollover_date=${rolloverDate}`,
      `last_rollover_date=${finalATask?.last_rollover_date ?? 'null'}`,
      finalATask?.last_rollover_date === rolloverDate,
    )
    check(
      'C4-rollover',
      'C4b same-date rollover is idempotent: A and B delay_days identical',
      'A.delay_days == B.delay_days',
      `A=${finalATask?.delay_days ?? 'absent'}, B=${finalBTask?.delay_days ?? 'absent'}`,
      finalATask?.delay_days === finalBTask?.delay_days,
    )
    check(
      'C4-rollover',
      'C4b same-date rollover is idempotent: A and B last_rollover_date identical',
      'A.last_rollover_date == B.last_rollover_date',
      `A=${finalATask?.last_rollover_date ?? 'null'}, B=${finalBTask?.last_rollover_date ?? 'null'}`,
      finalATask?.last_rollover_date === finalBTask?.last_rollover_date,
    )
  }

  // ── D-11: RLS positive/negative scoping (SYNC-06) ──
  // Positive: owner JWT can read own rows.
  // Negative: anon (no JWT) returns 0 rows.
  // Negative: signed-out returns 0 rows.
  // Per RESEARCH open-question #3, the explicit different-uid case is intentionally
  // reduced to the no-JWT/signed-out negative: the policy USING (auth.uid() = '<owner_uid>')
  // is a literal constant-equality — no code path lets a different uid accidentally match.
  // The two-state (owner vs no-JWT) proof is sufficient and is asserted here.
  {
    await clearRemoteEntity('habits')
    await clearLocal()

    // Seed at least one habit row for positive/negative assertions to be meaningful
    const dummyHabit: Habit = {
      id: randomUUID(),
      name: 'D11-RLS-test-habit',
      short_name: 'd11',
      sort_order: 99,
      updated_at: '2020-01-01T00:00:00.000Z',
      deleted_at: null,
    }
    const localD11 = newLocal()
    await localD11.bulkLoad('habits', [dummyHabit])
    await enqueueOutbox('habits', 'upsert', dummyHabit)
    const engineD11 = new SyncEngine(localD11, remote)
    await engineD11.runCycle()  // push habit to remote as owner

    // Positive: owner JWT can read own rows
    const ownerClient = getAuthClient()
    const { data: ownerData, error: ownerError } = await ownerClient.from('habits').select('id').limit(1)
    check(
      'D11-RLS',
      'D11 positive: owner JWT SELECT returns no error',
      'error=null',
      `error=${ownerError?.message ?? 'null'}`,
      ownerError == null,
    )
    check(
      'D11-RLS',
      'D11 positive: owner JWT SELECT returns >= 1 row',
      '>= 1 row',
      `${(ownerData ?? []).length} row(s)`,
      (ownerData ?? []).length >= 1,
    )

    // Negative: anon (no JWT) — createBrowserClient() returns 0 rows under 0003 policy
    const anonClient = createBrowserClient()
    const { data: anonData, error: anonError } = await anonClient.from('habits').select('id')
    check(
      'D11-RLS',
      'D11 negative (anon no-JWT): SELECT returns 0 rows (RLS blocks anon role)',
      '0 rows',
      `${(anonData ?? []).length} row(s), error=${anonError?.message ?? 'null'}`,
      (anonData ?? []).length === 0,
    )

    // Negative: signed-out — getAuthClient() after signOut returns 0 rows
    await getAuthClient().auth.signOut()
    const { data: signedOutData, error: signedOutError } = await getAuthClient().from('habits').select('id')
    check(
      'D11-RLS',
      'D11 negative (signed-out): SELECT returns 0 rows (RLS blocks unauthenticated)',
      '0 rows',
      `${(signedOutData ?? []).length} row(s), error=${signedOutError?.message ?? 'null'}`,
      (signedOutData ?? []).length === 0,
    )

    // Re-sign-in for any further cleanup
    await getAuthClient().auth.signInWithPassword({
      email: VERIFY_OWNER_EMAIL!,
      password: VERIFY_OWNER_PASSWORD!,
    })
  }

  // ── Report (aligned table, Phase-2 style — identical to sync-engine-verify.ts / lww-verify.ts) ──
  const w = [18, 72, 24, 40, 6]
  const line = (c: string[]) => '| ' + c.map((x, i) => x.padEnd(w[i])).join(' | ') + ' |'
  console.log('\n## CONVERGE VERIFY Report\n')
  console.log(line(['scope', 'check', 'expected', 'got', 'res']))
  console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|')
  for (const row of report) console.log(line(row))
  console.log()

  if (failures.length) {
    console.error(`CONVERGE VERIFY: FAIL (${failures.length})`)
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`CONVERGE VERIFY: PASS (${report.length}/${report.length}) — local Supabase stack, owner JWT, zero production risk`)
  process.exit(0)
}

main().catch((e) => {
  console.error('CONVERGE VERIFY: ERROR', e?.message ?? e)
  process.exit(1)
})
