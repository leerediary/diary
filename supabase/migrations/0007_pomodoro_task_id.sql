-- 0007_pomodoro_task_id.sql — Phase 14 / Plan 14-01
--
-- Purpose: Add task_id uuid (nullable, FK to long_term_tasks.id) to pomodoro_sessions
-- and rebuild the LWW upsert RPC signature to include p_task_id.
--
-- Application-layer invariant (NOT enforced at DB): habit_id and task_id are mutually
-- exclusive — at most one is non-null per session. The DB stores both as independent
-- nullable columns. UI / onSubmitSession enforce the invariant.
--
-- Idempotency:
--   * Catalog checks (information_schema.columns / pg_proc) wrap ALTER and DROP
--   * No backfill: legacy rows leave task_id NULL by default
--
-- Apply to LOCAL stack: `supabase db reset`. Live cutover: standard run.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- (a) Add task_id column (idempotent via catalog check)
-- ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pomodoro_sessions' AND column_name = 'task_id'
  ) THEN
    ALTER TABLE pomodoro_sessions
      ADD COLUMN task_id UUID NULL REFERENCES long_term_tasks(id);
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- (b) Drop the old LWW upsert RPC (pre-task_id signature from 0006)
-- ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'lww_upsert_pomodoro_sessions'
      AND pg_get_function_identity_arguments(p.oid) =
          'p_id uuid, p_started_at timestamp with time zone, p_duration_sec integer, p_notes text[], p_habit_id uuid, p_shared_indices integer[], p_updated_at timestamp with time zone, p_deleted_at timestamp with time zone'
  ) THEN
    DROP FUNCTION public.lww_upsert_pomodoro_sessions(
      uuid, timestamptz, integer, text[], uuid, integer[], timestamptz, timestamptz
    );
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- (c) Recreate the LWW upsert RPC with p_task_id uuid parameter
--     Mirrors 0006 (d) structure: strict `>` guard, p_updated_at is the guard
--     KEY only (0001 column DEFAULT + trigger own the persisted updated_at).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lww_upsert_pomodoro_sessions(
  p_id             uuid,
  p_started_at     timestamptz,
  p_duration_sec   integer,
  p_notes          text[],
  p_habit_id       uuid,
  p_shared_indices integer[],
  p_task_id        uuid,
  p_updated_at     timestamptz,
  p_deleted_at     timestamptz
) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO pomodoro_sessions (id, started_at, duration_sec, notes, habit_id, shared_indices, task_id, deleted_at)
  VALUES (p_id, p_started_at, p_duration_sec, p_notes, p_habit_id, p_shared_indices, p_task_id, p_deleted_at)
  ON CONFLICT (id) DO UPDATE
     SET started_at     = EXCLUDED.started_at,
         duration_sec   = EXCLUDED.duration_sec,
         notes          = EXCLUDED.notes,
         habit_id       = EXCLUDED.habit_id,
         shared_indices = EXCLUDED.shared_indices,
         task_id        = EXCLUDED.task_id,
         deleted_at     = EXCLUDED.deleted_at
   WHERE p_updated_at > pomodoro_sessions.updated_at
  RETURNING true;
$$;

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────
-- (d) Re-GRANT EXECUTE on the new function signature (0006 (e) parity)
--     The lww_soft_delete_pomodoro_sessions function signature is unchanged
--     (takes only p_id, p_updated_at) — its GRANT from 0004 still holds.
-- ───────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION
  lww_upsert_pomodoro_sessions(uuid, timestamptz, integer, text[], uuid, integer[], uuid, timestamptz, timestamptz)
  TO anon, authenticated;
