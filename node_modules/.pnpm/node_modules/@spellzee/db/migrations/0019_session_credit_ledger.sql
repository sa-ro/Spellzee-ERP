-- 0019_session_credit_ledger.sql
-- session_credit_ledger -- CLAUDE.md §5 layer 3 (append-only ledger).
--
-- Sources: rule 16 (a subscription has a defined entitlement), rule 17 (a
-- purchased session is never silently lost, a missed one never silently
-- forgiven), rule 18 (a compensation session is separate/additional, linked
-- to the original -- it must NOT modify the original recurring schedule),
-- DD §10/§41 (append-only, corrections are new compensating entries).
--
-- SCOPE NOTE: this migration is schema only -- the ledger table, its
-- constraints, and the append-only guard. It deliberately does NOT include:
--   * Materialized subscription balance columns (scheduled/completed/
--     consumed/protected/remaining) -- CLAUDE.md §5 layer 3 describes these
--     as "derived sums, materialized for speed but always reconcilable from
--     the ledger." The materialization is a read-path optimization for the
--     next batch (compensation/session-outcome service layer), not required
--     for the ledger's own correctness -- `sum(amount)` is already correct
--     today, as the test suite proves.
--   * Any service-layer logic that WRITES entries (session completion,
--     teacher-absence compensation, goodwill exceptions). That is the
--     explicitly deferred compensation/session-outcome batch.

BEGIN;

CREATE TABLE session_credit_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  subscription_id    uuid NOT NULL REFERENCES subscription(id),

  -- Signed entry. Sign is enforced per entry_type below, matching CLAUDE.md
  -- §5's "+purchased, -consumed, +protected, -compensated, ±adjusted".
  entry_type         text NOT NULL,
  amount             integer NOT NULL,
  reason_code        text NOT NULL,

  -- Nullable: a purchase or a manual adjustment isn't always tied to one
  -- session occurrence; consumed/compensated entries normally are.
  session_id         uuid REFERENCES session(id),
  -- The policy_parameter row in force when this entry was decided (rule 28) --
  -- e.g. which compensation-validity-period value governed a 'compensated'
  -- entry. Nullable because not every entry is policy-driven (a raw purchase
  -- isn't).
  policy_version_id  uuid REFERENCES policy_parameter(id),
  -- Set when this entry required maker-checker sign-off (e.g. a goodwill
  -- exception or a manual adjustment) -- DD §39, rule 22.
  approval_id        uuid REFERENCES approval_request(id),

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES user_account(id),
  source             text NOT NULL DEFAULT 'ui',

  CONSTRAINT session_credit_ledger_entry_type_valid CHECK (
    entry_type IN ('purchased','consumed','protected','compensated','adjusted')
  ),
  CONSTRAINT session_credit_ledger_reason_code_present CHECK (btrim(reason_code) <> ''),
  -- The sign-per-type guarantee: rule 17's "never silently lost / never
  -- silently forgiven" depends on credits and debits being structurally
  -- distinguishable, not just conventionally so.
  CONSTRAINT session_credit_ledger_sign_matches_type CHECK (
    (entry_type IN ('purchased','protected') AND amount > 0)
    OR (entry_type IN ('consumed','compensated') AND amount < 0)
    OR (entry_type = 'adjusted' AND amount <> 0)
  )
);

COMMENT ON TABLE session_credit_ledger IS
  'Append-only. A subscription''s entitlement balance is sum(amount) over its '
  'rows -- always reconcilable, never a value stored and silently drifted '
  'from its own history (rule 17, CLAUDE.md §5 layer 3).';
COMMENT ON COLUMN session_credit_ledger.entry_type IS
  'purchased/protected are credits (positive); consumed/compensated are '
  'debits (negative); adjusted is a signed correction. A correction to a past '
  'entry is a NEW adjusted row, never an edit of the original (rule 14).';

CREATE INDEX session_credit_ledger_subscription_idx ON session_credit_ledger (subscription_id, created_at);
CREATE INDEX session_credit_ledger_session_idx ON session_credit_ledger (session_id) WHERE session_id IS NOT NULL;

-- Append-only: reject UPDATE and DELETE outright, regardless of role --
-- reuses the same guard_append_only() primitive already protecting
-- audit.audit_event (0002), rather than inventing a new mechanism.
CREATE TRIGGER trg_session_credit_ledger_append_only
  BEFORE UPDATE OR DELETE ON session_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION guard_append_only();

-- Still audited (rule 21) -- attach_audit() captures the INSERT as an
-- audit_event row; the append-only trigger above ensures there is never a
-- subsequent UPDATE/DELETE for it to capture.
SELECT attach_audit('session_credit_ledger');

-- The application can never UPDATE or DELETE ledger rows -- INSERT only.
REVOKE UPDATE, DELETE ON session_credit_ledger FROM spellzee_app;

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO spellzee_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO spellzee_app;

COMMIT;
