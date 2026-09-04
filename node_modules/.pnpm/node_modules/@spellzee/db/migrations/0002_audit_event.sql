-- 0002_audit_event.sql
-- Generic, reusable audit event table + the trigger that populates it.
--
-- Source: DD §41 (Audit Event Entity), Master §22.5/§22.6, CLAUDE.md §5 layer 1.
--
-- Design notes
--   * Partitioned monthly on occurred_at (CLAUDE.md §4: 7-year retention).
--   * entity_type/record_id carry NO foreign key -- deliberately. An audit row must
--     survive its subject's archival, and an FK cascade could orphan or delete it,
--     defeating rule 23. This is the one accepted exception to "no polymorphic keys".
--   * The application role gets SELECT only. All writes arrive through the
--     SECURITY DEFINER trigger below, so audit rows cannot be forged or suppressed
--     by application code.

BEGIN;

CREATE TABLE audit.audit_event (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  public_id        text        NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),

  -- Actor (DD §41: user/service, IP/device/session metadata)
  actor_user_id    uuid        NOT NULL,
  actor_session_id uuid,
  ip               inet,
  user_agent       text,

  -- What happened
  action           text        NOT NULL,
  entity_type      text        NOT NULL,
  record_id        uuid        NOT NULL,
  record_public_id text,

  -- Before / after (DD §41: old value, new value)
  old_value        jsonb,
  new_value        jsonb,
  changed_fields   text[]      NOT NULL DEFAULT '{}',

  -- Context
  reason           text,
  approval_id      uuid,
  correlation_id   text,
  source           text        NOT NULL,
  outcome          text        NOT NULL DEFAULT 'success',

  CONSTRAINT audit_event_pkey PRIMARY KEY (id, occurred_at),
  CONSTRAINT audit_event_action_valid CHECK (
    action IN ('INSERT','UPDATE','DELETE','APPROVE','REJECT','OVERRIDE','EXPORT','LOGIN','MERGE','ARCHIVE')
  ),
  CONSTRAINT audit_event_outcome_valid CHECK (
    outcome IN ('success','blocked','failed')
  ),
  CONSTRAINT audit_event_source_valid CHECK (
    source = 'ui' OR source = 'api' OR source = 'job' OR source = 'migration'
    OR source LIKE 'webhook:%'
  ),
  -- An INSERT has no old_value; a DELETE has no new_value. Everything else has both.
  CONSTRAINT audit_event_values_consistent CHECK (
    (action = 'INSERT' AND old_value IS NULL AND new_value IS NOT NULL)
    OR (action = 'DELETE' AND old_value IS NOT NULL AND new_value IS NULL)
    OR action NOT IN ('INSERT','DELETE')
  )
) PARTITION BY RANGE (occurred_at);

COMMENT ON TABLE audit.audit_event IS
  'Immutable audit trail. DD §41. Written only by audit.record_change(); '
  'UPDATE/DELETE are revoked and trigger-blocked.';
COMMENT ON COLUMN audit.audit_event.record_id IS
  'Subject row id. Intentionally NOT a foreign key so the audit row outlives its subject.';
COMMENT ON COLUMN audit.audit_event.outcome IS
  'blocked = the actor attempted something a guard refused. Blocked attempts are evidence (DD §41).';

CREATE INDEX audit_event_entity_idx     ON audit.audit_event (entity_type, record_id, occurred_at DESC);
CREATE INDEX audit_event_actor_idx      ON audit.audit_event (actor_user_id, occurred_at DESC);
CREATE INDEX audit_event_correlation_idx ON audit.audit_event (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX audit_event_changed_idx    ON audit.audit_event USING gin (changed_fields);
CREATE INDEX audit_event_outcome_idx    ON audit.audit_event (outcome, occurred_at DESC) WHERE outcome <> 'success';

-- Pinned so INSERT succeeds inside the SECURITY DEFINER trigger regardless of
-- which role applied this migration (see the note in 0001 on schema ownership).
ALTER TABLE audit.audit_event OWNER TO spellzee_owner;

-- ---------------------------------------------------------------------------
-- Monthly partitions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.ensure_partition(p_month date)
RETURNS void
LANGUAGE plpgsql
-- SECURITY DEFINER: creating a partition is a DDL act (CREATE TABLE, GRANT) that
-- the application role must never hold directly -- that would let it also alter
-- or drop audit partitions. Running as spellzee_owner keeps CREATE ON SCHEMA audit
-- off spellzee_app while still letting a scheduled job (running as spellzee_app)
-- call this function to provision next month's partition.
SECURITY DEFINER
SET search_path = audit, public, pg_temp
AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('audit_event_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'audit' AND c.relname = v_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE audit.%I PARTITION OF audit.audit_event FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end
    );
    EXECUTE format('GRANT SELECT ON audit.%I TO spellzee_app', v_name);
  END IF;
END;
$$;

ALTER FUNCTION audit.ensure_partition(date) OWNER TO spellzee_owner;
GRANT EXECUTE ON FUNCTION audit.ensure_partition(date) TO spellzee_app;

COMMENT ON FUNCTION audit.ensure_partition(date) IS
  'Idempotently creates the monthly partition covering the given date. Called by a scheduled job. '
  'SECURITY DEFINER so the scheduled job (running as spellzee_app) never needs CREATE on schema audit.';

-- Catch-all so a missing partition can never lose an audit row.
CREATE TABLE audit.audit_event_default PARTITION OF audit.audit_event DEFAULT;
ALTER TABLE audit.audit_event_default OWNER TO spellzee_owner;

-- Current month plus the next three.
SELECT audit.ensure_partition((date_trunc('month', now()) + (n || ' months')::interval)::date)
FROM generate_series(0, 3) AS n;

-- ---------------------------------------------------------------------------
-- The audit trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.record_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_old      jsonb;
  v_new      jsonb;
  v_changed  text[];
  v_action   text;
  v_record   uuid;
  v_public   text;
  v_ip       inet;
BEGIN
  -- Rule 17 / DD §41 -- no actor, no write. Applies to jobs and webhooks too;
  -- they must set a service-account actor.
  v_actor := app_require_actor(TG_TABLE_NAME);

  IF TG_OP = 'INSERT' THEN
    v_action := 'INSERT';
    v_new    := to_jsonb(NEW);
    v_record := NEW.id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'UPDATE';
    v_old    := to_jsonb(OLD);
    v_new    := to_jsonb(NEW);
    v_record := NEW.id;
  ELSE
    v_action := 'DELETE';
    v_old    := to_jsonb(OLD);
    v_record := OLD.id;
  END IF;

  -- Which fields actually changed. updated_at/updated_by are bookkeeping, not content:
  -- excluding them stops every touch producing a noise row.
  IF TG_OP = 'UPDATE' THEN
    SELECT coalesce(array_agg(k ORDER BY k), '{}')
      INTO v_changed
    FROM jsonb_object_keys(v_new) AS k
    WHERE k NOT IN ('updated_at', 'updated_by')
      AND (v_old -> k) IS DISTINCT FROM (v_new -> k);

    IF cardinality(v_changed) = 0 THEN
      RETURN NULL;  -- nothing of substance changed
    END IF;
  END IF;

  v_public := coalesce(v_new ->> 'public_id', v_old ->> 'public_id');

  BEGIN
    v_ip := app_setting('app.ip')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  INSERT INTO audit.audit_event (
    public_id, occurred_at, actor_user_id, actor_session_id, ip, user_agent,
    action, entity_type, record_id, record_public_id,
    old_value, new_value, changed_fields,
    reason, correlation_id, source, outcome
  ) VALUES (
    next_public_id('AUD'),
    now(),
    v_actor,
    nullif(app_setting('app.session_id'), '')::uuid,
    v_ip,
    app_setting('app.user_agent'),
    v_action,
    TG_TABLE_NAME,
    v_record,
    v_public,
    v_old,
    v_new,
    coalesce(v_changed, '{}'),
    app_setting('app.reason'),
    app_setting('app.correlation_id'),
    coalesce(app_setting('app.source'), 'api'),
    'success'
  );

  RETURN NULL;  -- AFTER trigger
END;
$$;

COMMENT ON FUNCTION audit.record_change() IS
  'Generic audit trigger. Attach with attach_audit(''<table>''). DD §41.';

ALTER FUNCTION audit.record_change() OWNER TO spellzee_owner;

-- Records an attempt that a guard refused (DD §41: outcome = blocked).
CREATE OR REPLACE FUNCTION audit.record_blocked(
  p_entity_type text,
  p_record_id   uuid,
  p_action      text,
  p_reason      text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, public, pg_temp
AS $$
BEGIN
  INSERT INTO audit.audit_event (
    public_id, actor_user_id, actor_session_id, action, entity_type, record_id,
    reason, correlation_id, source, outcome, new_value
  ) VALUES (
    next_public_id('AUD'),
    coalesce(app_actor_id(), '00000000-0000-0000-0000-000000000000'::uuid),
    nullif(app_setting('app.session_id'), '')::uuid,
    p_action, p_entity_type, p_record_id,
    p_reason,
    app_setting('app.correlation_id'),
    coalesce(app_setting('app.source'), 'api'),
    'blocked',
    '{}'::jsonb
  );
END;
$$;

ALTER FUNCTION audit.record_blocked(text, uuid, text, text) OWNER TO spellzee_owner;
GRANT EXECUTE ON FUNCTION audit.record_blocked(text, uuid, text, text) TO spellzee_app;

COMMENT ON FUNCTION audit.record_blocked(text, uuid, text, text) IS
  'Records a refused attempt (DD §41 outcome=blocked) from any guard trigger, e.g. '
  'trg_teacher_allocation_eligible (0012). SECURITY DEFINER with EXECUTE granted to '
  'spellzee_app, since guard triggers themselves run as the caller, not as spellzee_owner.';

-- ---------------------------------------------------------------------------
-- Attachment helper -- every business table gets audited via this, so a table
-- added without it is visibly missing a line in a migration (CLAUDE.md §6).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION attach_audit(p_table text, p_schema text DEFAULT 'public')
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', 'trg_audit_' || p_table, p_schema, p_table);
  EXECUTE format(
    'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I
       FOR EACH ROW EXECUTE FUNCTION audit.record_change()',
    'trg_audit_' || p_table, p_schema, p_table
  );
END;
$$;

COMMENT ON FUNCTION attach_audit(text, text) IS
  'Attaches the generic audit trigger to a business table. Required for every business table.';

-- ---------------------------------------------------------------------------
-- Tamper-evidence (rule 23 / DD §41)
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit.audit_event
  FOR EACH ROW EXECUTE FUNCTION guard_append_only();

REVOKE ALL   ON audit.audit_event FROM spellzee_app;
GRANT  SELECT ON audit.audit_event TO   spellzee_app;
GRANT  SELECT ON audit.audit_event_default TO spellzee_app;

COMMIT;
