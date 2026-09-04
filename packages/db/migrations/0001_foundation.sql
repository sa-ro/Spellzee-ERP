-- 0001_foundation.sql
-- Extensions, schemas, roles and the actor-context mechanism.
--
-- Source: DD §2 (global data architecture principles), DD §41 (audit event),
--         CLAUDE.md §5 (four-layer history model).
--
-- Forward-only. Never edit after merge.

BEGIN;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints (scheduling, Phase 1b)
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy name matching for duplicate detection (DD §7)
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS audit;

COMMENT ON SCHEMA audit IS
  'Tamper-evident audit log. The application role has SELECT only; all writes '
  'arrive via SECURITY DEFINER triggers. DD §41.';

-- ---------------------------------------------------------------------------
-- Roles
--
-- spellzee_owner : owns objects, runs migrations, owns SECURITY DEFINER functions.
-- spellzee_app   : the application connects as this. Deliberately cannot DELETE
--                  business records (rule 13) nor write audit rows directly (rule 23).
--
-- Passwords are set out-of-band; these are NOLOGIN role shells so the migration
-- is safe to run in every environment.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spellzee_owner') THEN
    CREATE ROLE spellzee_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spellzee_app') THEN
    CREATE ROLE spellzee_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, audit TO spellzee_app;

-- Ownership must be pinned explicitly rather than left to whichever role happens
-- to run the migration. audit.record_change() is SECURITY DEFINER and owned by
-- spellzee_owner (0002); if the audit schema/table ended up owned by a different
-- role (e.g. a superuser bootstrapping the database), the trigger would lack
-- INSERT rights on its own table and every audited write would fail. Pinning
-- ownership here makes the migration produce the same privilege graph regardless
-- of which role applies it.
ALTER SCHEMA audit OWNER TO spellzee_owner;


-- ---------------------------------------------------------------------------
-- Actor context
--
-- The audit trigger cannot know who the user is. The application sets these
-- per transaction (SET LOCAL) and the trigger reads them back. A write with no
-- actor RAISES -- see audit.record_change() in 0002.
--
-- Settings used:
--   app.actor_id        uuid   -- user_account.id (or a service account)
--   app.session_id      uuid   -- user_session.id, nullable for jobs/webhooks
--   app.correlation_id  text   -- request / job / webhook id
--   app.source          text   -- ui | api | webhook:<system> | job | migration
--   app.reason          text   -- optional free text for the change
--   app.ip / app.user_agent
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_setting(p_key text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting(p_key, true), '');
$$;

COMMENT ON FUNCTION app_setting(text) IS
  'Reads a per-transaction app.* setting, returning NULL rather than raising when unset.';

CREATE OR REPLACE FUNCTION app_actor_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v uuid;
BEGIN
  BEGIN
    v := app_setting('app.actor_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'app.actor_id is set but is not a valid uuid: %',
      app_setting('app.actor_id')
      USING ERRCODE = '22P02';
  END;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION app_require_actor(p_table text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v uuid := app_actor_id();
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION
      'Refusing to write % : app.actor_id is not set. Every write must be attributable (DD §41).',
      p_table
      USING ERRCODE = 'raise_exception',
            HINT = 'Wrap the transaction in withActor() / SET LOCAL app.actor_id.';
  END IF;
  RETURN v;
END;
$$;

-- ---------------------------------------------------------------------------
-- Identifier sequences -- DD §4
--
-- Format PREFIX-YYYY-NNNNNN, e.g. STU-2026-000184. Sequence restarts per year
-- per prefix. A table (rather than a Postgres sequence) is used because the
-- counter must reset annually and be visible/auditable.
-- ---------------------------------------------------------------------------
CREATE TABLE identifier_sequence (
  prefix      text    NOT NULL,
  year        integer NOT NULL,
  last_value  bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year),
  CONSTRAINT identifier_sequence_prefix_format CHECK (prefix ~ '^[A-Z]{3}$'),
  CONSTRAINT identifier_sequence_year_range    CHECK (year BETWEEN 2000 AND 2999)
);

COMMENT ON TABLE identifier_sequence IS
  'Per-prefix, per-year counters backing next_public_id(). DD §4.';

-- Pinned to spellzee_owner: next_public_id() is called both directly by the
-- inserting role (e.g. spellzee_app, granted via 0008) and, for AUD- ids,
-- from inside the SECURITY DEFINER audit trigger (0002), which executes with
-- spellzee_owner's privileges regardless of who applied this migration. Without
-- this, the trigger's own INSERT into identifier_sequence would fail whenever
-- migrations are run by a different bootstrapping role (see the note in the
-- schema-ownership section above).
ALTER TABLE identifier_sequence OWNER TO spellzee_owner;
GRANT SELECT, INSERT, UPDATE ON identifier_sequence TO spellzee_app;

CREATE OR REPLACE FUNCTION next_public_id(p_prefix text, p_at timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_year  integer := extract(year FROM (p_at AT TIME ZONE 'UTC'))::integer;
  v_value bigint;
BEGIN
  INSERT INTO identifier_sequence (prefix, year, last_value)
  VALUES (p_prefix, v_year, 1)
  ON CONFLICT (prefix, year)
  DO UPDATE SET last_value = identifier_sequence.last_value + 1
  RETURNING last_value INTO v_value;

  IF v_value > 999999 THEN
    RAISE EXCEPTION 'Identifier space exhausted for %-% (max 999999).', p_prefix, v_year;
  END IF;

  RETURN p_prefix || '-' || v_year::text || '-' || lpad(v_value::text, 6, '0');
END;
$$;

COMMENT ON FUNCTION next_public_id(text, timestamptz) IS
  'Allocates the next business identifier for a prefix, e.g. STU-2026-000184. DD §4.';

-- ---------------------------------------------------------------------------
-- Shared guard triggers
-- ---------------------------------------------------------------------------

-- Rule 1 / DD §6.3 -- a business identifier is immutable for the life of the record.
CREATE OR REPLACE FUNCTION guard_immutable_public_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN
    RAISE EXCEPTION
      'public_id is immutable on % (attempted % -> %). A permanent identity never changes (DD §6.3).',
      TG_TABLE_NAME, OLD.public_id, NEW.public_id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

-- Rule 13 / DD §2 / Master §22.6 -- critical records are archived, never deleted.
-- REVOKE alone does not stop the owner or a superuser; this makes the intent explicit
-- and the failure legible.
CREATE OR REPLACE FUNCTION guard_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% records cannot be deleted. Archive instead (set status/archived_at with a reason). DD §2, Master §22.6.',
    TG_TABLE_NAME
    USING ERRCODE = 'raise_exception',
          HINT = 'Use the archive_* helper or set status to an archived state.';
END;
$$;

-- Layers 3 -- append-only tables reject UPDATE and DELETE outright (DD §10, §41).
CREATE OR REPLACE FUNCTION guard_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; % is not permitted. Corrections must be new compensating entries (DD §10).',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

-- Maintains updated_at without the application having to remember.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := coalesce(app_actor_id(), NEW.updated_by);
  RETURN NEW;
END;
$$;

COMMIT;
