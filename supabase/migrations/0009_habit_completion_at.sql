-- Phase 17.1 D-05 / D-06: Add client-authoritative completed_at column.
-- D-05: completed_at is client-authoritative — the server trigger does NOT
--       touch this column. The RPC persists the client-supplied value directly.
-- D-06: Backfill existing rows with updated_at (best-effort approximation).

ALTER TABLE habit_completions ADD COLUMN completed_at timestamptz;

UPDATE habit_completions SET completed_at = updated_at WHERE completed_at IS NULL;

ALTER TABLE habit_completions ALTER COLUMN completed_at SET NOT NULL;

-- Replace the old 5-param RPC with a 6-param version that carries p_completed_at.
-- D-05: INSERT/UPDATE SET completed_at from EXCLUDED.completed_at (client value).
-- D-08: LWW guard unchanged — still p_updated_at > stored.updated_at.
-- D-12: p_completed_at sits between p_note and p_updated_at in the parameter list.

DROP FUNCTION IF EXISTS lww_upsert_habit_completions(uuid,uuid,date,text,timestamptz,timestamptz);

CREATE OR REPLACE FUNCTION lww_upsert_habit_completions(
  p_id uuid, p_habit_id uuid, p_date date, p_note text,
  p_completed_at timestamptz, p_updated_at timestamptz, p_deleted_at timestamptz
) RETURNS boolean
LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO habit_completions (id, habit_id, date, note, completed_at, deleted_at)
  VALUES (p_id, p_habit_id, p_date, p_note, p_completed_at, p_deleted_at)
  ON CONFLICT (habit_id, date) DO UPDATE
     SET id          = EXCLUDED.id,
         note        = EXCLUDED.note,
         completed_at = EXCLUDED.completed_at,
         deleted_at  = EXCLUDED.deleted_at
   WHERE p_updated_at > habit_completions.updated_at
  RETURNING true;
$$;

GRANT EXECUTE ON FUNCTION
  lww_upsert_habit_completions(uuid,uuid,date,text,timestamptz,timestamptz,timestamptz)
  TO authenticated;
