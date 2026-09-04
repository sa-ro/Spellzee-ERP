-- 0003_supporting_master_data.sql
-- Minimal dependencies required by the entities in scope. Nothing here is a
-- Phase 2+ entity; all are listed in CLAUDE.md §5 (Reference/Master Data and
-- Governance & Platform).
--
--   user_account  -- required: every table carries created_by/updated_by, and
--                    audit_event.actor_user_id must reference a real actor (DD §41).
--   language      -- required: student.preferred_language / learning_language (DD §6.1).
--   subject/level/course -- required: enrollment.course/subject/level (DD §8).
--
-- Deliberately minimal: only the columns the in-scope entities need. The full
-- specifications live in docs/data-model/02-entity-specifications.md and will be
-- completed when those entities are built in their own right.

BEGIN;

-- ---------------------------------------------------------------------------
-- user_account (minimal) -- CLAUDE.md §5 Governance & Platform
-- ---------------------------------------------------------------------------
CREATE TABLE user_account (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  full_name          text   NOT NULL,
  password_hash      text,                          -- Argon2id; NULL for service accounts
  is_service_account boolean NOT NULL DEFAULT false,
  status             text    NOT NULL DEFAULT 'active',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_account_status_valid CHECK (status IN ('active','suspended','disabled')),
  CONSTRAINT user_account_secret_present CHECK (is_service_account OR password_hash IS NOT NULL)
);

COMMENT ON TABLE user_account IS
  'Minimal actor identity. Full spec (sessions, TOTP, roles) arrives with the governance module.';

-- The migration actor. Every subsequent migration and every seed writes as this
-- account, so even bootstrap data is attributable (DD §41).
INSERT INTO user_account (id, email, full_name, is_service_account, status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'system@spellzee.internal',
  'Spellzee System',
  true,
  'active'
);

-- ---------------------------------------------------------------------------
-- Reference data -- CLAUDE.md §5 Reference/Master Data
-- ---------------------------------------------------------------------------
CREATE TABLE language (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subject (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE level (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     text NOT NULL UNIQUE,
  name                     text NOT NULL,
  subject_id               uuid NOT NULL REFERENCES subject(id),
  default_duration_minutes integer NOT NULL,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_duration_positive CHECK (default_duration_minutes > 0)
);

CREATE INDEX course_subject_idx ON course (subject_id);

COMMIT;
