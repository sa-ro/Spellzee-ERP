-- 0013_teacher_allocation.sql
-- Teacher Allocation -- DD §13.
--
-- "Allocation is not merely a teacher assignment. It represents the teacher +
-- schedule arrangement for delivery." (DD §13, rule 9) This table is the
-- auditable DECISION record -- who requested it, why, who approved it, what it
-- replaced. class_schedule (0012) holds the resulting OPERATIONAL configuration;
-- created before this migration specifically so class_schedule_id can be a
-- proper mandatory FK here, rather than a column bolted on after the fact.
-- The allocation service keeps the two in lockstep inside one transaction --
-- documented as a service-layer invariant in
-- docs/data-model/04-history-audit-and-integrity.md, not a cross-table trigger.
--
-- Effective-dated per M3: a change closes the old row (valid_to, is_current,
-- superseded_by_id) and opens a new one -- Master §14.3: "Every change records
-- old teacher/time/days/session type, new ..., reason, initiator, effective
-- date, approver." At most one current allocation per enrollment (DD §13).
--
-- `reschedule_request_id` (DD §13) is omitted: reschedule_request does not
-- exist yet (Support module, not yet built) -- same reasoning as
-- coordinator_ownership's omitted ticket link (DD §1: examples aren't
-- automatically mandatory).

BEGIN;

CREATE TABLE teacher_allocation (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  enrollment_id                uuid NOT NULL REFERENCES enrollment(id),
  student_id                   uuid NOT NULL REFERENCES student(id),
  teacher_id                   uuid NOT NULL REFERENCES teacher(id),
  class_schedule_id            uuid NOT NULL REFERENCES class_schedule(id),

  allocation_type              text NOT NULL,

  -- What this allocation replaced, denormalised onto the new row so the
  -- change is readable without following superseded_by_id backwards
  -- (Master §14.3's "old teacher/time/days/session type").
  previous_teacher_id          uuid REFERENCES teacher(id),
  previous_class_schedule_id   uuid REFERENCES class_schedule(id),

  reason                       text NOT NULL,
  requested_by                 uuid NOT NULL REFERENCES user_account(id),
  approved_by                  uuid REFERENCES user_account(id),

  status                       text NOT NULL DEFAULT 'proposed',

  -- M3 effective-dating columns.
  valid_from                   timestamptz NOT NULL DEFAULT now(),
  valid_to                     timestamptz,
  is_current                   boolean NOT NULL DEFAULT true,
  superseded_by_id             uuid REFERENCES teacher_allocation(id),

  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  created_by                   uuid NOT NULL REFERENCES user_account(id),
  updated_by                   uuid NOT NULL REFERENCES user_account(id),
  source                       text NOT NULL DEFAULT 'ui',

  CONSTRAINT teacher_allocation_type_valid CHECK (
    allocation_type IN (
      'new_admission','teacher_change','schedule_change','day_change',
      'session_type_change','course_change','student_requested',
      'teacher_unavailability','academic','break','resume'
    )
  ),
  CONSTRAINT teacher_allocation_status_valid CHECK (
    status IN ('proposed','pending_approval','active','rejected','superseded','ended')
  ),
  CONSTRAINT teacher_allocation_period_sane CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT teacher_allocation_current_open CHECK (
    (is_current AND valid_to IS NULL AND superseded_by_id IS NULL) OR (NOT is_current)
  ),
  CONSTRAINT teacher_allocation_not_self_superseded CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
  CONSTRAINT teacher_allocation_not_own_previous CHECK (previous_teacher_id IS NULL OR previous_teacher_id <> teacher_id)
);

COMMENT ON TABLE teacher_allocation IS
  'The auditable teacher+schedule assignment decision. DD §13, rule 9, rule 12. '
  'A change INSERTs a new row and closes the old one -- never UPDATEs teacher_id in place.';

-- At most one current allocation per enrollment -- the core invariant (DD §13).
CREATE UNIQUE INDEX teacher_allocation_current_uq
  ON teacher_allocation (enrollment_id) WHERE is_current;

CREATE INDEX teacher_allocation_teacher_idx ON teacher_allocation (teacher_id) WHERE is_current;
CREATE INDEX teacher_allocation_student_idx ON teacher_allocation (student_id);
CREATE INDEX teacher_allocation_history_idx ON teacher_allocation (enrollment_id, valid_from);

-- student_id must always match enrollment.student_id -- same pattern as
-- guard_subscription_student_matches_enrollment (0006_commercial.sql).
CREATE OR REPLACE FUNCTION guard_allocation_student_matches_enrollment()
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
      'Allocation student % does not match enrollment % student %.',
      NEW.student_id, NEW.enrollment_id, v_enrollment_student
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_allocation_student_consistent
  BEFORE INSERT OR UPDATE OF student_id, enrollment_id ON teacher_allocation
  FOR EACH ROW EXECUTE FUNCTION guard_allocation_student_matches_enrollment();

-- Rule 25 (DD §43): "A teacher should not be allocated if mandatory
-- onboarding/certification rules are not satisfied." Enforced at the point an
-- allocation becomes (or is created directly as) 'active'.
--
-- IMPORTANT: this does NOT call audit.record_blocked() itself. A RAISE
-- EXCEPTION aborts the entire enclosing transaction, and Postgres has no
-- autonomous-transaction primitive -- any audit_event row written earlier in
-- the SAME transaction is rolled back along with everything else. Calling
-- record_blocked() here would look like it satisfies "blocked attempts are
-- evidence" (DD §41) while silently never persisting anything; that was tried,
-- caught by live-database verification, and removed as dead/misleading code.
--
-- The durable fix lives in the SERVICE layer instead: allocation.service.ts
-- checks teacher.is_allocation_eligible BEFORE attempting the INSERT (the
-- prompt's own requirement -- "check ... before confirming"), and on catching
-- this guard's exception writes the blocked audit_event row in a FRESH
-- transaction/connection, which is unaffected by the failed one. This trigger
-- remains as a defense-in-depth backstop against any code path that bypasses
-- the service and writes teacher_allocation directly -- it still reliably
-- BLOCKS the write via the raised exception, it just cannot durably self-log
-- the block from inside the transaction it is itself aborting.
CREATE OR REPLACE FUNCTION guard_teacher_allocation_eligible()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_eligible boolean;
  v_public   text;
BEGIN
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  SELECT is_allocation_eligible, public_id INTO v_eligible, v_public
  FROM teacher WHERE id = NEW.teacher_id;

  IF NOT v_eligible THEN
    RAISE EXCEPTION
      'Teacher % is not allocation-eligible -- mandatory onboarding/certification not satisfied (rule 25).',
      coalesce(v_public, NEW.teacher_id::text)
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_teacher_allocation_eligible
  BEFORE INSERT OR UPDATE OF status, teacher_id ON teacher_allocation
  FOR EACH ROW EXECUTE FUNCTION guard_teacher_allocation_eligible();

-- The class_schedule referenced by an allocation must belong to the same
-- enrollment -- otherwise "allocation = teacher + schedule" (rule 9) could
-- silently point a student's allocation at someone else's schedule.
CREATE OR REPLACE FUNCTION guard_allocation_schedule_matches_enrollment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_schedule_enrollment uuid;
BEGIN
  SELECT enrollment_id INTO v_schedule_enrollment FROM class_schedule WHERE id = NEW.class_schedule_id;
  IF v_schedule_enrollment IS NULL THEN
    RAISE EXCEPTION 'Class schedule % not found.', NEW.class_schedule_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_schedule_enrollment <> NEW.enrollment_id THEN
    RAISE EXCEPTION
      'Allocation enrollment % does not match class_schedule % enrollment %.',
      NEW.enrollment_id, NEW.class_schedule_id, v_schedule_enrollment
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_allocation_schedule_consistent
  BEFORE INSERT OR UPDATE OF enrollment_id, class_schedule_id ON teacher_allocation
  FOR EACH ROW EXECUTE FUNCTION guard_allocation_schedule_matches_enrollment();

COMMIT;
