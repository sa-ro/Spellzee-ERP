-- 0026_attendance_audit_guards.sql
-- Mirrors 0008/0014/0016/0018/0022/0024's pattern for attendance.

BEGIN;

SELECT attach_audit('attendance');

CREATE TRIGGER trg_touch_attendance
  BEFORE UPDATE ON attendance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_no_delete_attendance
  BEFORE DELETE ON attendance
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete();

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO spellzee_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO spellzee_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO spellzee_app;

REVOKE DELETE ON attendance FROM spellzee_app;

COMMIT;
