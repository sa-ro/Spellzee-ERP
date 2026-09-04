-- 0008_audit_guards_and_grants.sql
-- Attaches the audit trigger to every business table, installs the soft-delete
-- guards, adds the archive helpers, and sets the application role's grants.
--
-- Sources: DD §41 (audit), DD §2 / Master §22.6 (archive, never delete),
--          rule 13, rule 21, rule 23.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Automatic audit on create/update/delete -- rule 21, DD §41
-- ---------------------------------------------------------------------------
SELECT attach_audit('parent_guardian');
SELECT attach_audit('student');
SELECT attach_audit('student_parent_link');
SELECT attach_audit('contact_history');
SELECT attach_audit('identity_match');
SELECT attach_audit('merge_event');
SELECT attach_audit('enrollment');
SELECT attach_audit('subscription');
SELECT attach_audit('payment');
SELECT attach_audit('external_id_map');
SELECT attach_audit('user_account');

-- Reference data is audited too: a renamed course silently changing meaning for
-- historical enrollments is exactly the kind of invisible change rule 11 forbids.
SELECT attach_audit('language');
SELECT attach_audit('subject');
SELECT attach_audit('level');
SELECT attach_audit('course');

-- ---------------------------------------------------------------------------
-- 2. updated_at / updated_by maintenance
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'parent_guardian','student','student_parent_link','contact_history',
    'identity_match','merge_event','enrollment','subscription','payment','external_id_map'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'trg_touch_' || t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Immutable business identifiers -- rule 1, DD §6.3
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parent_guardian','student','enrollment','subscription','payment'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_immutable_public_id()',
      'trg_immutable_id_' || t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Soft delete -- rule 13. These records are archived, never removed.
--
-- Two layers: REVOKE stops the application role, the trigger stops everyone else
-- (including a developer connected as the owner) and produces a legible error.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'parent_guardian','student','student_parent_link','contact_history',
    'identity_match','merge_event','enrollment','subscription','payment'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_no_delete()',
      'trg_no_delete_' || t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Archive helpers
--
-- Archiving is a deliberate, reasoned act -- the reason is mandatory, and the
-- resulting UPDATE produces an audit row like any other change.
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
    'parent_guardian','student','enrollment','subscription','payment'
  ) THEN
    RAISE EXCEPTION '% is not archivable via this helper.', p_table
      USING ERRCODE = 'raise_exception';
  END IF;

  EXECUTE format(
    'UPDATE %I SET status = ''archived'', archived_at = now(), archived_by = $1,
                   archive_reason = $2
     WHERE id = $3 AND status <> ''archived''',
    p_table
  ) USING v_actor, p_reason, p_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'No live % found with id % to archive.', p_table, p_id
      USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

COMMENT ON FUNCTION archive_record(text, uuid, text) IS
  'Soft-delete. Sets status=archived with a mandatory reason and attributed actor. '
  'Hard deletion is blocked by trigger and revoked grant (rule 13).';

-- ---------------------------------------------------------------------------
-- 6. Active-record views -- the default read path, so archived rows do not leak
--    into ordinary queries by accident.
-- ---------------------------------------------------------------------------
CREATE VIEW v_active_student AS
  SELECT * FROM student WHERE status NOT IN ('archived','merged');

CREATE VIEW v_active_parent_guardian AS
  SELECT * FROM parent_guardian WHERE status <> 'archived';

CREATE VIEW v_active_enrollment AS
  SELECT * FROM enrollment WHERE status <> 'archived';

CREATE VIEW v_active_subscription AS
  SELECT * FROM subscription WHERE status <> 'archived';

CREATE VIEW v_active_payment AS
  SELECT * FROM payment WHERE status <> 'archived';

COMMENT ON VIEW v_active_student IS
  'Excludes archived and merged-away students. Merged records remain queryable '
  'directly on student for history reconstruction (rule 4).';

-- ---------------------------------------------------------------------------
-- 7. Grants -- rule 13 and rule 23 expressed as privileges
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO spellzee_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO spellzee_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO spellzee_app;

-- The application can never hard-delete a business record.
REVOKE DELETE ON
  parent_guardian, student, student_parent_link, contact_history,
  identity_match, merge_event, enrollment, subscription, payment, external_id_map
FROM spellzee_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO spellzee_app;

COMMIT;
