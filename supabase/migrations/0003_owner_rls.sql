-- 0003_owner_rls.sql — Phase 7 / Plan 07-01
--
-- Purpose: replace the interim open-anon RLS policies from 0002 with
-- table-level single-owner auth.uid() policies (D-13/SYNC-06 Phase-5 deferral).
--
-- RLS form: table-level, no column, no backfill (D-13). The owner uid is NOT a
-- secret (the password is); it is embedded as a literal in the policy for
-- auditability and to avoid env-substitution misconfiguration (Pitfall 5).
--
-- OWNER UID: replace <owner_uid> with the literal UUID from
--   Supabase Dashboard → Authentication → Users (ID column)
--   before applying. Verify no typos — the policy literal must match exactly.
--
-- Idempotency: DROP POLICY IF EXISTS + CREATE follows the 0001/0002 convention.
-- Reversibility (D-14): see the commented rollback block at the end of this file.
--   Un-comment and run it to restore the Phase-5 open-anon posture with zero data loss.
--
-- Scope: policies and GRANT statements ONLY. Does NOT touch columns, triggers,
-- UNIQUE constraints, or RPC bodies — those remain 0001/0002 responsibility.
--
-- Apply to LOCAL stack only (D-15): run `supabase db reset` to test.
--   NEVER `supabase db push` to the live project until the D-15 runbook
--   pre-flight checklist is complete (see 07-CUTOVER.md).

-- ───────────────────────────────────────────────────────────────────────────
-- Forward: drop open-anon policies (0002), create single-owner authenticated
-- policies on all four entity tables.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['habits','habit_completions','long_term_tasks','journal_entries']
  LOOP
    -- Drop 0002's open-anon policies (idempotent).
    EXECUTE format('DROP POLICY IF EXISTS anon_all_%1$s ON %1$s', t);
    -- Create single-owner policy: only the owner's JWT auth.uid() can read/write.
    EXECUTE format(
      $sql$CREATE POLICY owner_%1$s ON %1$s
        FOR ALL TO authenticated
        USING (auth.uid() = 'a841376e-cf5d-4df6-aa3e-246da66c62cf'::uuid)
        WITH CHECK (auth.uid() = 'a841376e-cf5d-4df6-aa3e-246da66c62cf'::uuid)$sql$,
      t
    );
  END LOOP;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Grant EXECUTE on LWW guard RPCs to the authenticated role.
-- (0002 granted anon only; the auth client uses the authenticated Postgres role.)
-- ───────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION
  lww_upsert_habits(uuid,text,text,int,timestamptz,timestamptz),
  lww_upsert_habit_completions(uuid,uuid,date,text,timestamptz,timestamptz),
  lww_upsert_journal_entries(uuid,date,text,timestamptz,timestamptz),
  lww_upsert_long_term_tasks(uuid,text,text,uuid,boolean,int,boolean,timestamptz,timestamptz,date,timestamptz,timestamptz),
  lww_soft_delete_habits(uuid,timestamptz),
  lww_soft_delete_habit_completions(uuid,timestamptz),
  lww_soft_delete_journal_entries(uuid,timestamptz),
  lww_soft_delete_long_term_tasks(uuid,timestamptz)
  TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- D-14 ROLLBACK (keep commented — un-comment and run ONE block to restore the
-- Phase-5 open-anon posture with zero data loss on anomaly).
-- ───────────────────────────────────────────────────────────────────────────
-- DO $$
-- DECLARE t text;
-- BEGIN
--   FOREACH t IN ARRAY ARRAY['habits','habit_completions','long_term_tasks','journal_entries']
--   LOOP
--     EXECUTE format('DROP POLICY IF EXISTS owner_%1$s ON %1$s', t);
--     EXECUTE format(
--       'CREATE POLICY anon_all_%1$s ON %1$s FOR ALL TO anon USING (true) WITH CHECK (true)', t
--     );
--   END LOOP;
-- END $$;
