import type { Repository, Entity } from '@/lib/repository'
import type { LocalRepository } from '@/lib/local-repository'

/**
 * The data-bearing entities pulled from Supabase into the local store.
 *
 * `journal_entries` is deliberately EXCLUDED: journal starts fresh in
 * diary-web (user decision 2026-05-18) — it was never migrated from Obsidian
 * and the Supabase table is empty by design.
 */
export const PULL_ENTITIES = ['habits', 'habit_completions', 'long_term_tasks'] as const

/**
 * Reusable sync-pull orchestrator. For each data entity: read every row from
 * `remote` and load it VERBATIM into `local`.
 *
 * It intentionally uses the generic sync-core `remote.list(entity)` (not the
 * app-facing query methods) so it also transfers tombstones, and writes via
 * `local.bulkLoad` (not `upsert`) so server `id`/`updated_at`/`deleted_at`
 * are preserved. This is the exact mechanism the Phase 6 sync "pull" reuses —
 * it is real sync machinery, not a one-off importer.
 *
 * Execution context (browser first-run bootstrap vs. test harness) is the
 * caller's concern; this module has no side effects on import and no CLI.
 *
 * @returns per-entity row count transferred.
 */
export async function pullAll(
  remote: Pick<Repository, 'list'>,
  local: LocalRepository,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const entity of PULL_ENTITIES) {
    const rows = await remote.list<unknown>(entity as Entity)
    await local.bulkLoad(entity as Entity, rows)
    counts[entity] = rows.length
  }
  return counts
}
