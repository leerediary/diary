-- 0005_pomodoro_notes_array.sql — Phase 11 / Plan 11-01
--
-- Purpose: Migrate pomodoro_sessions.note (text) → notes (text[]).
--   * Add notes text[] NOT NULL DEFAULT '{}'::text[]
--   * Backfill notes = ARRAY[note] WHERE note IS NOT NULL AND note <> ''
--   * Drop note column
--   * Drop the old lww_upsert_pomodoro_sessions function (p_note text signature)
--   * Recreate lww_upsert_pomodoro_sessions with p_notes text[] signature
--   * Re-GRANT EXECUTE on the new function to anon, authenticated
--
-- Idempotency:
--   * IF NOT EXISTS / IF EXISTS guards where Postgres permits
--   * ALTER COLUMN/DROP COLUMN are NOT natively idempotent; the DO $$ block
--     wraps them in catalog checks
--
-- Apply to LOCAL stack: `supabase db reset`. Live cutover follows D-15 runbook.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- (a) Add notes column (idempotent via catalog check)
-- ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pomodoro_sessions' AND column_name = 'notes'
  ) THEN
    ALTER TABLE pomodoro_sessions
      ADD COLUMN notes text[] NOT NULL DEFAULT '{}'::text[];
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- (b) Backfill from note (only rows where note is non-empty AND notes is still empty)
-- ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pomodoro_sessions' AND column_name = 'note'
  ) THEN
    UPDATE pomodoro_sessions
       SET notes = ARRAY[note]
     WHERE note IS NOT NULL
       AND note <> ''
       AND notes = '{}'::text[];
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- (c) Drop old note column (idempotent via IF EXISTS)
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE pomodoro_sessions DROP COLUMN IF EXISTS note;

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────
-- (d) Drop the old LWW upsert RPC (p_note text signature)
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
          'p_id uuid, p_started_at timestamp with time zone, p_duration_sec integer, p_note text, p_habit_id uuid, p_updated_at timestamp with time zone, p_deleted_at timestamp with time zone'
  ) THEN
    DROP FUNCTION public.lww_upsert_pomodoro_sessions(
      uuid, timestamptz, integer, text, uuid, timestamptz, timestamptz
    );
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- (e) Recreate the LWW upsert RPC with p_notes text[] signature
--     Mirrors 0004 (e) structure: strict `>` guard, p_updated_at is the guard
--     KEY only (0001 column DEFAULT + trigger own the persisted updated_at).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lww_upsert_pomodoro_sessions(
  p_id           uuid,
  p_started_at   timestamptz,
  p_duration_sec integer,
  p_notes        text[],
  p_habit_id     uuid,
  p_updated_at   timestamptz,
  p_deleted_at   timestamptz
) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO pomodoro_sessions (id, started_at, duration_sec, notes, habit_id, deleted_at)
  VALUES (p_id, p_started_at, p_duration_sec, p_notes, p_habit_id, p_deleted_at)
  ON CONFLICT (id) DO UPDATE
     SET started_at   = EXCLUDED.started_at,
         duration_sec = EXCLUDED.duration_sec,
         notes        = EXCLUDED.notes,
         habit_id     = EXCLUDED.habit_id,
         deleted_at   = EXCLUDED.deleted_at
   WHERE p_updated_at > pomodoro_sessions.updated_at
  RETURNING true;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- (f) Re-GRANT EXECUTE on the new function signature (0004 (g) parity)
--     The lww_soft_delete_pomodoro_sessions function signature is unchanged
--     (takes only p_id, p_updated_at) — its GRANT from 0004 still holds.
-- ───────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION
  lww_upsert_pomodoro_sessions(uuid, timestamptz, integer, text[], uuid, timestamptz, timestamptz)
  TO anon, authenticated;
