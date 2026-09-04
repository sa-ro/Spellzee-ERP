-- 0022_compensation_audit_guards.sql
-- Mirrors 0008/0014/0016/0018's pattern for `compensation`.
-- Sources: rule 13, rule 21, rule 23.

BEGIN;

SELECT attach_audit('compensation');

CREATE TRIGGER trg_touch_compensation
  BEFORE UPDATE ON compensation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_no_delete_compensation
  BEFORE DELETE ON compensation
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete();

CREATE VIEW v_pending_compensation AS
  SELECT * FROM compensation WHERE status = 'scheduled';

COMMENT ON VIEW v_pending_compensation IS 'Compensation sessions not yet delivered, cancelled or expired.';

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO spellzee_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO spellzee_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO spellzee_app;

REVOKE DELETE ON compensation FROM spellzee_app;

COMMIT;
