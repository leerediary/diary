// LOCAL_ONLY no-outbox verification (Phase 19 review fix — Finding #2).
//
// In a LOCAL_ONLY build the sync UI (SyncTrigger/SyncBanner) is gated out, so
// nothing ever drains the outbox. The fix makes repository-provider hand out a
// bare LocalRepository (not the SyncingLocalRepository wrapper) under LOCAL_ONLY,
// so mutations never enqueue an outbox row in the first place.
//
// This harness sets NEXT_PUBLIC_LOCAL_ONLY=1 BEFORE importing the modules (the
// const is read at module-eval time) and asserts: (a) getRepository() is a bare
// LocalRepository, and (b) a real mutation leaves the outbox empty.
//
// Run: NEXT_PUBLIC_LOCAL_ONLY=1 npx tsx test/local-only-no-outbox-verify.ts
import 'fake-indexeddb/auto'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}`)
  if (!cond) failures++
}

async function main() {
  check('env NEXT_PUBLIC_LOCAL_ONLY=1 is set for this run', process.env.NEXT_PUBLIC_LOCAL_ONLY === '1')

  const { getRepository } = await import('@/lib/repository-provider')
  const { LocalRepository } = await import('@/lib/local-repository')
  const { SyncingLocalRepository } = await import('@/lib/syncing-repository')
  const { db } = await import('@/lib/local-db')

  const repo = getRepository()
  check('LOCAL_ONLY → getRepository() is bare LocalRepository', repo instanceof LocalRepository)
  check('LOCAL_ONLY → getRepository() is NOT the syncing wrapper', !(repo instanceof SyncingLocalRepository))

  // Seed a habit, then perform a real user mutation (toggle completion).
  await repo.upsert('habits', { id: 'h1', name: 'A', short_name: 'A', sort_order: 0 })
  await repo.setHabitCompleted('h1', '2026-06-04', true)
  await repo.addTask('a task', '', true)

  const outboxCount = await db.outbox.count()
  check('after 3 mutations the outbox is still empty (no leak)', outboxCount === 0)
  if (outboxCount !== 0) console.log(`   outbox had ${outboxCount} rows`)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} CHECK(S) FAILED`)
  await db.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
