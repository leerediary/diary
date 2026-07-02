import type { Entity, Repository } from '@/lib/repository'
import { getAuthClient } from '@/lib/supabase'
import { getSyncState, setSyncState } from '@/lib/sync-state'

/**
 * Read-only remote using the authenticated client singleton (Phase 7 / D-06).
 * Previously used createBrowserClient() (anon); now uses getAuthClient() so
 * reads carry the owner JWT and satisfy the 0003 auth.uid() RLS policy.
 * SEC-02 intact: still the anon/publishable key; identity comes from the JWT.
 *
 * No side effects on import; the auth client is constructed lazily inside list.
 */

/** isAuthError: mirrors the predicate in lib/supabase-repository.ts (D-05/D-07). */
function isAuthError(error: { status?: number; code?: string } | null | undefined): boolean {
  if (!error) return false
  if (typeof error.status === 'number' && (error.status === 401 || error.status === 403)) {
    return true
  }
  return error.code === 'PGRST301' || error.code === '42501'
}

export function createReadRemote(): Pick<Repository, 'list'> {
  return {
    async list<T>(
      entity: Entity,
      opts?: { sinceUpdatedAt?: string; includeDeleted?: boolean },
    ): Promise<T[]> {
      const sb = getAuthClient()
      let q = sb.from(entity).select('*')
      if (opts?.sinceUpdatedAt) q = q.gt('updated_at', opts.sinceUpdatedAt)
      const { data, error } = await q
      // D-05/D-07 isUnauthenticated signal — set/clear before throw so banner
      // updates even when sync silently stops on an auth failure.
      if (error && isAuthError(error)) {
        setSyncState({ ...getSyncState(), isUnauthenticated: true })
      } else if (!error && getSyncState().isUnauthenticated) {
        setSyncState({ ...getSyncState(), isUnauthenticated: false })
      }
      if (error) throw new Error(`read-remote.list(${entity}): ${error.message}`)
      let rows = (data ?? []) as Array<T & { deleted_at?: string | null }>
      // Default sync-core semantics include tombstones; only filter them when
      // the caller explicitly asks for live-only.
      if (opts && opts.includeDeleted === false) {
        rows = rows.filter((r) => r.deleted_at == null)
      }
      return rows as unknown as T[]
    },
  }
}
