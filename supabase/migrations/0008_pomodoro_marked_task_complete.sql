-- 0008_pomodoro_marked_task_complete.sql — Phase 14 / Plan 14-04
--
-- Purpose: Add marked_task_complete boolean (NOT NULL, DEFAULT FALSE) to pomodoro_sessions
-- and rebuild the LWW upsert RPC signature to include p_marked_task_complete.
--
-- Why: Phase 14-04 D-19 — ✓ in TodayActivity changes from task-level (task.completed) to
-- session-level (this session marked the task complete). Decoupled from long_term_tasks.completed.
--
-- Application-layer invariant: marked_task_complete === true requires task_id IS NOT NULL.
-- NOT enforced at DB. UI enforces via onSubmitSession.
--
-- Idempotency:
--   * Catalog checks (information_schema.columns / pg_proc) wrap ALTER and DROP
--   * Backfill: NOT NULL DEFAULT FALSE handles the column populate on ALTER
--
-- Apply to LOCAL stack: `supabase db reset`.
-- ⚠️ LIVE Supabase: USER must apply via dashboard SQL editor before any client upserts a session.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- (a) Add marked_task_complete column (idempotent via catalog check)
-- ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pomodoro_sessions' AND column_name = 'marked_task_complete'
  ) THEN
    ALTER TABLE pomodoro_sessions
      ADD COLUMN marked_task_complete BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- (b) Drop the old 9-arg LWW upsert RPC (from 0007, pre-marked_task_complete)
-- ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'lww_upsert_pomodoro_sessions'
      AND pg_get_function_identity_arguments(p.oid) =
          'p_id uuid, p_started_at timestamp with time zone, p_duration_sec integer, p_notes text[], p_habit_id uuid, p_shared_indices integer[], p_task_id uuid, p_updated_at timestamp with time zone, p_deleted_at timestamp with time zone'
  ) THEN
    DROP FUNCTION public.lww_upsert_pomodoro_sessions(
      uuid, timestamptz, integer, text[], uuid, integer[], uuid, timestamptz, timestamptz
    );
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- (c) Recreate the LWW upsert RPC with p_marked_task_complete boolean parameter
--     Inserted BETWEEN p_task_id and p_updated_at.
--     Strict `>` guard on p_updated_at (matches 0006/0007 structure).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lww_upsert_pomodoro_sessions(
  p_id                   uuid,
  p_started_at           timestamptz,
  p_duration_sec         integer,
  p_notes                text[],
  p_habit_id             uuid,
  p_shared_indices       integer[],
  p_task_id              uuid,
  p_marked_task_complete boolean,
  p_updated_at           timestamptz,
  p_deleted_at           timestamptz
) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO pomodoro_sessions (id, started_at, duration_sec, notes, habit_id, shared_indices, task_id, marked_task_complete, deleted_at)
  VALUES (p_id, p_started_at, p_duration_sec, p_notes, p_habit_id, p_shared_indices, p_task_id, p_marked_task_complete, p_deleted_at)
  ON CONFLICT (id) DO UPDATE
     SET started_at           = EXCLUDED.started_at,
         duration_sec         = EXCLUDED.duration_sec,
         notes                = EXCLUDED.notes,
         habit_id             = EXCLUDED.habit_id,
         shared_indices       = EXCLUDED.shared_indices,
         task_id              = EXCLUDED.task_id,
         marked_task_complete = EXCLUDED.marked_task_complete,
         deleted_at           = EXCLUDED.deleted_at
   WHERE p_updated_at > pomodoro_sessions.updated_at
  RETURNING true;
$$;

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────
-- (d) Re-GRANT EXECUTE on the new 10-arg function signature
--     The lww_soft_delete_pomodoro_sessions function is unchanged (takes only p_id, p_updated_at).
-- ───────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION
  lww_upsert_pomodoro_sessions(uuid, timestamptz, integer, text[], uuid, integer[], uuid, boolean, timestamptz, timestamptz)
  TO anon, authenticated;
