-- 0010_teacher_availability_capacity.sql
-- Teacher Availability (DD §12.1) and Teacher Capacity (DD §12.2).
--
-- Rule 8 (DD §43): "Teacher availability is not the same as capacity."
-- Availability answers "is this person free at this time?" -- a declarative,
-- possibly-overlapping set of rules (regular hours, one-off exceptions, leave).
-- Capacity answers "how much can Spellzee realistically deliver?" -- a measured
-- quantity, keyed by the same day/time granularity, that the allocation service
-- reads before confirming and updates when it confirms.
--
-- Forecast capacity (DD §12.3: expected releases from breaks/completions) is
-- explicitly Phase 5 (CLAUDE.md §4 accepted default) -- current capacity only here.

BEGIN;

-- ---------------------------------------------------------------------------
-- teacher_availability -- DD §12.1
--
-- Intentionally NOT effective-dated with is_current/superseded_by: a teacher
-- legitimately holds MULTIPLE simultaneous rules (regular Mon-Fri hours PLUS a
-- temporary Saturday slot PLUS an unavailable exception cutting through both).
-- This is a set of time-boxed declarations, not a single current value.
-- ---------------------------------------------------------------------------
CREATE TABLE teacher_availability (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id         uuid NOT NULL REFERENCES teacher(id),

  availability_type  text NOT NULL,

  -- Exactly one of these identifies WHEN this rule applies, depending on type:
  -- day_of_week for a weekly-recurring rule, specific_date_on for a one-off.
  day_of_week        smallint,
  specific_date_on    date,

  start_time         time NOT NULL,
  end_time           time NOT NULL,
  timezone           text NOT NULL,

  effective_from     date NOT NULL DEFAULT current_date,
  effective_to       date,

  reason             text,
  approval_id        uuid,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES user_account(id),
  updated_by         uuid NOT NULL REFERENCES user_account(id),
  source             text NOT NULL DEFAULT 'ui',

  CONSTRAINT teacher_availability_type_valid CHECK (
    availability_type IN ('regular','specific_date','temporary','unavailable')
  ),
  CONSTRAINT teacher_availability_day_or_date CHECK (
    (availability_type = 'regular' AND day_of_week IS NOT NULL AND specific_date_on IS NULL)
    OR (availability_type IN ('specific_date','temporary','unavailable')
        AND specific_date_on IS NOT NULL AND day_of_week IS NULL)
  ),
  CONSTRAINT teacher_availability_day_range CHECK (day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6),
  CONSTRAINT teacher_availability_time_order CHECK (end_time > start_time),
  CONSTRAINT teacher_availability_period_sane CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE teacher_availability IS
  'Declared time windows a teacher is (or is not) free. DD §12.1. Multiple rows may '
  'legitimately overlap -- an unavailable rule is expected to cut through a regular one.';
COMMENT ON COLUMN teacher_availability.day_of_week IS '0 = Sunday .. 6 = Saturday, ISO-adjacent convention chosen for readability.';

CREATE INDEX teacher_availability_teacher_idx ON teacher_availability (teacher_id);
CREATE INDEX teacher_availability_regular_idx
  ON teacher_availability (teacher_id, day_of_week) WHERE availability_type = 'regular';
CREATE INDEX teacher_availability_dated_idx
  ON teacher_availability (teacher_id, specific_date_on) WHERE specific_date_on IS NOT NULL;

-- ---------------------------------------------------------------------------
-- teacher_capacity -- DD §12.2 (Phase 1: current capacity only)
--
-- Keyed at the same day+time-window granularity as availability, so the
-- allocation service can check both with one identifying tuple. Effective-dated
-- because planned capacity changes over time (a teacher's contracted hours
-- change); at most one row may be current for a given slot.
--
-- allocated_capacity_minutes is bookkeeping maintained by the allocation
-- service (packages/db/src/services/allocation.service.ts), not derived by a
-- trigger scanning teacher_allocation -- deriving it from overlapping
-- allocations across arbitrary date ranges is a materially bigger piece of
-- logic than "basics" (Master §29) calls for. The CHECK constraint below is a
-- backstop that makes the invariant hold even if the service has a bug.
-- ---------------------------------------------------------------------------
CREATE TABLE teacher_capacity (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id                uuid NOT NULL REFERENCES teacher(id),

  day_of_week               smallint NOT NULL,
  start_time                time NOT NULL,
  end_time                  time NOT NULL,

  planned_capacity_minutes   integer NOT NULL,
  allocated_capacity_minutes integer NOT NULL DEFAULT 0,
  reserved_minutes           integer NOT NULL DEFAULT 0,
  free_capacity_minutes      integer GENERATED ALWAYS AS (
    planned_capacity_minutes - allocated_capacity_minutes - reserved_minutes
  ) STORED,

  effective_from            date NOT NULL DEFAULT current_date,
  effective_to              date,
  is_current                boolean NOT NULL DEFAULT true,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NOT NULL REFERENCES user_account(id),
  updated_by                uuid NOT NULL REFERENCES user_account(id),
  source                    text NOT NULL DEFAULT 'ui',

  CONSTRAINT teacher_capacity_day_range CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT teacher_capacity_time_order CHECK (end_time > start_time),
  CONSTRAINT teacher_capacity_period_sane CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT teacher_capacity_planned_positive CHECK (planned_capacity_minutes > 0),
  CONSTRAINT teacher_capacity_allocated_non_negative CHECK (allocated_capacity_minutes >= 0),
  CONSTRAINT teacher_capacity_reserved_non_negative CHECK (reserved_minutes >= 0),
  -- The backstop: allocated + reserved can never exceed what was planned.
  CONSTRAINT teacher_capacity_within_plan CHECK (
    allocated_capacity_minutes + reserved_minutes <= planned_capacity_minutes
  ),
  CONSTRAINT teacher_capacity_current_open CHECK (
    (is_current AND effective_to IS NULL) OR (NOT is_current)
  )
);

COMMENT ON TABLE teacher_capacity IS
  'Current delivery capacity per teacher per weekly time-slot. DD §12.2. Forecast '
  'capacity (DD §12.3) is Phase 5 -- deliberately absent here (CLAUDE.md §4).';
COMMENT ON COLUMN teacher_capacity.allocated_capacity_minutes IS
  'Maintained by the allocation service inside the same transaction as each '
  'allocation change, not derived by trigger. The within-plan CHECK is a backstop.';

-- One current capacity row per exact (teacher, day, start_time, end_time); the
-- period itself must not overlap a previous version of the same slot.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE teacher_capacity ADD CONSTRAINT teacher_capacity_no_overlap
  EXCLUDE USING gist (
    teacher_id WITH =,
    day_of_week WITH =,
    start_time WITH =,
    end_time WITH =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date)) WITH &&
  );

CREATE INDEX teacher_capacity_teacher_idx ON teacher_capacity (teacher_id) WHERE is_current;
CREATE INDEX teacher_capacity_slot_idx ON teacher_capacity (teacher_id, day_of_week, start_time, end_time) WHERE is_current;

COMMIT;
