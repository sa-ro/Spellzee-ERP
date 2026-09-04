-- 0009_employee_teacher.sql
-- Employee (DD §29 Phase 1 subset) and Teacher master profile (DD §11).
--
-- SCOPE NOTE: `employee` was listed in CLAUDE.md §5 Phase 1 scope and specified in
-- docs/data-model/02-entity-specifications.md but not built in the first batch.
-- It is a genuine prerequisite here: coordinator_ownership.employee_id (DD §14) is
-- mandatory, and teacher.employee_id (DD §11) needs a real FK target. Built to the
-- Phase 1 subset already documented -- no HR fields beyond what that spec lists.
--
-- Teacher training/certification/observation/incentive sub-entities (DD §26-28) are
-- explicitly OUT of scope here (Phase 3) -- only the master profile fields.

BEGIN;

-- ---------------------------------------------------------------------------
-- employee -- DD §29 (Phase 1 subset)
-- ---------------------------------------------------------------------------
CREATE TABLE employee (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id           text NOT NULL UNIQUE DEFAULT next_public_id('EMP'),

  full_name           text NOT NULL,
  department          text NOT NULL,
  role_title          text NOT NULL,
  joining_date        date NOT NULL,
  employment_status   text NOT NULL DEFAULT 'active',
  manager_employee_id uuid REFERENCES employee(id),

  -- Links this HR record to a login identity. Nullable and unique: not every
  -- employee has system access (e.g. a teacher who never logs into the ERP),
  -- and a login is never shared by two employees.
  user_account_id     uuid REFERENCES user_account(id),

  exit_date           date,
  exit_reason         text,

  archived_at         timestamptz,
  archived_by         uuid REFERENCES user_account(id),
  archive_reason      text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES user_account(id),
  updated_by          uuid NOT NULL REFERENCES user_account(id),
  source               text NOT NULL DEFAULT 'ui',

  CONSTRAINT employee_public_id_format CHECK (public_id ~ '^EMP-\d{4}-\d{6}$'),
  CONSTRAINT employee_status_valid CHECK (
    employment_status IN ('onboarding','active','inactive','exited','archived')
  ),
  CONSTRAINT employee_not_own_manager CHECK (manager_employee_id IS NULL OR manager_employee_id <> id),
  CONSTRAINT employee_exit_complete CHECK (
    (employment_status <> 'exited' AND exit_date IS NULL)
    OR (employment_status = 'exited' AND exit_date IS NOT NULL)
  ),
  CONSTRAINT employee_archive_complete CHECK (
    (employment_status <> 'archived' AND archived_at IS NULL)
    OR (employment_status = 'archived' AND archived_at IS NOT NULL
        AND archived_by IS NOT NULL AND archive_reason IS NOT NULL)
  )
);

COMMENT ON TABLE employee IS
  'Phase 1 subset of DD §29. Documents, training records, leave records and payroll '
  'reference are Phase 3 (CLAUDE.md §7) -- not added here.';

CREATE UNIQUE INDEX employee_user_account_uq ON employee (user_account_id) WHERE user_account_id IS NOT NULL;
CREATE INDEX employee_manager_idx ON employee (manager_employee_id) WHERE manager_employee_id IS NOT NULL;
CREATE INDEX employee_status_idx ON employee (employment_status);

-- ---------------------------------------------------------------------------
-- teacher -- DD §11 (Phase 1 subset: master profile only)
-- ---------------------------------------------------------------------------
CREATE TABLE teacher (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id                   text NOT NULL UNIQUE DEFAULT next_public_id('TCH'),

  -- Nullable: contractors are teachers without an HR employee record
  -- (CLAUDE.md accepted default).
  employee_id                 uuid REFERENCES employee(id),

  full_name                   text NOT NULL,

  qualifications               jsonb,
  experience                   jsonb,
  specializations               jsonb,

  employment_status           text NOT NULL DEFAULT 'onboarding',

  -- Rule 25 (DD §43): a teacher must not be allocated unless mandatory
  -- onboarding/certification rules are satisfied. In Phase 1, with no training
  -- module yet, this is a manually-set flag requiring an explicit reason; in
  -- Phase 3 it becomes derived from certification records (CLAUDE.md, doc 02).
  is_allocation_eligible       boolean NOT NULL DEFAULT false,
  allocation_eligibility_reason text,

  archived_at                 timestamptz,
  archived_by                 uuid REFERENCES user_account(id),
  archive_reason               text,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid NOT NULL REFERENCES user_account(id),
  updated_by                  uuid NOT NULL REFERENCES user_account(id),
  source                      text NOT NULL DEFAULT 'ui',

  CONSTRAINT teacher_public_id_format CHECK (public_id ~ '^TCH-\d{4}-\d{6}$'),
  CONSTRAINT teacher_status_valid CHECK (
    employment_status IN ('onboarding','active','inactive','exited','archived')
  ),
  -- Forces an explicit justification while the training module does not exist.
  CONSTRAINT teacher_eligibility_reason_required CHECK (
    NOT is_allocation_eligible OR allocation_eligibility_reason IS NOT NULL
  ),
  CONSTRAINT teacher_archive_complete CHECK (
    (employment_status <> 'archived' AND archived_at IS NULL)
    OR (employment_status = 'archived' AND archived_at IS NOT NULL
        AND archived_by IS NOT NULL AND archive_reason IS NOT NULL)
  )
);

COMMENT ON TABLE teacher IS
  'Teacher master profile only (DD §11 Phase 1 subset). Training/certification, '
  'observation/quality and incentive sub-entities (DD §26-28) are Phase 3.';
COMMENT ON COLUMN teacher.is_allocation_eligible IS
  'Rule 25: a teacher must not be allocated if mandatory onboarding/certification '
  'rules are not satisfied. Enforced at allocation time by trg_teacher_allocation_eligible '
  '(0012_teacher_allocation.sql).';

CREATE INDEX teacher_employee_idx ON teacher (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX teacher_status_idx ON teacher (employment_status);
CREATE INDEX teacher_eligible_idx ON teacher (is_allocation_eligible) WHERE is_allocation_eligible;

-- ---------------------------------------------------------------------------
-- Capability tables -- DD §11 "Subjects/Levels/Languages: Many-to-many"
--
-- Simpler than the historical entities above: these are current capability tags,
-- not transactional records. Correcting a mistaken tag is an ordinary DELETE
-- (still audited by trigger, so the change remains attributable per rule 21) --
-- rule 13's "never delete critical records" is about business/financial/identity
-- history, not a capability checkbox. Documented here as a deliberate distinction.
-- ---------------------------------------------------------------------------
CREATE TABLE teacher_subject (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid NOT NULL REFERENCES teacher(id),
  subject_id  uuid NOT NULL REFERENCES subject(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES user_account(id),
  updated_by  uuid NOT NULL REFERENCES user_account(id),
  source      text NOT NULL DEFAULT 'ui',
  CONSTRAINT teacher_subject_uq UNIQUE (teacher_id, subject_id)
);

CREATE TABLE teacher_level (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid NOT NULL REFERENCES teacher(id),
  level_id    uuid NOT NULL REFERENCES level(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL REFERENCES user_account(id),
  updated_by  uuid NOT NULL REFERENCES user_account(id),
  source      text NOT NULL DEFAULT 'ui',
  CONSTRAINT teacher_level_uq UNIQUE (teacher_id, level_id)
);

CREATE TABLE teacher_language (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id        uuid NOT NULL REFERENCES teacher(id),
  language_id       uuid NOT NULL REFERENCES language(id),
  proficiency       text NOT NULL DEFAULT 'fluent',
  -- Represents bilingual teaching capability such as Tamil-English or
  -- Hindi-English (Master §13.1). A teacher may hold two teacher_language rows
  -- flagged is_bilingual_pair=true to record which pair they teach in combination.
  is_bilingual_pair boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES user_account(id),
  updated_by        uuid NOT NULL REFERENCES user_account(id),
  source            text NOT NULL DEFAULT 'ui',
  CONSTRAINT teacher_language_uq UNIQUE (teacher_id, language_id),
  CONSTRAINT teacher_language_proficiency_valid CHECK (
    proficiency IN ('native','fluent','conversational','basic')
  )
);

CREATE INDEX teacher_subject_lookup_idx ON teacher_subject (subject_id, teacher_id);
CREATE INDEX teacher_level_lookup_idx ON teacher_level (level_id, teacher_id);
CREATE INDEX teacher_language_lookup_idx ON teacher_language (language_id, teacher_id);

COMMIT;
