-- 0025_attendance.sql
-- attendance -- Phase 1 entity. CLAUDE.md §4 accepted policy defaults:
-- >=90% Present, 50-89% Partial, <50% Absent, >10 min late = Late.
--
-- SCOPE NOTE: `attendance` is not in the identifier-prefix table -- no
-- public_id. The status VALUE is computed by the pure domain function
-- packages/domain/src/delivery/attendance.ts (classifyAttendance) from
-- present/total/late minutes, reading the actual threshold numbers live from
-- policy_parameter at the service layer (rule 28) -- this migration only
-- stores the RESULT and the raw minute inputs it was computed from, so the
-- computation stays auditable/reconstructable even if the thresholds change
-- later.

BEGIN;

CREATE TABLE attendance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  session_id         uuid NOT NULL REFERENCES session(id),
  student_id         uuid NOT NULL REFERENCES student(id),

  attendance_status  text NOT NULL,
  present_minutes    integer NOT NULL,
  total_minutes      integer NOT NULL,
  late_by_minutes    integer NOT NULL DEFAULT 0,

  notes              text,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by        uuid NOT NULL REFERENCES user_account(id),

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES user_account(id),
  updated_by         uuid NOT NULL REFERENCES user_account(id),
  source             text NOT NULL DEFAULT 'ui',

  CONSTRAINT attendance_status_valid CHECK (
    attendance_status IN ('present','late','partial','absent')
  ),
  CONSTRAINT attendance_minutes_non_negative CHECK (
    present_minutes >= 0 AND total_minutes >= 0 AND late_by_minutes >= 0
  ),
  CONSTRAINT attendance_present_within_total CHECK (present_minutes <= total_minutes)
);

COMMENT ON TABLE attendance IS
  'One row per session -- attendance_status is the OUTPUT of classifyAttendance() '
  '(packages/domain), computed from present/total/late minutes against '
  'policy_parameter thresholds read live at record time (rule 28).';

-- One attendance record per session (a session occurs once; re-recording is a
-- correction, not a second row -- corrections go through an UPDATE, which is
-- ordinary here since attendance is not append-only/effective-dated).
CREATE UNIQUE INDEX attendance_session_uq ON attendance (session_id);
CREATE INDEX attendance_student_idx ON attendance (student_id);
CREATE INDEX attendance_status_idx ON attendance (attendance_status);

COMMIT;
