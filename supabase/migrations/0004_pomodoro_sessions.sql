-- 0004_pomodoro_sessions.sql — Phase 10 / Plan 10-01
--
-- Purpose: Add the pomodoro_sessions entity to the Supabase remote stack.
--   * Base table + sync columns (mirrors 0000 + 0001 conventions)
--   * Server-clock BEFORE UPDATE trigger for updated_at (mirrors 0001)
--   * Indexes on started_at and updated_at
--   * RLS: BOTH interim open-anon (0002 parity) AND single-owner authenticated
--     (0003 parity) so the table is consistent with both postures
--   * LWW guard RPCs: lww_upsert_pomodoro_sessions, lww_soft_delete_pomodoro_sessions
--   * GRANT EXECUTE on the RPCs to the authenticated role
--
-- Idempotency: every statement is guarded (CREATE TABLE IF NOT EXISTS / DO $$
-- catalog check / CREATE OR REPLACE / DROP POLICY IF EXISTS then CREATE).
--
-- Apply to LOCAL stack only: `supabase db reset`. Live cutover follows the
-- D-15 runbook (deferred per Phase 7 decision).

-- ───────────────────────────────────────────────────────────────────────────
-- (a) Base table (mirrors 0000 style)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pomodoro_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL,
  duration_sec integer     NOT NULL,
  note         text,
  habit_id     uuid
);

-- ───────────────────────────────────────────────────────────────────────────
-- (b) Sync columns + server-clock trigger (mirrors 0001 set_updated_at idiom)
-- ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pomodoro_sessions' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE pomodoro_sessions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE pomodoro_sessions ADD COLUMN deleted_at timestamptz;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION set_pomodoro_sessions_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS set_pomodoro_sessions_updated_at ON pomodoro_sessions;
CREATE TRIGGER set_pomodoro_sessions_updated_at
  BEFORE UPDATE ON pomodoro_sessions
  FOR EACH ROW EXECUTE FUNCTION set_pomodoro_sessions_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- (c) Indexes (mirrors 0001 style)
-- ───────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ps_started_at ON pomodoro_sessions(started_at);
CREATE INDEX IF NOT EXISTS ps_updated_at ON pomodoro_sessions(updated_at);

-- ───────────────────────────────────────────────────────────────────────────
-- (d) RLS — BOTH 0002 open-anon AND 0003 single-owner-authenticated
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE pomodoro_sessions ENABLE ROW LEVEL SECURITY;

-- 0002 parity: interim open-anon policy
DROP POLICY IF EXISTS anon_all_pomodoro_sessions ON pomodoro_sessions;
CREATE POLICY anon_all_pomodoro_sessions ON pomodoro_sessions
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- 0003 parity: single-owner authenticated policy (literal owner UID)
DROP POLICY IF EXISTS owner_pomodoro_sessions ON pomodoro_sessions;
CREATE POLICY owner_pomodoro_sessions ON pomodoro_sessions
  FOR ALL TO authenticated
  USING (auth.uid() = 'a841376e-cf5d-4df6-aa3e-246da66c62cf'::uuid)
  WITH CHECK (auth.uid() = 'a841376e-cf5d-4df6-aa3e-246da66c62cf'::uuid);

-- ───────────────────────────────────────────────────────────────────────────
-- (e) LWW upsert RPC — mirrors 0002 lww_upsert_habits pattern
--     Strict `>` guard; p_updated_at is the guard KEY ONLY, never inserted
--     (0001 column DEFAULT now() + trigger own the persisted value).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lww_upsert_pomodoro_sessions(
  p_id           uuid,
  p_started_at   timestamptz,
  p_duration_sec integer,
  p_note         text,
  p_habit_id     uuid,
  p_updated_at   timestamptz,
  p_deleted_at   timestamptz
) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO pomodoro_sessions (id, started_at, duration_sec, note, habit_id, deleted_at)
  VALUES (p_id, p_started_at, p_duration_sec, p_note, p_habit_id, p_deleted_at)
  ON CONFLICT (id) DO UPDATE
     SET started_at   = EXCLUDED.started_at,
         duration_sec = EXCLUDED.duration_sec,
         note         = EXCLUDED.note,
         habit_id     = EXCLUDED.habit_id,
         deleted_at   = EXCLUDED.deleted_at
   WHERE p_updated_at > pomodoro_sessions.updated_at
  RETURNING true;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- (f) LWW soft-delete RPC — mirrors 0002 lww_soft_delete_habits pattern
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lww_soft_delete_pomodoro_sessions(
  p_id uuid, p_updated_at timestamptz
) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE pomodoro_sessions
     SET deleted_at = now()
   WHERE p_updated_at > pomodoro_sessions.updated_at
     AND id = p_id
  RETURNING true;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- (g) GRANT EXECUTE — both anon (0002 parity) AND authenticated (0003 parity)
-- ───────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION
  lww_upsert_pomodoro_sessions(uuid, timestamptz, integer, text, uuid, timestamptz, timestamptz),
  lww_soft_delete_pomodoro_sessions(uuid, timestamptz)
  TO anon, authenticated;
