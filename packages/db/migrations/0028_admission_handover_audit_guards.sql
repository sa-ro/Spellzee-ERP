-- 0028_admission_handover_audit_guards.sql
-- Mirrors the established pattern for admission_handover.

BEGIN;

SELECT attach_audit('admission_handover');

CREATE TRIGGER trg_touch_admission_handover
  BEFORE UPDATE ON admission_handover
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_no_delete_admission_handover
  BEFORE DELETE ON admission_handover
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete();

CREATE VIEW v_pending_admission_handover AS
  SELECT * FROM admission_handover WHERE status IN ('pending','acknowledged');

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO spellzee_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO spellzee_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO spellzee_app;

REVOKE DELETE ON admission_handover FROM spellzee_app;

COMMIT;
