import type { Entity, Repository } from '@/lib/repository'
import type { LocalRepository } from '@/lib/local-repository'
import { pullAll, PULL_ENTITIES } from '@/lib/migrate-pull'
import { createReadRemote } from '@/lib/supabase-read'

/**
 * First-run device populate (the Phase-2 deferred "one-time device populate").
 *
 * When a fresh device's local store is EMPTY, pull the real data once via the
 * provided or default read remote and load it VERBATIM (pullAll → LocalRepository.bulkLoad,
 * the Phase-2 primitive verified lossless 17/17). After this one seed the app
 * runs fully local (Phase 4 hardens true zero-network).
 *
 * Phase 7 (D-06): accepts an optional `remote` param so Bootstrap.tsx can pass
 * an authenticated createReadRemote() instance. Without it, falls back to the
 * default (now authenticated) createReadRemote(). Anon callers (verify harnesses)
 * that call bootstrapIfEmpty without a second arg use whatever getAuthClient()
 * returns — still correct for local-stack tests that sign in at harness startup.
 *
 * Idempotent + clobber-safe: if ANY pulled entity already has rows the store is
 * considered populated → no pull (bulkLoad is verbatim and would overwrite
 * local edits). `inFlight` only coalesces TRULY CONCURRENT calls; it is cleared
 * once the attempt settles so a later call re-evaluates emptiness (and returns
 * `{pulled:false}` because the store is now populated). No side effects on import.
 */
type BootstrapResult = { pulled: boolean; counts?: Record<string, number> }
let inFlight: Promise<BootstrapResult> | null = null

export function bootstrapIfEmpty(
  local: LocalRepository,
  remote?: Pick<Repository, 'list'>,
): Promise<BootstrapResult> {
  if (inFlight) return inFlight
  const run = (async (): Promise<BootstrapResult> => {
    for (const entity of PULL_ENTITIES) {
      const rows = await local.list<unknown>(entity as Entity, { includeDeleted: true })
      if (rows.length > 0) return { pulled: false } // already populated — never re-pull
    }
    const counts = await pullAll(remote ?? createReadRemote(), local)
    return { pulled: true, counts }
  })()
  inFlight = run
  // Clear once settled (success OR failure) so the next call re-checks the
  // store rather than replaying a stale cached result.
  run.then(
    () => { inFlight = null },
    () => { inFlight = null },
  )
  return run
}
