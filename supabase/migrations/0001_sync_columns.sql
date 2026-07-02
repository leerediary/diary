-- 0001_sync_columns.sql — Phase 2 / Plan 02-01
--
-- Purpose: make the live Supabase schema sync-ready WITHOUT touching row data.
-- Adds, to habits / habit_completions / long_term_tasks / journal_entries:
--   * updated_at  timestamptz NOT NULL DEFAULT now()  — server-clock authority
--   * deleted_at  timestamptz NULL                     — soft-delete tombstone
-- and to long_term_tasks only:
--   * last_rollover_date date NULL                     — idempotent-rollover anchor
-- plus a BEFORE UPDATE trigger so the SERVER (not the device clock) stamps
-- updated_at on every real UPDATE.
--
-- journal_entries is included for DATA-02 schema parity only. It is empty by
-- design (journal starts fresh in diary-web — user decision 2026-05-18) and is
-- NOT pulled or verified in Phase 2.
--
-- NOTE — backfill semantics: `ADD COLUMN ... NOT NULL DEFAULT now()` atomically
-- backfills EVERY existing row to a single migration-epoch timestamp. That is
-- intended (it is the migration instant), not a bug — do not flag it during
-- verification.
--
-- This file is idempotent / re-runnable: every statement is guarded
-- (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS).

-- 1. Server-clock stamping function.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Sync-ready columns.
ALTER TABLE habits             ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE habits             ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

ALTER TABLE habit_completions  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE habit_completions  ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

ALTER TABLE long_term_tasks    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE long_term_tasks    ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

ALTER TABLE journal_entries    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE journal_entries    ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- 3. Idempotent-rollover anchor (long_term_tasks only).
ALTER TABLE long_term_tasks    ADD COLUMN IF NOT EXISTS last_rollover_date date DEFAULT NULL;

-- 4. Server-clock BEFORE UPDATE triggers (one per table).
DROP TRIGGER IF EXISTS trg_set_updated_at ON habits;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON habits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_set_updated_at ON habit_completions;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON habit_completions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_set_updated_at ON long_term_tasks;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON long_term_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_set_updated_at ON journal_entries;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
