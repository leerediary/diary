-- 0006_pomodoro_shared_indices.sql — Phase 12 / Plan 12-01
--
-- Purpose: Add shared_indices integer[] to pomodoro_sessions.
--   * Add shared_indices integer[] NOT NULL DEFAULT ARRAY[]::integer[]
--   * Backfill per D-10: ARRAY(SELECT generate_series(0, array_length(notes,1)-1))
--     for rows with habit_id IS NOT NULL AND non-empty notes AND shared_indices still empty
--   * Drop the old lww_upsert_pomodoro_sessions function (pre-shared_indices signature)
--   * Recreate lww_upsert_pomodoro_sessions with p_shared_indices integer[] parameter
--   * Re-GRANT EXECUTE on the new function to anon, authenticated
--
-- Idempotency:
--   * IF NOT EXISTS / IF EXISTS guards where Postgres permits
--   * ALTER COLUMN is NOT natively idempotent; the DO $$ block wraps it in catalog checks
--
-- Apply to LOCAL stack: `supabase db reset`. Live cutover follows D-15 runbook.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- (a) Add shared_indices column (idempotent via catalog check)
-- ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pomodoro_sessions' AND column_name = 'shared_indices'
  ) THEN
    ALTER TABLE pomodoro_sessions
      ADD COLUMN shared_indices integer[] NOT NULL DEFAULT ARRAY[]::integer[];
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- (b) Backfill per D-10: for rows where habit_id IS NOT NULL AND notes is
--     non-empty AND shared_indices is still empty, fill [0..notes.length-1].
-- ───────────────────────────────────────────────────────────────────────────
UPDATE pomodoro_sessions
   SET shared_indices = ARRAY(SELECT generate_series(0, array_length(notes, 1) - 1))
 WHERE habit_id IS NOT NULL
   AND notes <> ARRAY[]::text[]
   AND shared_indices = ARRAY[]::integer[];

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────
-- (c) Drop the old LWW upsert RPC (pre-shared_indices signature from 0005)
--     The DROP must specify the exact argument types — Postgres distinguishes
--     functions by signature. Wrap in DO $$ to skip if signature already changed.
-- ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'lww_upsert_pomodoro_sessions'
      AND pg_get_function_identity_arguments(p.oid) =
          'p_id uuid, p_started_at timestamp with time zone, p_duration_sec integer, p_notes text[], p_habit_id uuid, p_updated_at timestamp with time zone, p_deleted_at timestamp with time zone'
  ) THEN
    DROP FUNCTION public.lww_upsert_pomodoro_sessions(
      uuid, timestamptz, integer, text[], uuid, timestamptz, timestamptz
    );
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- (d) Recreate the LWW upsert RPC with p_shared_indices integer[] parameter
--     Mirrors 0005 (e) structure: strict `>` guard, p_updated_at is the guard
--     KEY only (0001 column DEFAULT + trigger own the persisted updated_at).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lww_upsert_pomodoro_sessions(
  p_id             uuid,
  p_started_at     timestamptz,
  p_duration_sec   integer,
  p_notes          text[],
  p_habit_id       uuid,
  p_shared_indices integer[],
  p_updated_at     timestamptz,
  p_deleted_at     timestamptz
) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO pomodoro_sessions (id, started_at, duration_sec, notes, habit_id, shared_indices, deleted_at)
  VALUES (p_id, p_started_at, p_duration_sec, p_notes, p_habit_id, p_shared_indices, p_deleted_at)
  ON CONFLICT (id) DO UPDATE
     SET started_at     = EXCLUDED.started_at,
         duration_sec   = EXCLUDED.duration_sec,
         notes          = EXCLUDED.notes,
         habit_id       = EXCLUDED.habit_id,
         shared_indices = EXCLUDED.shared_indices,
         deleted_at     = EXCLUDED.deleted_at
   WHERE p_updated_at > pomodoro_sessions.updated_at
  RETURNING true;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- (e) Re-GRANT EXECUTE on the new function signature (0005 (f) parity)
--     The lww_soft_delete_pomodoro_sessions function signature is unchanged
--     (takes only p_id, p_updated_at) — its GRANT from 0004 still holds.
-- ───────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION
  lww_upsert_pomodoro_sessions(uuid, timestamptz, integer, text[], uuid, integer[], timestamptz, timestamptz)
  TO anon, authenticated;
