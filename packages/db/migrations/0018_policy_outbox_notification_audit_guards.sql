-- 0018_policy_outbox_notification_audit_guards.sql
-- Mirrors 0008/0014/0016's pattern for policy_parameter, outbox_event, notification.
-- Sources: rule 13, rule 21, rule 23.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Automatic audit -- rule 21. All three are sensitive/security-adjacent
--    records (policy decisions, integration side effects, dispatched
--    communications) -- audited AND delete-guarded, same tier as
--    approval_request/user_role rather than the reference-data tier.
-- ---------------------------------------------------------------------------
SELECT attach_audit('policy_parameter');
SELECT attach_audit('outbox_event');
SELECT attach_audit('notification');

-- ---------------------------------------------------------------------------
-- 2. updated_at maintenance (skip outbox_event -- no updated_by column; its
--    worker-driven status/attempts fields are updated by the drain job, not
--    the audit-actor-attributed path the other tables use).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policy_parameter','notification'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'trg_touch_' || t, t
    );
  END LOOP;
END $$;

-- outbox_event still gets its own plain updated_at maintenance (no actor
-- attribution -- the drain worker is a system process, not a user action).
CREATE OR REPLACE FUNCTION touch_updated_at_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_touch_outbox_event
  BEFORE UPDATE ON outbox_event
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at_only();

-- ---------------------------------------------------------------------------
-- 3. Soft delete -- rule 13. Policy history, integration failure history and
--    notification history must all remain reconstructable.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policy_parameter','outbox_event','notification'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_no_delete()',
      'trg_no_delete_' || t, t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Current-state / operational views
-- ---------------------------------------------------------------------------
CREATE VIEW v_current_policy_parameter AS
  SELECT * FROM policy_parameter WHERE is_current;

CREATE VIEW v_pending_outbox_event AS
  SELECT * FROM outbox_event WHERE status IN ('pending','failed') AND next_attempt_at <= now();

CREATE VIEW v_pending_notification AS
  SELECT * FROM notification WHERE status = 'pending' AND scheduled_for <= now();

COMMENT ON VIEW v_current_policy_parameter IS 'The live value per policy key. Rule 28.';
COMMENT ON VIEW v_pending_outbox_event IS 'Outbox rows the drain worker should pick up now.';
COMMENT ON VIEW v_pending_notification IS 'Notifications due for dispatch now.';

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO spellzee_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO spellzee_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO spellzee_app;

COMMIT;
