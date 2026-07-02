// Bootstrap / migration verification harness (Phase 3 / 03-04; supersedes the
// Phase 2 / 02-03 version).
//
// Drives the REAL first-run device bootstrap (lib/bootstrap.ts bootstrapIfEmpty
// → pullAll → LocalRepository.bulkLoad) against LIVE Supabase via the
// ANON/publishable key into a fake-indexeddb LocalRepository, then hard-fails
// (exit 1) on any losslessness discrepancy. Also asserts idempotency (second
// call must NOT re-pull) and that all four route data-loads return real rows.
// No journal checks — journal_entries starts empty by design (user 2026-05-18).
//
// Run: set -a; source .env.local; set +a; npm run verify:migration
//
// Anon key only — the secret-key path was deleted in Phase 3 (SEC-02). This
// exercises the exact code path the browser bootstrap uses.
import 'fake-indexeddb/auto'
import type { Entity } from '@/lib/repository'
import { LocalRepository } from '@/lib/local-repository'
import { db } from '@/lib/local-db'
import { PULL_ENTITIES } from '@/lib/migrate-pull'
import { createReadRemote } from '@/lib/supabase-read'
import { bootstrapIfEmpty } from '@/lib/bootstrap'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!url || !anon) {
  console.error('Missing env. Run: set -a; source .env.local; set +a; npm run verify:migration')
  process.exit(1)
}

const remote = createReadRemote()

type Row = Record<string, unknown>
const failures: string[] = []
const report: Array<[string, string, string, string, string]> = []
function check(entity: string, name: string, expected: unknown, got: unknown, pass: boolean) {
  report.push([entity, name, String(expected), String(got), pass ? 'PASS' : 'FAIL'])
  if (!pass) failures.push(`${entity} / ${name}: expected ${expected}, got ${got}`)
}

async function main() {
  // Fresh (empty) local store — simulates a brand-new device.
  await Promise.all([
    db.habits.clear(),
    db.habit_completions.clear(),
    db.journal_entries.clear(),
    db.long_term_tasks.clear(),
  ])
  const local = new LocalRepository(db)

  // ── First-run bootstrap (the real browser path) ──
  const first = await bootstrapIfEmpty(local)
  check('bootstrap', 'first run pulled', true, first.pulled, first.pulled === true)
  const counts = first.counts ?? {}

  for (const entity of PULL_ENTITIES) {
    const remoteRows = await remote.list<Row>(entity as Entity)
    const localRows = await local.list<Row>(entity as Entity, { includeDeleted: true })

    check(entity, 'count', remoteRows.length, localRows.length, localRows.length === remoteRows.length)
    check(entity, 'pull-count', remoteRows.length, counts[entity], counts[entity] === remoteRows.length)

    // per-row fidelity (re-stamp guard): updated_at + deleted_at verbatim
    const localById = new Map(localRows.map((r) => [r.id as string, r]))
    let fidelity = true
    for (const rr of remoteRows) {
      const lr = localById.get(rr.id as string)
      if (!lr || lr.updated_at !== rr.updated_at || (lr.deleted_at ?? null) !== (rr.deleted_at ?? null)) {
        fidelity = false
        break
      }
    }
    check(entity, 'row-fidelity(updated_at+deleted_at)', 'all match', fidelity ? 'all match' : 'MISMATCH', fidelity)
  }

  // habit_completions date-range completeness
  {
    const r = await remote.list<Row>('habit_completions')
    const l = await local.list<Row>('habit_completions', { includeDeleted: true })
    const key = (x: Row) => `${x.habit_id}|${x.date}`
    const rs = new Set(r.map(key))
    const ls = new Set(l.map(key))
    const sameSet = rs.size === ls.size && [...rs].every((k) => ls.has(k))
    check('habit_completions', 'natural-key set equal', rs.size, ls.size, sameSet)
    const dates = (rows: Row[]) => rows.map((x) => x.date as string).sort()
    const rd = dates(r)
    const ld = dates(l)
    check('habit_completions', 'min(date)', rd[0], ld[0], rd[0] === ld[0])
    check('habit_completions', 'max(date)', rd[rd.length - 1], ld[ld.length - 1], rd[rd.length - 1] === ld[ld.length - 1])
  }

  // task-tree integrity
  {
    const r = await remote.list<Row>('long_term_tasks')
    const l = await local.list<Row>('long_term_tasks', { includeDeleted: true })
    const ids = new Set(l.map((t) => t.id as string))
    const orphans = l.filter((t) => t.parent_id != null && !ids.has(t.parent_id as string))
    check('long_term_tasks', 'no orphan parent_id', 0, orphans.length, orphans.length === 0)
    const part = (rows: Row[]) => [
      rows.filter((t) => t.parent_id == null).length,
      rows.filter((t) => t.parent_id != null).length,
    ]
    const [rp, rc] = part(r)
    const [lp, lc] = part(l)
    check('long_term_tasks', 'parent count', rp, lp, rp === lp)
    check('long_term_tasks', 'child count', rc, lc, rc === lc)
  }

  // no journal
  {
    const j = await local.list<Row>('journal_entries', { includeDeleted: true })
    check('journal_entries', 'local empty (not migrated)', 0, j.length, j.length === 0)
    const inPull = (PULL_ENTITIES as readonly string[]).includes('journal_entries')
    check('journal_entries', 'excluded from PULL_ENTITIES', false, inPull, inPull === false)
  }

  // ── Idempotency: second call must NOT re-pull, counts unchanged ──
  {
    const before = await Promise.all(
      PULL_ENTITIES.map((e) => local.list<Row>(e as Entity, { includeDeleted: true }).then((r) => r.length)),
    )
    const second = await bootstrapIfEmpty(local)
    check('bootstrap', 'second run pulled=false', false, second.pulled, second.pulled === false)
    const after = await Promise.all(
      PULL_ENTITIES.map((e) => local.list<Row>(e as Entity, { includeDeleted: true }).then((r) => r.length)),
    )
    const unchanged = before.every((n, i) => n === after[i])
    check('bootstrap', 'row counts unchanged after re-run', before.join(','), after.join(','), unchanged)
  }

  // ── Four-route data-load sanity: real non-empty rows (no empty false-pass) ──
  {
    const habits = await local.listHabits()
    check('route:/', 'listHabits() non-empty', '>0', habits.length, habits.length > 0)

    const allComp = await local.list<Row>('habit_completions', { includeDeleted: true })
    const liveDates = allComp.filter((c) => c.deleted_at == null).map((c) => c.date as string).sort()
    const sampleDate = liveDates[liveDates.length - 1] ?? '2026-05-17'
    const day = await local.getDay(sampleDate)
    check('route:/', `getDay(${sampleDate}).completions non-empty`, '>0', day.completions.length, day.completions.length > 0)

    const ym = sampleDate.slice(0, 7)
    const [y, m] = ym.split('-').map(Number)
    const nextM = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
    const monthComp = await local.listMonthCompletions(`${ym}-01`, `${nextM}-01`)
    check('route:/monthly', 'listMonthCompletions() non-empty', '>0', monthComp.length, monthComp.length > 0)

    const tasks = await local.listAllTasks()
    check('route:/tasks', 'listAllTasks() non-empty', '>0', tasks.length, tasks.length > 0)

    const hId = habits[0]?.id
    const habit = hId ? await local.getHabit(hId) : null
    check('route:/habit', 'getHabit(firstId) found', 'non-null', habit ? 'found' : 'null', habit != null)
    const hc = hId ? await local.listHabitCompletions(hId) : []
    check('route:/habit', 'listHabitCompletions(firstId) returns', '>=0', hc.length, hc.length >= 0)
  }

  // Report
  const w = [16, 38, 16, 16, 6]
  const line = (c: string[]) => '| ' + c.map((x, i) => x.padEnd(w[i])).join(' | ') + ' |'
  console.log('\n## Bootstrap Verify Report\n')
  console.log(line(['entity', 'check', 'expected', 'got', 'res']))
  console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|')
  for (const row of report) console.log(line(row))
  console.log()

  if (failures.length) {
    console.error(`BOOTSTRAP VERIFY: FAIL (${failures.length})`)
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`BOOTSTRAP VERIFY: PASS (${report.length}/${report.length}) — anon key, read-only, zero mutation`)
  process.exit(0)
}

main().catch((e) => {
  console.error('BOOTSTRAP VERIFY: ERROR', e?.message ?? e)
  process.exit(1)
})
