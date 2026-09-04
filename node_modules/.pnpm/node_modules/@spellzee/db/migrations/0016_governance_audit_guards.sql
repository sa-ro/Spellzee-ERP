-- 0016_governance_audit_guards.sql
-- Mirrors 0008/0014's pattern for the governance/RBAC tables added in 0015.
-- Sources: DD §41 (audit), rule 13, rule 21, rule 22, rule 23.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Automatic audit on create/update/delete -- rule 21, DD §41
--
-- role/permission follow the reference-data pattern (audited, no delete guard
-- -- same as course/subject/level/language in 0008). role_permission follows
-- the capability-tag pattern (audited, no delete guard -- same as
-- teacher_subject/level/language in 0009/0014: the join itself is disposable
-- config, the audit_event row is what makes a change attributable).
-- user_role/user_session/approval_request are sensitive records -- audited AND
-- delete-guarded.
-- ---------------------------------------------------------------------------
SELECT attach_audit('role');
SELECT attach_audit('permission');
SELECT attach_audit('role_permission');
SELECT attach_audit('user_role');
SELECT attach_audit('user_session');
SELECT attach_audit('approval_request');

-- ---------------------------------------------------------------------------
-- 2. updated_at maintenance. role/permission are reference-data tables with no
--    created_by/updated_by columns -- same as course/subject/level/language in
--    0008, deliberately excluded from this loop (set_updated_at() writes
--    NEW.updated_by, which those tables don't have). role_permission is
--    likewise excluded -- no updated_at column, same as the other
--    capability-tag tables.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_role','approval_request'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'trg_touch_' || t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Immutable business identifier -- only approval_request has a public_id
--    among this batch.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_immutable_id_approval_request
  BEFORE UPDATE ON approval_request
  FOR EACH ROW EXECUTE FUNCTION guard_immutable_public_id();

-- ---------------------------------------------------------------------------
-- 4. Soft delete -- rule 13. Sensitive/security records only (see note above).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_role','user_session','approval_request'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_no_delete()',
      'trg_no_delete_' || t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Current-state views -- default read path.
-- ---------------------------------------------------------------------------
CREATE VIEW v_current_user_role AS
  SELECT * FROM user_role WHERE is_current;

CREATE VIEW v_active_user_session AS
  SELECT * FROM user_session WHERE revoked_at IS NULL AND expires_at > now();

CREATE VIEW v_pending_approval_request AS
  SELECT * FROM approval_request WHERE status = 'pending';

COMMENT ON VIEW v_current_user_role IS 'The live role grants per user. DD §40.';
COMMENT ON VIEW v_active_user_session IS 'Sessions that are neither revoked nor expired.';
COMMENT ON VIEW v_pending_approval_request IS 'Approval requests awaiting a checker decision. DD §39.';

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO spellzee_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO spellzee_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO spellzee_app;

COMMIT;
