-- 0030_support_audit_guards.sql
-- Mirrors the established pattern for sla_policy, ticket, sla_instance.

BEGIN;

SELECT attach_audit('sla_policy');
SELECT attach_audit('ticket');
SELECT attach_audit('sla_instance');

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sla_policy', 'ticket', 'sla_instance'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'trg_touch_' || t, t
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_no_delete()',
      'trg_no_delete_' || t, t
    );
  END LOOP;
END $$;

CREATE TRIGGER trg_immutable_id_ticket
  BEFORE UPDATE ON ticket
  FOR EACH ROW EXECUTE FUNCTION guard_immutable_public_id();

CREATE VIEW v_open_ticket AS
  SELECT * FROM ticket WHERE status IN ('open','in_progress','reopened');

CREATE VIEW v_active_sla_instance AS
  SELECT * FROM sla_instance WHERE status IN ('active','warned');

COMMENT ON VIEW v_open_ticket IS 'Tickets not yet resolved/closed.';
COMMENT ON VIEW v_active_sla_instance IS 'SLA clocks still running (not yet resolved/cancelled).';

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO spellzee_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO spellzee_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO spellzee_app;

REVOKE DELETE ON sla_policy, ticket, sla_instance FROM spellzee_app;

COMMIT;
