-- 0002_lww_guard_and_rls.sql — Phase 5 / Plan 05-01
--
-- Purpose: add the server-authoritative half of the remote sync side on top
-- of 0001. This migration is ADDITIVE on 0001 and must NOT re-add 0001's sync
-- columns or its BEFORE UPDATE server-clock trigger — those remain 0001's and
-- are the sole owner of the persisted server-clock value.
--
-- It adds, idempotently:
--   (a) the natural-key UNIQUE constraints that ON CONFLICT requires
--       (habit_completions(habit_id,date), journal_entries(date)),
--   (b) atomic, server-authoritative LWW upsert + soft-delete RPCs — one
--       INSERT ... ON CONFLICT ... DO UPDATE ... WHERE p_updated_at > stored
--       statement per entity. Postgres locks the conflict row BEFORE the WHERE
--       predicate is evaluated, so there is no check-then-write (TOCTOU)
--       window: a stale or equal-timestamp write is an atomic silent no-op.
--   (c) interim OPEN anon RLS on the 4 tables so the anon-key write path
--       functions.
--
-- LWW guard semantics: strict `>` only. p_updated_at is the guard KEY ONLY —
-- it is used solely in the WHERE predicate and is NEVER inserted or assigned.
-- On INSERT, updated_at falls to 0001's column DEFAULT now(); on UPDATE,
-- 0001's BEFORE UPDATE trigger set_updated_at() restamps it to the server
-- clock. An equal-timestamp replay is therefore a silent no-op — this is the
-- server-side rollover-replay idempotency primitive (DATA-04), a property of
-- the upsert+guard path, not a remote rolloverTasks method.
--
-- RLS posture: the open anon policies below are a DELIBERATE, ACCEPTED interim
-- tradeoff (D-07) for a strictly-single-user, not-yet-shipped project. They
-- are tightened to single-user identity scoping in Phase 7 (SYNC-06). Do not
-- treat the open policy as the final posture.
--
-- Data-safety: this migration is applied ONLY to the disposable LOCAL stack
-- via `supabase db reset` (D-04). It is never applied to the live project.
--
-- This file is idempotent / re-runnable: every statement is guarded
-- (pg_constraint catalog check / CREATE OR REPLACE / DROP POLICY IF EXISTS
-- then CREATE), mirroring 0001's discipline.

-- ───────────────────────────────────────────────────────────────────────────
-- (a) Natural-key UNIQUE constraints (no-op if already present).
--     Postgres has no ADD CONSTRAINT IF NOT EXISTS; guard via catalog check.
-- ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'habit_completions_habit_date_key') THEN
    ALTER TABLE habit_completions ADD CONSTRAINT habit_completions_habit_date_key UNIQUE (habit_id, date);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_date_key') THEN
    ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_date_key UNIQUE (date);
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- (b) Atomic LWW guarded upsert + soft-delete RPCs (one statement each).
--     The conflict row is locked before the WHERE predicate is evaluated
--     against the pre-this-statement stored row => no TOCTOU window. A failed
--     WHERE returns no row (silent no-op), not an error.
--     Conflict targets: habit_completions (habit_id,date) | journal_entries
--     (date) | habits (id) | long_term_tasks (id). For the natural-key tables
--     the UPDATE branch adopts EXCLUDED.id (the incoming sync id) onto the
--     stable natural-key row.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION lww_upsert_habits(
  p_id uuid, p_name text, p_short_name text, p_sort_order int,
  p_updated_at timestamptz, p_deleted_at timestamptz
) RETURNS boolean              -- true = applied, NULL (no row) = rejected stale/equal
LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO habits (id, name, short_name, sort_order, deleted_at)
  VALUES (p_id, p_name, p_short_name, p_sort_order, p_deleted_at)
  ON CONFLICT (id) DO UPDATE
     SET name       = EXCLUDED.name,
         short_name = EXCLUDED.short_name,
         sort_order = EXCLUDED.sort_order,
         deleted_at = EXCLUDED.deleted_at
   WHERE p_updated_at > habits.updated_at
  RETURNING true;
$$;

CREATE OR REPLACE FUNCTION lww_upsert_habit_completions(
  p_id uuid, p_habit_id uuid, p_date date, p_note text,
  p_updated_at timestamptz, p_deleted_at timestamptz
) RETURNS boolean
LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO habit_completions (id, habit_id, date, note, deleted_at)
  VALUES (p_id, p_habit_id, p_date, p_note, p_deleted_at)
  ON CONFLICT (habit_id, date) DO UPDATE
     SET id         = EXCLUDED.id,
         note       = EXCLUDED.note,
         deleted_at = EXCLUDED.deleted_at
   WHERE p_updated_at > habit_completions.updated_at
  RETURNING true;
$$;

CREATE OR REPLACE FUNCTION lww_upsert_journal_entries(
  p_id uuid, p_date date, p_content text,
  p_updated_at timestamptz, p_deleted_at timestamptz
) RETURNS boolean
LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO journal_entries (id, date, content, deleted_at)
  VALUES (p_id, p_date, p_content, p_deleted_at)
  ON CONFLICT (date) DO UPDATE
     SET id         = EXCLUDED.id,
         content    = EXCLUDED.content,
         deleted_at = EXCLUDED.deleted_at
   WHERE p_updated_at > journal_entries.updated_at
  RETURNING true;
$$;

CREATE OR REPLACE FUNCTION lww_upsert_long_term_tasks(
  p_id uuid, p_name text, p_category text, p_parent_id uuid,
  p_is_for_today boolean, p_delay_days int, p_completed boolean,
  p_completed_at timestamptz, p_created_at timestamptz,
  p_last_rollover_date date,
  p_updated_at timestamptz, p_deleted_at timestamptz
) RETURNS boolean
LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO long_term_tasks (
    id, name, category, parent_id, is_for_today, delay_days, completed,
    completed_at, created_at, last_rollover_date, deleted_at
  )
  VALUES (
    p_id, p_name, p_category, p_parent_id, p_is_for_today, p_delay_days,
    p_completed, p_completed_at, p_created_at, p_last_rollover_date,
    p_deleted_at
  )
  ON CONFLICT (id) DO UPDATE
     SET name               = EXCLUDED.name,
         category           = EXCLUDED.category,
         parent_id          = EXCLUDED.parent_id,
         is_for_today       = EXCLUDED.is_for_today,
         delay_days         = EXCLUDED.delay_days,
         completed          = EXCLUDED.completed,
         completed_at       = EXCLUDED.completed_at,
         created_at         = EXCLUDED.created_at,
         last_rollover_date = EXCLUDED.last_rollover_date,
         deleted_at         = EXCLUDED.deleted_at
   WHERE p_updated_at > long_term_tasks.updated_at
  RETURNING true;
$$;

-- soft-delete = the SAME LWW guard, no tombstone special-case. deleted_at is
-- set to now(); 0001's BEFORE UPDATE trigger restamps the persisted
-- server-clock value. WHERE leads with the strict-`>` guard predicate.
CREATE OR REPLACE FUNCTION lww_soft_delete_habits(
  p_id uuid, p_updated_at timestamptz
) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE habits
     SET deleted_at = now()
   WHERE p_updated_at > habits.updated_at
     AND id = p_id
  RETURNING true;
$$;

CREATE OR REPLACE FUNCTION lww_soft_delete_habit_completions(
  p_id uuid, p_updated_at timestamptz
) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE habit_completions
     SET deleted_at = now()
   WHERE p_updated_at > habit_completions.updated_at
     AND id = p_id
  RETURNING true;
$$;

CREATE OR REPLACE FUNCTION lww_soft_delete_journal_entries(
  p_id uuid, p_updated_at timestamptz
) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE journal_entries
     SET deleted_at = now()
   WHERE p_updated_at > journal_entries.updated_at
     AND id = p_id
  RETURNING true;
$$;

CREATE OR REPLACE FUNCTION lww_soft_delete_long_term_tasks(
  p_id uuid, p_updated_at timestamptz
) RETURNS boolean LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE long_term_tasks
     SET deleted_at = now()
   WHERE p_updated_at > long_term_tasks.updated_at
     AND id = p_id
  RETURNING true;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- (c) Interim OPEN anon RLS (D-07). Phase 7 (SYNC-06) replaces these with
--     single-user identity-scoped policies. DROP POLICY IF EXISTS + CREATE is
--     the idempotency convention (Postgres has no CREATE POLICY IF NOT EXISTS),
--     mirroring 0001's drop-then-create idiom for objects lacking an
--     IF NOT EXISTS form.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['habits','habit_completions','long_term_tasks','journal_entries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS anon_all_%1$s ON %1$s', t);
    EXECUTE format(
      'CREATE POLICY anon_all_%1$s ON %1$s FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  lww_upsert_habits(uuid,text,text,int,timestamptz,timestamptz),
  lww_upsert_habit_completions(uuid,uuid,date,text,timestamptz,timestamptz),
  lww_upsert_journal_entries(uuid,date,text,timestamptz,timestamptz),
  lww_upsert_long_term_tasks(uuid,text,text,uuid,boolean,int,boolean,timestamptz,timestamptz,date,timestamptz,timestamptz),
  lww_soft_delete_habits(uuid,timestamptz),
  lww_soft_delete_habit_completions(uuid,timestamptz),
  lww_soft_delete_journal_entries(uuid,timestamptz),
  lww_soft_delete_long_term_tasks(uuid,timestamptz)
  TO anon;
