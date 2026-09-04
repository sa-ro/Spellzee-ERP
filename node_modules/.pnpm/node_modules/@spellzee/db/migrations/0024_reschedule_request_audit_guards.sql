-- 0024_reschedule_request_audit_guards.sql
-- Mirrors 0008/0014/0016/0018/0022's pattern for reschedule_request.

BEGIN;

SELECT attach_audit('reschedule_request');

CREATE TRIGGER trg_touch_reschedule_request
  BEFORE UPDATE ON reschedule_request
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_no_delete_reschedule_request
  BEFORE DELETE ON reschedule_request
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete();

CREATE VIEW v_pending_reschedule_request AS
  SELECT * FROM reschedule_request WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO spellzee_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO spellzee_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO spellzee_app;

REVOKE DELETE ON reschedule_request FROM spellzee_app;

COMMIT;
