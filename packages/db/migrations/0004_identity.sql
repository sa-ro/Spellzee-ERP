-- 0004_identity.sql
-- Parent/Guardian (DD §5), Student (DD §6), the relationship between them (DD §5),
-- and Contact & Identity History (DD §7).
--
-- Key decisions, all traceable:
--   * Phone/email are NOT columns on student or parent_guardian. They live in
--     contact_history with effective dates (DD §5 "may change; history retained",
--     DD §7, rule 5).
--   * student carries no current-teacher / current-schedule / attendance columns.
--     DD §6.2 lists those as links; they are views, not columns, or they drift.
--   * Normalised search columns exist solely to support duplicate detection (DD §7).

BEGIN;

-- ---------------------------------------------------------------------------
-- Normalisation helpers -- shared by the table columns and the matching service
-- so the database and the application can never disagree about what "the same
-- phone number" means.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION normalize_phone(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- Strip everything non-numeric, then keep the trailing 10 digits so that
  -- 9876543210, +91 98765 43210 and 0919876543210 all collapse to one value.
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    ELSE right(regexp_replace(p_value, '\D', '', 'g'), 10)
  END;
$$;

CREATE OR REPLACE FUNCTION normalize_email(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_value IS NULL THEN NULL ELSE lower(btrim(p_value)) END;
$$;

CREATE OR REPLACE FUNCTION normalize_name(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- Lowercase, strip punctuation, collapse whitespace. Deliberately does not
  -- attempt transliteration -- that belongs in the matching service where it can
  -- be tuned against real data.
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    ELSE btrim(regexp_replace(lower(regexp_replace(p_value, '[^\w\s]', ' ', 'g')), '\s+', ' ', 'g'))
  END;
$$;

-- ---------------------------------------------------------------------------
-- parent_guardian -- DD §5
-- ---------------------------------------------------------------------------
CREATE TABLE parent_guardian (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id                text NOT NULL UNIQUE DEFAULT next_public_id('PAR'),

  full_name                text NOT NULL,
  full_name_normalized     text GENERATED ALWAYS AS (normalize_name(full_name)) STORED,

  -- DD §5: address is structured text; address *history* is deferred
  -- (docs/data-model/05-open-modelling-questions.md A5).
  address_line1            text,
  address_line2            text,
  address_city             text,
  address_state            text,
  address_postal_code      text,
  address_country          text,

  preferred_language_id    uuid REFERENCES language(id),
  communication_preference text,
  notes                    text,

  status                   text NOT NULL DEFAULT 'active',

  -- Archive pattern (rule 13) -- never hard-deleted.
  archived_at              timestamptz,
  archived_by              uuid REFERENCES user_account(id),
  archive_reason           text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid NOT NULL REFERENCES user_account(id),
  updated_by               uuid NOT NULL REFERENCES user_account(id),
  source                   text NOT NULL DEFAULT 'ui',

  CONSTRAINT parent_guardian_public_id_format CHECK (public_id ~ '^PAR-\d{4}-\d{6}$'),
  CONSTRAINT parent_guardian_status_valid CHECK (status IN ('active','inactive','archived')),
  CONSTRAINT parent_guardian_comm_pref_valid CHECK (
    communication_preference IS NULL
    OR communication_preference IN ('whatsapp','in_app','email','phone')
  ),
  CONSTRAINT parent_guardian_archive_complete CHECK (
    (status <> 'archived' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL
        AND archived_by IS NOT NULL AND archive_reason IS NOT NULL)
  )
);

COMMENT ON TABLE parent_guardian IS
  'Adult responsible for one or more students. DD §5. Phone/email live in contact_history.';

CREATE INDEX parent_guardian_name_trgm_idx
  ON parent_guardian USING gin (full_name_normalized gin_trgm_ops);
CREATE INDEX parent_guardian_active_idx
  ON parent_guardian (status) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- student -- DD §6
-- ---------------------------------------------------------------------------
CREATE TABLE student (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id              text NOT NULL UNIQUE DEFAULT next_public_id('STU'),

  full_name              text NOT NULL,
  full_name_normalized   text GENERATED ALWAYS AS (normalize_name(full_name)) STORED,
  preferred_name         text,

  date_of_birth          date,
  gender                 text,

  preferred_language_id  uuid REFERENCES language(id),
  learning_language_id   uuid REFERENCES language(id),

  status                 text NOT NULL DEFAULT 'active',
  source_channel         text NOT NULL DEFAULT 'manual',

  -- Duplicate resolution (DD §6.3, §7). The source record is RETAINED on merge.
  merged_into_student_id uuid REFERENCES student(id),
  merged_at              timestamptz,

  archived_at            timestamptz,
  archived_by            uuid REFERENCES user_account(id),
  archive_reason         text,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL REFERENCES user_account(id),
  updated_by             uuid NOT NULL REFERENCES user_account(id),
  source                 text NOT NULL DEFAULT 'ui',

  CONSTRAINT student_public_id_format CHECK (public_id ~ '^STU-\d{4}-\d{6}$'),
  -- DD §6.1: Lead/Prospect is handled separately and is deliberately absent.
  CONSTRAINT student_status_valid CHECK (
    status IN ('active','break','completed','cancelled','inactive','merged','archived')
  ),
  CONSTRAINT student_gender_valid CHECK (
    gender IS NULL OR gender IN ('male','female','other','undisclosed')
  ),
  CONSTRAINT student_merge_consistent CHECK (
    (status = 'merged' AND merged_into_student_id IS NOT NULL AND merged_at IS NOT NULL)
    OR (status <> 'merged' AND merged_into_student_id IS NULL)
  ),
  CONSTRAINT student_not_merged_into_self CHECK (
    merged_into_student_id IS NULL OR merged_into_student_id <> id
  ),
  CONSTRAINT student_archive_complete CHECK (
    (status <> 'archived' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL
        AND archived_by IS NOT NULL AND archive_reason IS NOT NULL)
  ),
  CONSTRAINT student_dob_sane CHECK (date_of_birth IS NULL OR date_of_birth > '1900-01-01')
);

COMMENT ON TABLE student IS
  'Permanent student identity. DD §6. public_id is immutable for the life of the record '
  '(rule 1): a new phone, email, course, teacher, break or return never creates a new identity.';
COMMENT ON COLUMN student.merged_into_student_id IS
  'Set when this record was merged into another. The row is retained, never deleted (rule 4).';

CREATE INDEX student_name_trgm_idx  ON student USING gin (full_name_normalized gin_trgm_ops);
CREATE INDEX student_status_idx     ON student (status);
CREATE INDEX student_active_idx     ON student (status) WHERE status = 'active';
CREATE INDEX student_merged_idx     ON student (merged_into_student_id) WHERE merged_into_student_id IS NOT NULL;
CREATE INDEX student_dob_idx        ON student (date_of_birth) WHERE date_of_birth IS NOT NULL;

-- ---------------------------------------------------------------------------
-- student_parent_link -- DD §5
-- "The relationship itself should be a separate record if permissions, primary
--  contact or validity dates need to be stored."
-- ---------------------------------------------------------------------------
CREATE TABLE student_parent_link (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id          uuid NOT NULL REFERENCES student(id),
  parent_guardian_id  uuid NOT NULL REFERENCES parent_guardian(id),

  relationship_type   text NOT NULL,
  is_primary_contact  boolean NOT NULL DEFAULT false,
  may_receive_reports boolean NOT NULL DEFAULT true,
  may_request_changes boolean NOT NULL DEFAULT false,

  valid_from          timestamptz NOT NULL DEFAULT now(),
  valid_to            timestamptz,
  is_current          boolean NOT NULL DEFAULT true,
  change_reason       text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES user_account(id),
  updated_by          uuid NOT NULL REFERENCES user_account(id),
  source              text NOT NULL DEFAULT 'ui',

  CONSTRAINT student_parent_link_type_valid CHECK (
    relationship_type IN ('parent','guardian','grandparent','sibling','other')
  ),
  CONSTRAINT student_parent_link_period_sane CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT student_parent_link_current_open CHECK (
    (is_current AND valid_to IS NULL) OR (NOT is_current)
  )
);

COMMENT ON TABLE student_parent_link IS
  'Many-to-many student <-> guardian, carrying permissions and validity. DD §5.';

-- One student may have many guardians and one guardian many students, but only
-- one *current* link per pair, and exactly one primary contact per student.
CREATE UNIQUE INDEX student_parent_link_current_uq
  ON student_parent_link (student_id, parent_guardian_id) WHERE is_current;

CREATE UNIQUE INDEX student_parent_link_one_primary_uq
  ON student_parent_link (student_id) WHERE is_current AND is_primary_contact;

CREATE INDEX student_parent_link_parent_idx ON student_parent_link (parent_guardian_id) WHERE is_current;

-- ---------------------------------------------------------------------------
-- contact_history -- DD §7
-- Preserves historical phone/email/name so identity never depends on them.
-- ---------------------------------------------------------------------------
CREATE TABLE contact_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Exactly one owner. Two nullable FKs rather than a polymorphic pair, so
  -- referential integrity survives (docs/data-model 01, decision M2).
  student_id         uuid REFERENCES student(id),
  parent_guardian_id uuid REFERENCES parent_guardian(id),

  contact_type       text NOT NULL,
  value              text NOT NULL,
  value_normalized   text GENERATED ALWAYS AS (
    CASE contact_type
      WHEN 'phone'           THEN normalize_phone(value)
      WHEN 'alternate_phone' THEN normalize_phone(value)
      WHEN 'email'           THEN normalize_email(value)
      ELSE normalize_name(value)
    END
  ) STORED,

  effective_from     timestamptz NOT NULL DEFAULT now(),
  effective_to       timestamptz,
  is_primary         boolean NOT NULL DEFAULT false,
  is_verified        boolean NOT NULL DEFAULT false,
  verified_at        timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES user_account(id),
  updated_by         uuid NOT NULL REFERENCES user_account(id),
  source             text NOT NULL DEFAULT 'ui',

  CONSTRAINT contact_history_one_owner CHECK (
    (student_id IS NOT NULL)::int + (parent_guardian_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT contact_history_type_valid CHECK (
    contact_type IN ('phone','alternate_phone','email','name','address')
  ),
  CONSTRAINT contact_history_period_sane CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT contact_history_verified_consistent CHECK (
    (NOT is_verified) OR verified_at IS NOT NULL
  )
);

COMMENT ON TABLE contact_history IS
  'Historical and current contact values for students and guardians. DD §7. '
  'Contact detail is history, never identity (rule 5).';
COMMENT ON COLUMN contact_history.value_normalized IS
  'Search key for duplicate detection. Phones collapse to trailing 10 digits; emails lowercased.';

-- Duplicate detection reads this index constantly -- it is the hot path.
CREATE INDEX contact_history_normalized_idx
  ON contact_history (contact_type, value_normalized)
  WHERE effective_to IS NULL;

CREATE INDEX contact_history_normalized_all_idx
  ON contact_history (value_normalized);

CREATE INDEX contact_history_student_idx ON contact_history (student_id) WHERE student_id IS NOT NULL;
CREATE INDEX contact_history_parent_idx  ON contact_history (parent_guardian_id) WHERE parent_guardian_id IS NOT NULL;

-- At most one current primary value per owner per contact type.
CREATE UNIQUE INDEX contact_history_student_primary_uq
  ON contact_history (student_id, contact_type)
  WHERE student_id IS NOT NULL AND is_primary AND effective_to IS NULL;

CREATE UNIQUE INDEX contact_history_parent_primary_uq
  ON contact_history (parent_guardian_id, contact_type)
  WHERE parent_guardian_id IS NOT NULL AND is_primary AND effective_to IS NULL;

COMMIT;
