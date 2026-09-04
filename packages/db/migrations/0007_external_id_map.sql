-- 0007_external_id_map.sql
-- External ID Mapping -- DD §42.
--
-- The single crossing point between Spellzee identifiers and every external system
-- (Merithub, TeliCRM, Delicio, FreeJump, payment providers). Rule 26: external IDs
-- never replace Spellzee core IDs, and no core table carries an external ID column.
--
-- Enforced by CI (see scripts/check-no-external-id-columns.sql) as well as convention.

BEGIN;

CREATE TABLE external_id_map (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Spellzee side. No FK: the mapping is generic across entity types, and a mapping
  -- must survive its subject's archival for reconciliation purposes.
  spellzee_entity_type text NOT NULL,
  spellzee_id          uuid NOT NULL,
  spellzee_public_id   text,

  -- External side
  external_system      text NOT NULL,
  external_entity_type text,
  external_id          text NOT NULL,

  status               text NOT NULL DEFAULT 'active',

  -- Integration monitoring (DD §42)
  last_sync_at         timestamptz,
  sync_status          text NOT NULL DEFAULT 'pending',
  sync_error           text,
  sync_attempts        integer NOT NULL DEFAULT 0,

  -- Raw payload from the provider at mapping time. Useful for reconciliation when
  -- a provider changes its ID scheme.
  external_payload     jsonb,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL REFERENCES user_account(id),
  updated_by           uuid NOT NULL REFERENCES user_account(id),
  source               text NOT NULL DEFAULT 'api',

  CONSTRAINT external_id_map_entity_type_valid CHECK (
    spellzee_entity_type IN (
      'student','parent_guardian','enrollment','subscription','payment',
      'teacher','class_schedule','session','employee'
    )
  ),
  CONSTRAINT external_id_map_system_valid CHECK (
    external_system IN ('merithub','telicrm','delicio','freejump','whatsapp','payment_gateway')
  ),
  CONSTRAINT external_id_map_status_valid CHECK (status IN ('active','revoked','superseded')),
  CONSTRAINT external_id_map_sync_status_valid CHECK (
    sync_status IN ('pending','synced','error','stale')
  ),
  CONSTRAINT external_id_map_error_explained CHECK (
    sync_status <> 'error' OR sync_error IS NOT NULL
  )
);

COMMENT ON TABLE external_id_map IS
  'Maps Spellzee identifiers to external system identifiers. DD §42. The ONLY place an '
  'external identifier exists -- no core table carries a merithub/telicrm column (rule 26).';
COMMENT ON COLUMN external_id_map.spellzee_id IS
  'Intentionally not a foreign key: generic across entity types, and must outlive archival.';

-- One active mapping per (Spellzee record, external system, external entity type).
CREATE UNIQUE INDEX external_id_map_spellzee_uq
  ON external_id_map (spellzee_entity_type, spellzee_id, external_system, coalesce(external_entity_type, ''))
  WHERE status = 'active';

-- DD §47: "external ID uniqueness per provider" -- one external ID maps to one
-- Spellzee record, not several.
CREATE UNIQUE INDEX external_id_map_external_uq
  ON external_id_map (external_system, coalesce(external_entity_type, ''), external_id)
  WHERE status = 'active';

CREATE INDEX external_id_map_lookup_idx  ON external_id_map (external_system, external_id);
CREATE INDEX external_id_map_spellzee_idx ON external_id_map (spellzee_entity_type, spellzee_id);
CREATE INDEX external_id_map_failing_idx  ON external_id_map (sync_status, last_sync_at)
  WHERE sync_status IN ('error','stale');

COMMIT;
