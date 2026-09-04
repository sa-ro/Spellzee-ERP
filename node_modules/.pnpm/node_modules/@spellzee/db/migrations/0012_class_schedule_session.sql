-- 0012_class_schedule_session.sql
-- Class Schedule (DD §15) and Session (DD §16).
--
-- Rule 7 (DD §43): "A recurring schedule is not the same as a session."
-- class_schedule is the versioned, recurring delivery arrangement; session is a
-- materialised individual occurrence.
--
-- class_schedule.teacher_id is the CURRENT operational teacher for this
-- schedule (DD §15 lists "Teacher ID(s)" as a direct field). teacher_allocation
-- (0013, created after this migration so it can hold a mandatory FK to
-- class_schedule) is the separate auditable DECISION record for WHY that
-- teacher is assigned. The allocation service keeps both in lockstep inside
-- one transaction -- see docs/data-model/04-history-audit-and-integrity.md.
--
-- SCOPE NOTE -- what this migration deliberately does NOT do:
--   * No merithub_class_id / merithub_session_id column. Rule 26 (DD §42):
--     external identifiers live ONLY in external_id_map, which already lists
--     'class_schedule' and 'teacher' and 'session' as valid mappable entity
--     types (0007_external_id_map.sql) -- the "stub" the user asked for is
--     already structurally in place; no Merithub sync logic is added here.
--   * session.outcome is a free, unconstrained nullable column. The outcome
--     vocabulary and its credit-impact consequences are explicitly the next
--     prompt's scope (compensation/session-outcome logic) -- constraining the
--     values now would mean inventing that vocabulary prematurely.
--   * No status-transition-graph trigger on session. The STATUS values
--     themselves are validated (DD §16 lists status as a core field); the
--     legal-transition graph is tightly coupled to outcome handling and is
--     deferred to the same next prompt, alongside attendance/session_participant
--     (see docs/data-model/05-open-modelling-questions.md, question A1: whether
--     group classes exist today is still unresolved, so multi-participant
--     session modelling is not built prematurely -- session carries a single
--     enrollment/student directly, matching DD §16's literal fields).

BEGIN;

-- ---------------------------------------------------------------------------
-- class_schedule -- DD §15, versioned per M3
-- ---------------------------------------------------------------------------
CREATE TABLE class_schedule (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id          text NOT NULL UNIQUE DEFAULT next_public_id('CLS'),

  enrollment_id      uuid NOT NULL REFERENCES enrollment(id),
  teacher_id         uuid NOT NULL REFERENCES teacher(id),

  session_type       text NOT NULL DEFAULT 'one_to_one',
  course_id          uuid NOT NULL REFERENCES course(id),
  subject_id         uuid NOT NULL REFERENCES subject(id),

  -- 0 = Sunday .. 6 = Saturday, matching teacher_availability/teacher_capacity.
  days_of_week       smallint[] NOT NULL,
  start_time         time NOT NULL,
  end_time           time NOT NULL,
  -- IANA zone name (e.g. 'Asia/Kolkata'). Recurrence is wall-clock in this
  -- zone, not a fixed UTC instant -- a "3 PM Monday class" stays 3 PM local
  -- across DST transitions (CLAUDE.md §6).
  timezone           text NOT NULL,

  start_date         date NOT NULL,
  planned_end_date   date,
  is_recurring       boolean NOT NULL DEFAULT true,

  status             text NOT NULL DEFAULT 'draft',

  -- M3 versioning columns.
  valid_from         timestamptz NOT NULL DEFAULT now(),
  valid_to           timestamptz,
  is_current         boolean NOT NULL DEFAULT true,
  superseded_by_id   uuid REFERENCES class_schedule(id),
  change_reason      text,
  requested_by       uuid REFERENCES user_account(id),
  approved_by        uuid REFERENCES user_account(id),

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES user_account(id),
  updated_by         uuid NOT NULL REFERENCES user_account(id),
  source             text NOT NULL DEFAULT 'ui',

  CONSTRAINT class_schedule_public_id_format CHECK (public_id ~ '^CLS-\d{4}-\d{6}$'),
  CONSTRAINT class_schedule_session_type_valid CHECK (session_type IN ('one_to_one','group')),
  CONSTRAINT class_schedule_status_valid CHECK (
    status IN ('draft','active','superseded','paused','ended','cancelled','discarded')
  ),
  CONSTRAINT class_schedule_time_order CHECK (end_time > start_time),
  -- array_length() returns NULL (not 0) for an empty array, and NULL in a CHECK
  -- is treated as satisfied -- so array_length(...) >= 1 silently accepts '{}'.
  -- cardinality() returns 0 for an empty array and is exact here (verified live).
  CONSTRAINT class_schedule_days_non_empty CHECK (cardinality(days_of_week) >= 1),
  -- Postgres CHECK constraints cannot contain subqueries, so this uses the
  -- array-containment operator instead of unnest()+EXISTS.
  CONSTRAINT class_schedule_days_valid CHECK (
    days_of_week <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
  ),
  CONSTRAINT class_schedule_end_after_start CHECK (planned_end_date IS NULL OR planned_end_date >= start_date),
  CONSTRAINT class_schedule_period_sane CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT class_schedule_current_open CHECK (
    (is_current AND valid_to IS NULL AND superseded_by_id IS NULL) OR (NOT is_current)
  ),
  CONSTRAINT class_schedule_not_self_superseded CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
);

COMMENT ON TABLE class_schedule IS
  'Recurring/planned delivery arrangement. DD §15, rule 7. Versioned: a day/time/teacher '
  'change supersedes the row rather than editing it in place.';
COMMENT ON COLUMN class_schedule.status IS
  'draft->active requires a successful Merithub class creation OR an explicit operator '
  'override once the integration exists (docs/data-model/03). No integration yet in Phase 1, '
  'so the allocation service creates schedules directly in ''active'' status.';

-- At most one current schedule per enrollment.
CREATE UNIQUE INDEX class_schedule_current_uq
  ON class_schedule (enrollment_id) WHERE is_current;

CREATE INDEX class_schedule_enrollment_idx ON class_schedule (enrollment_id);
CREATE INDEX class_schedule_teacher_idx ON class_schedule (teacher_id) WHERE is_current;
CREATE INDEX class_schedule_history_idx ON class_schedule (enrollment_id, valid_from);

-- ---------------------------------------------------------------------------
-- session -- DD §16
--
-- enrollment_id/student_id/teacher_id are denormalised from class_schedule at
-- creation time (not re-derived by joining through the schedule's CURRENT
-- version), so a session's historical record survives later reallocation --
-- exactly as documented in docs/data-model/02-entity-specifications.md.
-- ---------------------------------------------------------------------------
CREATE TABLE session (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id                text NOT NULL UNIQUE DEFAULT next_public_id('SES'),

  class_schedule_id        uuid NOT NULL REFERENCES class_schedule(id),
  enrollment_id            uuid NOT NULL REFERENCES enrollment(id),
  student_id               uuid NOT NULL REFERENCES student(id),
  teacher_id               uuid NOT NULL REFERENCES teacher(id),

  scheduled_start_at       timestamptz NOT NULL,
  scheduled_end_at         timestamptz NOT NULL,
  actual_start_at          timestamptz,
  actual_end_at            timestamptz,

  session_purpose          text NOT NULL DEFAULT 'regular',
  status                   text NOT NULL DEFAULT 'scheduled',
  -- Free text pending the next prompt's outcome vocabulary + credit-impact wiring.
  outcome                  text,

  cancellation_reason      text,
  rescheduled_to_session_id uuid REFERENCES session(id),
  -- Flag only -- no logic sets or consumes this yet (next prompt).
  compensation_required    boolean NOT NULL DEFAULT false,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid NOT NULL REFERENCES user_account(id),
  updated_by               uuid NOT NULL REFERENCES user_account(id),
  source                   text NOT NULL DEFAULT 'ui',

  CONSTRAINT session_public_id_format CHECK (public_id ~ '^SES-\d{4}-\d{6}$'),
  CONSTRAINT session_purpose_valid CHECK (session_purpose IN ('regular','compensation','replacement','extra')),
  CONSTRAINT session_status_valid CHECK (
    status IN ('scheduled','reminder_sent','confirmed','live','completed','cancelled','rescheduled','abandoned')
  ),
  CONSTRAINT session_time_order CHECK (scheduled_end_at > scheduled_start_at),
  CONSTRAINT session_actual_time_order CHECK (
    actual_end_at IS NULL OR actual_start_at IS NULL OR actual_end_at >= actual_start_at
  ),
  CONSTRAINT session_cancellation_reason_required CHECK (
    status <> 'cancelled' OR cancellation_reason IS NOT NULL
  ),
  CONSTRAINT session_not_self_rescheduled CHECK (rescheduled_to_session_id IS NULL OR rescheduled_to_session_id <> id)
);

COMMENT ON TABLE session IS
  'One specific class occurrence. DD §16, rule 7. No merithub_session_id column here -- '
  'external identifiers live only in external_id_map (rule 26).';
COMMENT ON COLUMN session.outcome IS
  'Unconstrained pending the next prompt (session-outcome/compensation logic), which will '
  'define the outcome vocabulary and its session_credit_ledger consequences (rule 17).';

-- Rule 1 (docs/data-model 04): a teacher is never double-booked. The single
-- most important DB-enforced guarantee for this entity.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE session ADD CONSTRAINT session_no_teacher_double_booking
  EXCLUDE USING gist (
    teacher_id WITH =,
    tstzrange(scheduled_start_at, scheduled_end_at) WITH &&
  ) WHERE (status NOT IN ('cancelled', 'rescheduled'));

CREATE INDEX session_schedule_idx ON session (class_schedule_id);
CREATE INDEX session_enrollment_idx ON session (enrollment_id);
CREATE INDEX session_student_idx ON session (student_id);
CREATE INDEX session_teacher_upcoming_idx ON session (teacher_id, scheduled_start_at)
  WHERE status IN ('scheduled','reminder_sent','confirmed');
CREATE INDEX session_status_idx ON session (status);

-- student_id must always match enrollment.student_id.
CREATE OR REPLACE FUNCTION guard_session_student_matches_enrollment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_enrollment_student uuid;
BEGIN
  SELECT student_id INTO v_enrollment_student FROM enrollment WHERE id = NEW.enrollment_id;
  IF v_enrollment_student IS NULL THEN
    RAISE EXCEPTION 'Enrollment % not found.', NEW.enrollment_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_enrollment_student <> NEW.student_id THEN
    RAISE EXCEPTION
      'Session student % does not match enrollment % student %.',
      NEW.student_id, NEW.enrollment_id, v_enrollment_student
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_session_student_consistent
  BEFORE INSERT OR UPDATE OF student_id, enrollment_id ON session
  FOR EACH ROW EXECUTE FUNCTION guard_session_student_matches_enrollment();

COMMIT;
