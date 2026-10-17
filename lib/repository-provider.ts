import type { Repository } from '@/lib/repository'
import { LocalRepository } from '@/lib/local-repository'
import { SqliteLocalRepository } from '@/lib/sqlite-repository'
import { SyncingLocalRepository } from '@/lib/syncing-repository'
import { LOCAL_ONLY } from '@/lib/local-only'

/**
 * The ONE place that decides the active Repository implementation.
 *
 * Phase 3 (this swap): client-side `LocalRepository` (Dexie/IndexedDB) is the
 * active backend. App code depends only on the Repository interface — never on
 * a concrete class — so this single line is what the whole client pivot turns on.
 *
 * Phase 6 (this swap): wraps LocalRepository in SyncingLocalRepository so that
 * every user-facing mutation is transparently enqueued into the persistent Dexie
 * outbox. The wrapper implements the full Repository interface via delegation —
 * app code is unchanged; only the instantiation binding changes here.
 *
 * Phase 8 (this swap): adds the native-vs-web branch. D-04 coexistence — web
 * build keeps Dexie LocalRepository; native build (window.diaryBridge injected
 * atDocumentStart by Swift shell, Plan 08-02) selects SqliteLocalRepository.
 * The SyncingLocalRepository wrapper is byte-unchanged (D-03). Runtime presence
 * of `window.diaryBridge` is the single signal — no build-time env var.
 *
 * No `server-only`, no Supabase, no secret key reaches the bundle (SEC-02).
 * IMPORTANT: every Repository call MUST happen inside a client effect/handler —
 * never at module scope or during render. Build-time prerender runs in Node
 * with no IndexedDB (see lib/local-db.ts) and no `window` (see lib/sqlite-bridge.ts).
 */
let instance: Repository | null = null

export function getRepository(): Repository {
  if (!instance) {
    // D-04 / D-08: branch on runtime bridge presence. The Swift shell injects
    // `window.diaryBridge` atDocumentStart in the native build; web builds
    // never see it (so this stays falsy and Dexie wins).
    const isNative = typeof window !== 'undefined' && !!window.diaryBridge
    const local = isNative ? new SqliteLocalRepository() : new LocalRepository()
    // Phase 19 D-02: a LOCAL_ONLY build has no sync path — SyncTrigger/SyncBanner
    // are gated out of the layout, so nothing ever drains the outbox. Wrapping in
    // SyncingLocalRepository here would enqueue an outbox row on every mutation
    // that grows forever. Hand out the bare repository instead; sync bookkeeping
    // belongs only where sync actually runs.
    if (LOCAL_ONLY) {
      instance = local
    } else {
      // D-03: SyncingLocalRepository.constructor types its `inner` as LocalRepository;
      // SqliteLocalRepository implements the same Repository surface — cast preserves
      // D-03 (no edit to syncing-repository.ts).
      instance = new SyncingLocalRepository(local as unknown as LocalRepository)
    }
  }
  return instance
}

/**
 * Typed accessor for the local-only primitives (bulkLoad, bulkLoadAll) that
 * aren't on the Repository interface. Centralizes the `as unknown as
 * LocalRepository` cast that was previously copy-pasted across 5+ call sites.
 *
 * Both the bare LocalRepository and the SyncingLocalRepository wrapper forward
 * these methods, so the cast is sound regardless of LOCAL_ONLY / native branch.
 *
 * Same discipline as getRepository(): only call inside an effect/handler — never
 * at module scope or render time.
 */
export function getLocalRepository(): LocalRepository {
  return getRepository() as unknown as LocalRepository
}
