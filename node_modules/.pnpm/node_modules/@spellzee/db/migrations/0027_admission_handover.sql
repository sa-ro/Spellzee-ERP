-- 0027_admission_handover.sql
-- admission_handover -- Phase 1 entity. Master §"admission-allocation SLA
-- 24h (start: handover receipt; stop: allocation confirmed)".
--
-- SCOPE NOTE: not in the identifier-prefix table -- no public_id. This
-- migration keeps its own sla_deadline_at column rather than depending on
-- the generic sla_policy/sla_instance tables (a later, separate batch) --
-- the two systems are not coupled in Phase 1; retrofitting admission_handover
-- onto the generic SLA engine is a future integration, not required for this
-- entity's own correctness.

BEGIN;

CREATE TABLE admission_handover (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  student_id        uuid NOT NULL REFERENCES student(id),
  enrollment_id     uuid NOT NULL REFERENCES enrollment(id),

  handed_over_by    uuid NOT NULL REFERENCES employee(id),
  received_by       uuid REFERENCES employee(id),

  status            text NOT NULL DEFAULT 'pending',
  handover_notes    text,

  sla_deadline_at   timestamptz NOT NULL,
  acknowledged_at   timestamptz,
  allocated_at      timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES user_account(id),
  updated_by        uuid NOT NULL REFERENCES user_account(id),
  source            text NOT NULL DEFAULT 'ui',

  CONSTRAINT admission_handover_status_valid CHECK (
    status IN ('pending','acknowledged','allocated','breached','cancelled')
  ),
  CONSTRAINT admission_handover_acknowledged_complete CHECK (
    status = 'pending' OR (received_by IS NOT NULL AND acknowledged_at IS NOT NULL)
  ),
  CONSTRAINT admission_handover_allocated_has_timestamp CHECK (
    status <> 'allocated' OR allocated_at IS NOT NULL
  )
);

COMMENT ON TABLE admission_handover IS
  'Tracks the sales/admissions -> operations handoff for one enrollment, '
  'against the 24h admission-allocation SLA. One handover per enrollment '
  '(admission_handover_enrollment_uq).';

CREATE UNIQUE INDEX admission_handover_enrollment_uq ON admission_handover (enrollment_id);
CREATE INDEX admission_handover_pending_idx ON admission_handover (status) WHERE status = 'pending';
CREATE INDEX admission_handover_student_idx ON admission_handover (student_id);

COMMIT;
