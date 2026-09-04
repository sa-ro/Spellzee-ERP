-- 0014_workforce_audit_guards.sql
-- Attaches audit, immutability, soft-delete and grant handling to every table
-- added in 0009-0013, mirroring 0008_audit_guards_and_grants.sql exactly.
--
-- Deliberate exception: teacher_subject/teacher_level/teacher_language are
-- current-capability tags, not transactional history (documented in
-- 0009_employee_teacher.sql) -- they get audit + updated_at but NOT the
-- no-hard-delete guard. Every other table in this batch gets the full treatment.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Automatic audit on create/update/delete -- rule 21, DD §41
-- ---------------------------------------------------------------------------
SELECT attach_audit('employee');
SELECT attach_audit('teacher');
SELECT attach_audit('teacher_subject');
SELECT attach_audit('teacher_level');
SELECT attach_audit('teacher_language');
SELECT attach_audit('teacher_availability');
SELECT attach_audit('teacher_capacity');
SELECT attach_audit('coordinator_ownership');
SELECT attach_audit('class_schedule');
SELECT attach_audit('teacher_allocation');
SELECT attach_audit('session');

-- ---------------------------------------------------------------------------
-- 2. updated_at / updated_by maintenance
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employee','teacher','teacher_subject','teacher_level','teacher_language',
    'teacher_availability','teacher_capacity','coordinator_ownership',
    'class_schedule','teacher_allocation','session'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'trg_touch_' || t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Immutable business identifiers -- rule 1, DD §6.3
--    Only tables with a public_id column: employee, teacher, class_schedule, session.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee','teacher','class_schedule','session'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_immutable_public_id()',
      'trg_immutable_id_' || t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Soft delete -- rule 13. Excludes the capability tag tables (see header).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employee','teacher','teacher_availability','teacher_capacity',
    'coordinator_ownership','class_schedule','teacher_allocation','session'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_no_delete()',
      'trg_no_delete_' || t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Extend archive_record()'s allow-list to cover employee and teacher --
--    the only two new tables with the full archived_at/by/reason pattern.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION archive_record(
  p_table  text,
  p_id     uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor uuid := app_require_actor(p_table);
  v_rows  integer;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'An archive reason is required (Master §22.5).'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF p_table NOT IN (
    'parent_guardian','student','enrollment','subscription','payment',
    'employee','teacher'
  ) THEN
    RAISE EXCEPTION '% is not archivable via this helper.', p_table
      USING ERRCODE = 'raise_exception';
  END IF;

  -- employee/teacher use employment_status, not status, for their lifecycle column.
  IF p_table IN ('employee','teacher') THEN
    EXECUTE format(
      'UPDATE %I SET employment_status = ''archived'', archived_at = now(), archived_by = $1,
                     archive_reason = $2
       WHERE id = $3 AND employment_status <> ''archived''',
      p_table
    ) USING v_actor, p_reason, p_id;
  ELSE
    EXECUTE format(
      'UPDATE %I SET status = ''archived'', archived_at = now(), archived_by = $1,
                     archive_reason = $2
       WHERE id = $3 AND status <> ''archived''',
      p_table
    ) USING v_actor, p_reason, p_id;
  END IF;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'No live % found with id % to archive.', p_table, p_id
      USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Active-record views
-- ---------------------------------------------------------------------------
CREATE VIEW v_active_employee AS
  SELECT * FROM employee WHERE employment_status <> 'archived';

CREATE VIEW v_active_teacher AS
  SELECT * FROM teacher WHERE employment_status <> 'archived';

CREATE VIEW v_current_teacher_allocation AS
  SELECT * FROM teacher_allocation WHERE is_current;

CREATE VIEW v_current_class_schedule AS
  SELECT * FROM class_schedule WHERE is_current;

CREATE VIEW v_current_coordinator_ownership AS
  SELECT * FROM coordinator_ownership WHERE is_current;

COMMENT ON VIEW v_current_teacher_allocation IS
  'The live teacher+schedule assignment per enrollment. DD §13.';
COMMENT ON VIEW v_current_coordinator_ownership IS
  'The live owner per (student, role). DD §14.';

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO spellzee_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO spellzee_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO spellzee_app;

-- The application can never hard-delete these business records. Capability tag
-- tables (teacher_subject/level/language) are deliberately NOT in this list --
-- see 0009's header comment.
REVOKE DELETE ON
  employee, teacher, teacher_availability, teacher_capacity,
  coordinator_ownership, class_schedule, teacher_allocation, session
FROM spellzee_app;

COMMIT;
