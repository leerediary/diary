import type { Entity, Repository } from '@/lib/repository'
import type { Habit, HabitCompletion, JournalEntry, LongTermTask, PomodoroSession } from '@/lib/types'
import { getAuthClient } from '@/lib/supabase'
import { createReadRemote } from '@/lib/supabase-read'
import { getSyncState, setSyncState } from '@/lib/sync-state'

/**
 * Returns true when the PostgREST/GoTrue error indicates an auth/permission
 * failure (D-05/D-07 banner signal). Checks HTTP status first; falls back to
 * PostgREST error codes:
 *   PGRST301 — JWT missing or expired
 *   42501     — insufficient privilege (RLS rejection)
 */
function isAuthError(error: { status?: number; code?: string } | null | undefined): boolean {
  if (!error) return false
  if (typeof error.status === 'number' && (error.status === 401 || error.status === 403)) {
    return true
  }
  return error.code === 'PGRST301' || error.code === '42501'
}

/**
 * Remote sync adapter (Phase 5). Anon/publishable key ONLY — NO secret key
 * reaches the bundle (SEC-02): it composes `createBrowserClient()`
 * (NEXT_PUBLIC_* only); the secret-key path was deleted in Phase 3.
 *
 * Server-authoritative LWW logic lives entirely in
 * `supabase/migrations/0002_lww_guard_and_rls.sql` and is invoked via
 * `supabase.rpc()`. The adapter performs NO client-side read-compare-write —
 * `upsert`/`softDelete` are single RPC calls into 0002's atomic guarded
 * statements, so there is no client-side TOCTOU.
 *
 * Implements the sync-core triplet ONLY (D-01): `list` / `upsert` /
 * `softDelete`. The ~14 app-facing Repository methods are deliberately NOT
 * implemented here — the app runs on LocalRepository and never calls this
 * directly; only the Phase-6 SyncEngine does.
 *
 * No side effects on import; the Supabase client is created lazily per call
 * (same shape as `lib/supabase-read.ts`).
 */
export function createSupabaseRepository(): Pick<Repository, 'list' | 'upsert' | 'softDelete'> {
  // `list` reuses createReadRemote verbatim: it already satisfies the pullAll
  // contract and tombstone-inclusion semantics — do not change them.
  const read = createReadRemote()

  // Exact 0002 function names (see 05-01-SUMMARY).
  const UPSERT_RPC: Record<Entity, string> = {
    habits: 'lww_upsert_habits',
    habit_completions: 'lww_upsert_habit_completions',
    journal_entries: 'lww_upsert_journal_entries',
    long_term_tasks: 'lww_upsert_long_term_tasks',
    pomodoro_sessions: 'lww_upsert_pomodoro_sessions',
  }
  const DELETE_RPC: Record<Entity, string> = {
    habits: 'lww_soft_delete_habits',
    habit_completions: 'lww_soft_delete_habit_completions',
    journal_entries: 'lww_soft_delete_journal_entries',
    long_term_tasks: 'lww_soft_delete_long_term_tasks',
    pomodoro_sessions: 'lww_soft_delete_pomodoro_sessions',
  }

  return {
    list: read.list,

    async upsert<T>(entity: Entity, row: T): Promise<void> {
      const sb = getAuthClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await sb.rpc(UPSERT_RPC[entity], rowToRpcArgs(entity, row) as any)
      // D-05/D-07 isUnauthenticated signal — set/clear BEFORE the throw so the
      // banner updates even when sync stops silently on auth failure.
      if (error && isAuthError(error)) {
        setSyncState({ ...getSyncState(), isUnauthenticated: true })
      } else if (!error && getSyncState().isUnauthenticated) {
        setSyncState({ ...getSyncState(), isUnauthenticated: false })
      }
      if (error) throw new Error(`supabase upsert ${entity}: ${error.message}`)
      // A guard-rejected stale/equal write returns data=null with NO error —
      // intentionally NOT thrown; the sync engine reads it as "remote already
      // newer". Phase-5 signature stays Promise<void>.
    },

    async softDelete(entity: Entity, id: string): Promise<void> {
      const sb = getAuthClient()
      // The tombstone guard key is the time the sync engine carries; the
      // server trigger owns the persisted updated_at. Same uniform guard —
      // no tombstone special-case.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (sb as any).rpc(DELETE_RPC[entity], {
        p_id: id,
        p_updated_at: new Date().toISOString(),
      })
      // D-05/D-07 isUnauthenticated signal
      if (error && isAuthError(error)) {
        setSyncState({ ...getSyncState(), isUnauthenticated: true })
      } else if (!error && getSyncState().isUnauthenticated) {
        setSyncState({ ...getSyncState(), isUnauthenticated: false })
      }
      if (error) throw new Error(`supabase.softDelete(${entity}): ${error.message}`)
    },
  }
}

/**
 * Map a row (lib/types.ts shape) to the exact `p_*` parameter names of the
 * matching 0002 `lww_upsert_<entity>` function. `updated_at` is passed as the
 * guard key `p_updated_at` ONLY — 0002 never persists it (0001's trigger /
 * column DEFAULT owns the stored value).
 */
function rowToRpcArgs(entity: Entity, row: unknown): Record<string, unknown> {
  switch (entity) {
    case 'habits': {
      const r = row as Habit
      return {
        p_id: r.id,
        p_name: r.name,
        p_short_name: r.short_name,
        p_sort_order: r.sort_order,
        p_updated_at: r.updated_at,
        p_deleted_at: r.deleted_at,
      }
    }
    case 'habit_completions': {
      const r = row as HabitCompletion
      return {
        p_id: r.id,
        p_habit_id: r.habit_id,
        p_date: r.date,
        p_note: r.note,
        p_completed_at: r.completed_at, // D-12: client-authoritative tap time
        p_updated_at: r.updated_at,
        p_deleted_at: r.deleted_at,
      }
    }
    case 'journal_entries': {
      const r = row as JournalEntry
      return {
        p_id: r.id,
        p_date: r.date,
        p_content: r.content,
        p_updated_at: r.updated_at,
        p_deleted_at: r.deleted_at,
      }
    }
    case 'long_term_tasks': {
      const r = row as LongTermTask
      return {
        p_id: r.id,
        p_name: r.name,
        p_category: r.category,
        p_parent_id: r.parent_id,
        p_is_for_today: r.is_for_today,
        p_delay_days: r.delay_days,
        p_completed: r.completed,
        p_completed_at: r.completed_at,
        p_created_at: r.created_at,
        p_last_rollover_date: r.last_rollover_date,
        p_updated_at: r.updated_at,
        p_deleted_at: r.deleted_at,
      }
    }
    case 'pomodoro_sessions': {
      const r = row as PomodoroSession
      return {
        p_id: r.id,
        p_started_at: r.started_at,
        p_duration_sec: r.duration_sec,
        p_notes: r.notes,
        p_habit_id: r.habit_id,
        p_shared_indices: r.shared_indices,
        p_task_id: r.task_id,
        p_marked_task_complete: r.marked_task_complete,
        p_updated_at: r.updated_at,
        p_deleted_at: r.deleted_at,
      }
    }
  }
}
