-- 0011_coordinator_ownership.sql
-- Coordinator Ownership -- DD §14.
--
-- "Ownership must be explicit. The system should never rely on employees
-- remembering who is responsible." (Master §9)
--
-- Effective-dated per M3 (docs/data-model 01, decision M3): a transfer closes
-- the old row and opens a new one. Rule 12 (DD §43): "Coordinator ownership
-- changes create history." At most one CURRENT row per (student, role) --
-- a student legitimately has a live onboarding owner and a live ticket owner
-- simultaneously, but not two live onboarding owners.
--
-- `related_ticket_id` (DD §14 "Related workflow/ticket") is deliberately
-- omitted: the ticket entity does not exist yet (Support module, not yet
-- built). DD §1 -- "fields marked as examples are not automatically
-- mandatory." Add the column when ticket lands.

BEGIN;

CREATE TABLE coordinator_ownership (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  student_id          uuid NOT NULL REFERENCES student(id),
  parent_guardian_id  uuid REFERENCES parent_guardian(id),
  employee_id         uuid NOT NULL REFERENCES employee(id),

  ownership_role      text NOT NULL,
  escalation_level    integer,

  -- M3 effective-dating columns.
  valid_from          timestamptz NOT NULL DEFAULT now(),
  valid_to            timestamptz,
  is_current          boolean NOT NULL DEFAULT true,
  superseded_by_id    uuid REFERENCES coordinator_ownership(id),
  -- Mandatory on the OLD row when a transfer supersedes it (DD §14 "Ownership
  -- transfer reason"); NULL on a fresh assignment with no prior owner.
  change_reason       text,

  requested_by        uuid NOT NULL REFERENCES user_account(id),
  -- Ownership transfers are routine operational reassignment, not a
  -- maker-checker action under Master §22.4's illustrative matrix (which lists
  -- teacher change, refunds, merges and historical corrections -- not
  -- ownership handover). Left optional rather than mandatory; revisit if the
  -- business later requires approval here.
  approved_by         uuid REFERENCES user_account(id),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES user_account(id),
  updated_by          uuid NOT NULL REFERENCES user_account(id),
  source              text NOT NULL DEFAULT 'ui',

  CONSTRAINT coordinator_ownership_role_valid CHECK (
    ownership_role IN ('onboarding','student_success','retention','operations','academic','ticket','escalation')
  ),
  CONSTRAINT coordinator_ownership_period_sane CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT coordinator_ownership_current_open CHECK (
    (is_current AND valid_to IS NULL AND superseded_by_id IS NULL) OR (NOT is_current)
  ),
  CONSTRAINT coordinator_ownership_not_self_superseded CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
  CONSTRAINT coordinator_ownership_escalation_only_for_escalation CHECK (
    escalation_level IS NULL OR ownership_role = 'escalation'
  )
);

COMMENT ON TABLE coordinator_ownership IS
  'Explicit, effective-dated ownership of a student relationship. DD §14, rule 12. '
  'A transfer INSERTs a new row and closes the old one -- never UPDATEs the role in place.';
COMMENT ON COLUMN coordinator_ownership.ownership_role IS
  'Lifecycle responsibility type (Master §9): onboarding, student_success, retention, '
  'operations, academic, ticket, escalation. A student may have one current owner PER ROLE.';

-- At most one current row per (student, role) -- the core invariant (DD §14).
CREATE UNIQUE INDEX coordinator_ownership_current_uq
  ON coordinator_ownership (student_id, ownership_role) WHERE is_current;

CREATE INDEX coordinator_ownership_student_idx ON coordinator_ownership (student_id);
CREATE INDEX coordinator_ownership_employee_idx ON coordinator_ownership (employee_id) WHERE is_current;
CREATE INDEX coordinator_ownership_history_idx ON coordinator_ownership (student_id, ownership_role, valid_from);

COMMIT;
