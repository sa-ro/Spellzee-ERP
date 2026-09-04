-- 0020_session_outcome_vocabulary.sql
-- Constrains session.outcome, which migration 0012 deliberately left
-- unconstrained pending this batch. Rule 19: teacher/Spellzee-side failure
-- protects entitlement and triggers compensation; student-side technical
-- failure is consumed with a goodwill exception (policy, not schema).
--
-- SCOPE NOTE: attendance-derived outcomes (Present/Late/Partial/Absent
-- thresholds) belong to the `attendance` table (not yet built, Phase 1 list)
-- -- this vocabulary is the DELIVERY outcome a session settles into, not the
-- attendance measurement that may inform it.

BEGIN;

ALTER TABLE session
  ADD CONSTRAINT session_outcome_valid CHECK (
    outcome IS NULL OR outcome IN (
      'completed',
      'teacher_absent',
      'teacher_technical_failure',
      'student_absent',
      'student_technical_failure',
      'cancelled_outside_cutoff',
      'cancelled_inside_cutoff'
    )
  );

COMMENT ON COLUMN session.outcome IS
  'Delivery outcome. teacher_absent/teacher_technical_failure are the '
  'compensation-qualifying outcomes (rule 19) -- see compensation.reason_code '
  '(0021) and packages/db/src/services/compensation.service.ts.';

COMMIT;
