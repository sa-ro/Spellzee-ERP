-- 0021_compensation.sql
-- compensation -- DD-listed Phase 1 entity. Rule 18: "A compensation session
-- is a separate, additional session linked to the original affected session.
-- It MUST NOT modify or reschedule the original recurring schedule." Rule 19:
-- teacher/Spellzee-side failure protects entitlement and triggers this.
--
-- SCOPE NOTE: `compensation` is not in the identifier-prefix table (CLAUDE.md
-- §3) -- no public_id. This migration is schema only; the WORKFLOW that
-- creates a compensation record + session + ledger entry together is
-- packages/db/src/services/compensation.service.ts (next migration file has
-- no code, the service is application code, not SQL).

BEGIN;

CREATE TABLE compensation (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The missed/failed session (rule 19's qualifying outcome) and the new,
  -- additional session created to make up for it. Two DIFFERENT session rows
  -- -- rule 18's "separate, additional session", never the same row reused.
  original_session_id      uuid NOT NULL REFERENCES session(id),
  compensation_session_id  uuid NOT NULL REFERENCES session(id),
  subscription_id          uuid NOT NULL REFERENCES subscription(id),

  -- Mirrors the qualifying session.outcome value that triggered this record.
  reason_code               text NOT NULL,
  status                    text NOT NULL DEFAULT 'scheduled',
  -- Compensation validity period (policy_parameter, rule 28) -- the date by
  -- which the compensation session must occur.
  validity_deadline         date NOT NULL,

  -- The session_credit_ledger 'protected' entry recorded for the original
  -- session when this compensation was created -- links the two append-only
  -- and effective-dated worlds together without either referencing the other
  -- circularly (session_credit_ledger doesn't know about compensation).
  protected_ledger_entry_id uuid REFERENCES session_credit_ledger(id),

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NOT NULL REFERENCES user_account(id),
  updated_by                uuid NOT NULL REFERENCES user_account(id),
  source                    text NOT NULL DEFAULT 'ui',

  CONSTRAINT compensation_distinct_sessions CHECK (original_session_id <> compensation_session_id),
  CONSTRAINT compensation_status_valid CHECK (status IN ('scheduled','completed','cancelled','expired')),
  CONSTRAINT compensation_reason_present CHECK (btrim(reason_code) <> '')
);

COMMENT ON TABLE compensation IS
  'Links an original (missed, teacher/Spellzee-fault) session to the separate '
  'additional session created to make it up. Never touches class_schedule '
  '(rule 18) -- the compensation session reuses the original class_schedule_id '
  'purely as an FK reference, not a modification.';

-- At most one compensation record per original session -- one-shot; if a
-- compensation session itself later needs rescheduling, that is a
-- reschedule_request against the compensation session, not a second
-- compensation record against the same original.
CREATE UNIQUE INDEX compensation_original_session_uq ON compensation (original_session_id);
CREATE INDEX compensation_subscription_idx ON compensation (subscription_id);
CREATE INDEX compensation_deadline_idx ON compensation (validity_deadline) WHERE status = 'scheduled';

COMMIT;
