// LWW semantic verification harness — Phase 5 / Plan 05-02 (D-05).
//
// Drives the REAL SupabaseRepository sync-core triplet (createSupabaseRepository
// → sb.rpc into 0002's atomic LWW guard) against the DISPOSABLE LOCAL Supabase
// stack via the ANON key, then hard-fails (exit 1) on any LWW-semantic
// discrepancy. Proves the full 17-point matrix A.1–F.17 from 05-RESEARCH.md
// "## Validation Architecture" as a Phase-2-style binary PASS/FAIL report.
//
// This harness MUTATES (it is not read-only). It pulls in NO IndexedDB shim —
// it drives real Postgres through the adapter under test.
//
// Run (local stack ONLY — D-04; never the live project, never `supabase db push`):
//   supabase start
//   supabase db reset
//   export NEXT_PUBLIC_SUPABASE_URL="$(supabase status -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).API_URL))')"
//   export NEXT_PUBLIC_SUPABASE_ANON_KEY="$(supabase status -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).ANON_KEY))')"
//   npm run verify:lww
//   supabase stop
//
// Anon key only — the secret-key path was deleted in Phase 3 (SEC-02).
import { randomUUID } from 'node:crypto'
import type { Entity } from '@/lib/repository'
import type { HabitCompletion, Habit, JournalEntry, LongTermTask } from '@/lib/types'
import { createSupabaseRepository } from '@/lib/supabase-repository'
import { createBrowserClient } from '@/lib/supabase'

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
      `REFUSING to run the LWW write/guard matrix against a non-local Supabase URL (D-04). ` +
        `Point at the local stack only (got host="${host}"). No write was performed.`,
    )
    process.exit(1)
  }
}

const repo = createSupabaseRepository()

type Row = Record<string, unknown>
const failures: string[] = []
const report: Array<[string, string, string, string, string]> = []
function check(entity: string, name: string, expected: unknown, got: unknown, pass: boolean) {
  report.push([entity, name, String(expected), String(got), pass ? 'PASS' : 'FAIL'])
  if (!pass) failures.push(`${entity} / ${name}: expected ${expected}, got ${got}`)
}

const FAR_PAST = '2000-01-01T00:00:00.000Z'
const FAR_FUTURE = '2099-01-01T00:00:00.000Z'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Read every row (incl. tombstones) for an entity.
async function all<T = Row>(entity: Entity): Promise<T[]> {
  return repo.list<T>(entity, { includeDeleted: true })
}
async function live<T = Row>(entity: Entity): Promise<T[]> {
  return repo.list<T>(entity, { includeDeleted: false })
}
function byId<T extends { id: string }>(rows: T[], id: string): T | undefined {
  return rows.find((r) => r.id === id)
}

function hc(habit_id: string, date: string, note: string | null, updated_at: string, deleted_at: string | null): HabitCompletion {
  return { id: randomUUID(), habit_id, date, note, completed_at: updated_at, updated_at, deleted_at }
}

async function main() {
  // ── A. Upsert basics ──
  {
    // A.1 — upsert INSERT: new row appears; server updated_at non-null and is
    // the server clock (NOT the client value we sent).
    const id = randomUUID()
    const h: Habit = { id, name: 'A1', short_name: 'a1', sort_order: 1, updated_at: FAR_PAST, deleted_at: null }
    await repo.upsert<Habit>('habits', h)
    const rows = await all<Habit>('habits')
    const got = byId(rows, id)
    const serverClockOk = !!got && !!got.updated_at && got.updated_at !== FAR_PAST && new Date(got.updated_at).getUTCFullYear() >= 2025
    check('habits', 'A.1 upsert INSERT (server-clock updated_at, not client value)', 'row present, updated_at≈now', got ? `present, ua=${got.updated_at}` : 'absent', !!got && rows.length > 0 && serverClockOk)
  }
  {
    // A.2 — upsert UPDATE via natural-key target, no duplicate row.
    const h = randomUUID()
    const d = '2031-01-02'
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'a', FAR_PAST, null))
    await sleep(20)
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'b', FAR_FUTURE, null))
    const rows = (await all<HabitCompletion>('habit_completions')).filter((r) => r.habit_id === h && r.date === d)
    check('habit_completions', 'A.2 upsert UPDATE natural-key (one row, data changed)', '1 row, note=b', `${rows.length} row, note=${rows[0]?.note}`, rows.length === 1 && rows[0]?.note === 'b')
  }

  // ── B. The guard (core) ──
  {
    // B.3 — guard REJECTS stale (data + stored updated_at unchanged; no-op).
    const h = randomUUID()
    const d = '2032-02-02'
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'keep', FAR_FUTURE, null))
    const before = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'STALE', FAR_PAST, null))
    const after = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    check('habit_completions', 'B.3 guard REJECTS stale (silent no-op)', 'note=keep, ua unchanged', `note=${after.note}, uaSame=${after.updated_at === before.updated_at}`, !!before && after.note === 'keep' && after.updated_at === before.updated_at)
  }
  {
    // B.4 — guard REJECTS equal (strict >; rollover-replay idempotency primitive).
    const h = randomUUID()
    const d = '2033-03-03'
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'v1', FAR_FUTURE, null))
    const stored = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    // Replay with p_updated_at EXACTLY == stored server updated_at → equal → no-op.
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'v1-REPLAY', stored.updated_at, null))
    const after = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    check('habit_completions', 'B.4 guard REJECTS equal timestamp (no-op)', 'note=v1 unchanged', `note=${after.note}`, !!stored && after.note === 'v1' && after.updated_at === stored.updated_at)
  }
  {
    // B.5 — guard ACCEPTS newer; stored updated_at advances and is server-clock
    // (NOT the far-future client value).
    const h = randomUUID()
    const d = '2034-04-04'
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'old', FAR_PAST, null))
    const before = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    await sleep(30)
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'new', FAR_FUTURE, null))
    const after = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    const advanced = after.updated_at > before.updated_at
    const serverClock = after.updated_at !== FAR_FUTURE && new Date(after.updated_at).getUTCFullYear() < 2099
    check('habit_completions', 'B.5 guard ACCEPTS newer (data changed, server-clock restamp)', 'note=new, ua advanced & server-clock', `note=${after.note}, advanced=${advanced}, serverClock=${serverClock}`, after.note === 'new' && advanced && serverClock)
  }

  // ── C. softDelete + tombstone (DATA-03) ──
  {
    // C.6 — softDelete sets tombstone; persisted updated_at advanced.
    const h = randomUUID()
    const d = '2035-05-05'
    const row = hc(h, d, 'n', FAR_PAST, null)
    await repo.upsert<HabitCompletion>('habit_completions', row)
    const before = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    await sleep(30)
    await repo.softDelete('habit_completions', before.id)
    const after = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    check('habit_completions', 'C.6 softDelete sets tombstone (deleted_at set, ua advanced)', 'deleted_at!=null, ua>before', `deleted_at=${after.deleted_at}, advanced=${after.updated_at > before.updated_at}`, after.deleted_at != null && after.updated_at > before.updated_at)
  }
  {
    // C.7 — live read excludes tombstone; default list includes it.
    const h = randomUUID()
    const d = '2036-06-06'
    const row = hc(h, d, 'n', FAR_PAST, null)
    await repo.upsert<HabitCompletion>('habit_completions', row)
    const seeded = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    await sleep(20)
    await repo.softDelete('habit_completions', seeded.id)
    const inLive = (await live<HabitCompletion>('habit_completions')).some((r) => r.habit_id === h && r.date === d)
    const inAll = (await all<HabitCompletion>('habit_completions')).some((r) => r.habit_id === h && r.date === d)
    check('habit_completions', 'C.7 live excludes tombstone, default includes', 'live=false, all=true', `live=${inLive}, all=${inAll}`, inLive === false && inAll === true)
  }
  {
    // C.8 — stale live write cannot revive a newer tombstone.
    const h = randomUUID()
    const d = '2037-07-07'
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'n', FAR_FUTURE, null))
    const seeded = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    await sleep(20)
    await repo.softDelete('habit_completions', seeded.id) // tombstone at server-now
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'REVIVE', FAR_PAST, null)) // stale live
    const after = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    check('habit_completions', 'C.8 stale live cannot revive newer tombstone', 'deleted_at still set', `deleted_at=${after.deleted_at}`, after.deleted_at != null)
  }
  {
    // C.9 — stale tombstone cannot delete a newer live row.
    const h = randomUUID()
    const d = '2038-08-08'
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'live', FAR_FUTURE, null))
    const after0 = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    // stale tombstone via upsert (deleted_at set, far-past guard key) → rejected.
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'live', FAR_PAST, FAR_PAST))
    const after = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    check('habit_completions', 'C.9 stale tombstone cannot delete newer live', 'deleted_at still null', `deleted_at=${after.deleted_at}`, !!after0 && after.deleted_at == null)
  }
  {
    // C.10 — newer tombstone wins.
    const h = randomUUID()
    const d = '2039-09-09'
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'live', FAR_PAST, null))
    await sleep(20)
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'live', FAR_FUTURE, FAR_FUTURE)) // newer tombstone
    const after = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    check('habit_completions', 'C.10 newer tombstone wins', 'deleted_at set', `deleted_at=${after.deleted_at}`, after.deleted_at != null)
  }
  {
    // C.11 — newer un-delete wins (legitimate resurrection).
    const h = randomUUID()
    const d = '2040-10-10'
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'x', FAR_PAST, FAR_PAST)) // tombstone
    const t = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    await sleep(20)
    await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'x', FAR_FUTURE, null)) // newer un-delete
    const after = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    check('habit_completions', 'C.11 newer un-delete wins', 'deleted_at cleared', `wasDeleted=${t.deleted_at != null}, nowDeleted=${after.deleted_at != null}`, t.deleted_at != null && after.deleted_at == null)
  }

  // ── D. completions toggle convergence on a stable (habit_id,date) row ──
  {
    // D.12 — upsert(complete) → softDelete(uncheck) → upsert(complete); exactly
    // ONE row throughout; final live.
    const h = randomUUID()
    const d = '2041-11-11'
    const id = randomUUID()
    await repo.upsert<HabitCompletion>('habit_completions', { id, habit_id: h, date: d, note: null, completed_at: FAR_PAST, updated_at: FAR_PAST, deleted_at: null })
    const seeded = (await all<HabitCompletion>('habit_completions')).find((r) => r.habit_id === h && r.date === d)!
    await sleep(30)
    await repo.softDelete('habit_completions', seeded.id)
    await sleep(10)
    await repo.upsert<HabitCompletion>('habit_completions', { id, habit_id: h, date: d, note: null, completed_at: FAR_FUTURE, updated_at: FAR_FUTURE, deleted_at: null })
    const rows = (await all<HabitCompletion>('habit_completions')).filter((r) => r.habit_id === h && r.date === d)
    check('habit_completions', 'D.12 toggle convergence (one stable row, final live)', '1 row, deleted_at=null', `${rows.length} row, deleted_at=${rows[0]?.deleted_at}`, rows.length === 1 && rows[0]?.deleted_at == null)
  }

  // ── E. Rollover idempotency server-side (DATA-04 / D-06) ──
  {
    // E.13 — rollover replay no-op: push a rolled-over task, push an identical
    // row again with EQUAL updated_at → guard rejects → delay_days unchanged.
    const id = randomUUID()
    const base: LongTermTask = {
      id, name: 'roll', category: 'c', parent_id: null, is_for_today: false,
      delay_days: 5, completed: false, completed_at: null,
      created_at: FAR_PAST, last_rollover_date: '2042-12-12',
      updated_at: FAR_FUTURE, deleted_at: null,
    }
    await repo.upsert<LongTermTask>('long_term_tasks', base)
    const stored = (await all<LongTermTask>('long_term_tasks')).find((r) => r.id === id)!
    // Replay: same row, delay_days bumped, but EQUAL guard key → rejected.
    await repo.upsert<LongTermTask>('long_term_tasks', { ...base, delay_days: 6, updated_at: stored.updated_at })
    const after = (await all<LongTermTask>('long_term_tasks')).find((r) => r.id === id)!
    check('long_term_tasks', 'E.13 rollover replay no-op (equal ts → delay_days unchanged)', 'delay_days=5', `delay_days=${after.delay_days}`, !!stored && after.delay_days === 5)
  }
  {
    // E.14 — soft-deleted task stays excluded under a stale upsert.
    const id = randomUUID()
    const base: LongTermTask = {
      id, name: 't', category: 'c', parent_id: null, is_for_today: true,
      delay_days: 0, completed: false, completed_at: null,
      created_at: FAR_PAST, last_rollover_date: null,
      updated_at: FAR_FUTURE, deleted_at: null,
    }
    await repo.upsert<LongTermTask>('long_term_tasks', base)
    const seeded = (await all<LongTermTask>('long_term_tasks')).find((r) => r.id === id)!
    await sleep(20)
    await repo.softDelete('long_term_tasks', seeded.id)
    await repo.upsert<LongTermTask>('long_term_tasks', { ...base, name: 'STALE', updated_at: FAR_PAST }) // stale
    const after = (await all<LongTermTask>('long_term_tasks')).find((r) => r.id === id)!
    const inLive = (await live<LongTermTask>('long_term_tasks')).some((r) => r.id === id)
    check('long_term_tasks', 'E.14 soft-deleted task stays excluded', 'deleted_at set, not live', `deleted_at=${after.deleted_at}, inLive=${inLive}`, after.deleted_at != null && inLive === false)
  }

  // ── F. Cross-table coverage ──
  {
    // F.15 — insert + stale-reject + newer-accept for ALL 4 entities with the
    // correct conflict target; + journal one-row-per-date under concurrent
    // same-date upsert (single-side LWW only).
    let ok = true
    const detail: string[] = []

    // habits — conflict (id)
    {
      const id = randomUUID()
      await repo.upsert<Habit>('habits', { id, name: 'F-h', short_name: 'fh', sort_order: 2, updated_at: FAR_FUTURE, deleted_at: null })
      await repo.upsert<Habit>('habits', { id, name: 'STALE', short_name: 'x', sort_order: 9, updated_at: FAR_PAST, deleted_at: null })
      await sleep(20)
      await repo.upsert<Habit>('habits', { id, name: 'F-h2', short_name: 'fh', sort_order: 3, updated_at: FAR_FUTURE, deleted_at: null })
      const rows = (await all<Habit>('habits')).filter((r) => r.id === id)
      const good = rows.length === 1 && rows[0].name === 'F-h2'
      ok = ok && good
      detail.push(`habits=${good}`)
    }
    // habit_completions — conflict (habit_id,date)
    {
      const h = randomUUID()
      const d = '2043-01-01'
      await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'F', FAR_FUTURE, null))
      await repo.upsert<HabitCompletion>('habit_completions', hc(h, d, 'STALE', FAR_PAST, null))
      const rows = (await all<HabitCompletion>('habit_completions')).filter((r) => r.habit_id === h && r.date === d)
      const good = rows.length === 1 && rows[0].note === 'F'
      ok = ok && good
      detail.push(`habit_completions=${good}`)
    }
    // long_term_tasks — conflict (id)
    {
      const id = randomUUID()
      const base: LongTermTask = { id, name: 'F-t', category: 'c', parent_id: null, is_for_today: false, delay_days: 1, completed: false, completed_at: null, created_at: FAR_PAST, last_rollover_date: null, updated_at: FAR_FUTURE, deleted_at: null }
      await repo.upsert<LongTermTask>('long_term_tasks', base)
      await repo.upsert<LongTermTask>('long_term_tasks', { ...base, name: 'STALE', updated_at: FAR_PAST })
      const rows = (await all<LongTermTask>('long_term_tasks')).filter((r) => r.id === id)
      const good = rows.length === 1 && rows[0].name === 'F-t'
      ok = ok && good
      detail.push(`long_term_tasks=${good}`)
    }
    // journal_entries — conflict (date); one row per date under concurrent same-date upsert
    {
      const d = '2044-02-02'
      await repo.upsert<JournalEntry>('journal_entries', { id: randomUUID(), date: d, content: 'j-old', updated_at: FAR_PAST, deleted_at: null })
      await sleep(20)
      await repo.upsert<JournalEntry>('journal_entries', { id: randomUUID(), date: d, content: 'j-new', updated_at: FAR_FUTURE, deleted_at: null })
      const rows = (await all<JournalEntry>('journal_entries')).filter((r) => r.date === d)
      const good = rows.length === 1 && rows[0].content === 'j-new'
      ok = ok && good
      detail.push(`journal_entries(one-per-date)=${good}`)
    }
    check('cross-table', 'F.15 insert/stale-reject/newer-accept all 4 entities + journal one-row-per-date', 'all true', detail.join(' '), ok)
  }
  {
    // F.16 — UNIQUE-constraint sanity: a raw PostgREST duplicate insert (no
    // ON CONFLICT) on the natural key MUST raise a unique violation (23505).
    const sb = createBrowserClient()
    const h = randomUUID()
    const d = '2045-03-03'
    const e1 = await sb.from('habit_completions').insert({ id: randomUUID(), habit_id: h, date: d })
    const dup = await sb.from('habit_completions').insert({ id: randomUUID(), habit_id: h, date: d })
    const hcViolated = !!dup.error && (dup.error.code === '23505' || /duplicate key|unique/i.test(dup.error.message))

    const jd = '2046-04-04'
    const j1 = await sb.from('journal_entries').insert({ id: randomUUID(), date: jd, content: 'a' })
    const jdup = await sb.from('journal_entries').insert({ id: randomUUID(), date: jd, content: 'b' })
    const jeViolated = !!jdup.error && (jdup.error.code === '23505' || /duplicate key|unique/i.test(jdup.error.message))

    const seedsOk = !e1.error && !j1.error // positive: first inserts really happened (no empty false-pass)
    check('cross-table', 'F.16 UNIQUE(habit_id,date) & UNIQUE(date) enforced (raw dup → 23505)', 'both unique violations', `seedsOk=${seedsOk}, hc=${hcViolated}, je=${jeViolated}`, seedsOk && hcViolated && jeViolated)
  }
  {
    // F.17 — open anon RLS: with the anon key only, INSERT + SELECT succeed on
    // all 4 tables (without open RLS the whole write path 401/403s).
    const sb = createBrowserClient()
    let ok = true
    const detail: string[] = []
    const ins: Record<Entity, Row> = {
      habits: { id: randomUUID(), name: 'rls', short_name: 'r', sort_order: 7 },
      habit_completions: { id: randomUUID(), habit_id: randomUUID(), date: '2047-05-05' },
      journal_entries: { id: randomUUID(), date: '2048-06-06', content: 'rls' },
      long_term_tasks: { id: randomUUID(), name: 'rls', category: 'c', is_for_today: false, delay_days: 0, completed: false, created_at: FAR_PAST },
      pomodoro_sessions: { id: randomUUID(), started_at: '2047-06-06T00:00:00.000Z', duration_sec: 1500, notes: [], habit_id: null, shared_indices: [] },
    }
    for (const t of ['habits', 'habit_completions', 'journal_entries', 'long_term_tasks', 'pomodoro_sessions'] as Entity[]) {
      const w = await sb.from(t).insert(ins[t])
      const r = await sb.from(t).select('id').limit(1)
      const good = !w.error && !r.error && (r.data?.length ?? 0) > 0
      ok = ok && good
      detail.push(`${t}=${good}`)
    }
    check('cross-table', 'F.17 open anon RLS — anon INSERT+SELECT on all 4 tables', 'all true', detail.join(' '), ok)
  }

  // ── Report (aligned table, Phase-2 style) ──
  const w = [14, 64, 30, 34, 6]
  const line = (c: string[]) => '| ' + c.map((x, i) => x.padEnd(w[i])).join(' | ') + ' |'
  console.log('\n## LWW Verify Report\n')
  console.log(line(['scope', 'matrix point', 'expected', 'got', 'res']))
  console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|')
  for (const row of report) console.log(line(row))
  console.log()

  if (failures.length) {
    console.error(`LWW VERIFY: FAIL (${failures.length})`)
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`LWW VERIFY: PASS (${report.length}/${report.length}) — local Supabase stack, anon key, zero production risk`)
  process.exit(0)
}

main().catch((e) => {
  console.error('LWW VERIFY: ERROR', e?.message ?? e)
  process.exit(1)
})
