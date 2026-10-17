-- 0000_base_schema.sql — Phase 5 / Plan 05-01 (local-stack reproducibility)
--
-- Why this exists: the 4 base tables (habits, habit_completions,
-- journal_entries, long_term_tasks) were originally created out-of-band in the
-- live Supabase project's dashboard, BEFORE any migration. 0001 only ALTERs
-- them (adds sync columns + the BEFORE UPDATE server-clock trigger); 0002 adds
-- the LWW RPCs + RLS. Neither creates the tables. On a fresh local Postgres
-- (`supabase db reset`) there is therefore nothing for 0001 to alter and the
-- reset fails with `relation "habits" does not exist`.
--
-- This migration captures the pre-0001 base schema so the DISPOSABLE LOCAL
-- stack (D-04) is reproducible. Columns/types/keys are derived from the
-- authoritative app contract `lib/types.ts` (cross-checked against the Dexie
-- schema in `lib/local-db.ts`): only the entity-specific + created_at columns
-- are here — updated_at / deleted_at / last_rollover_date are 0001's additions
-- and are intentionally NOT defined here.
--
-- Every statement is `IF NOT EXISTS`-guarded, so this is idempotent AND a
-- pure no-op anywhere the tables already exist (i.e. the live project) — it
-- can never re-shape or clobber existing data. It runs first only because it
-- sorts before 0001 lexicographically; on the live project (which already has
-- these tables, and which D-04 forbids touching anyway) it would do nothing.

CREATE TABLE IF NOT EXISTS habits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text    NOT NULL,
  short_name  text    NOT NULL,
  sort_order  integer NOT NULL
);

CREATE TABLE IF NOT EXISTS habit_completions (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_id  uuid NOT NULL,
  date      date NOT NULL,
  note      text
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date     date NOT NULL,
  content  text NOT NULL
);

CREATE TABLE IF NOT EXISTS long_term_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  category      text        NOT NULL,
  parent_id     uuid,
  is_for_today  boolean     NOT NULL DEFAULT false,
  delay_days    integer     NOT NULL DEFAULT 0,
  completed     boolean     NOT NULL DEFAULT false,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
