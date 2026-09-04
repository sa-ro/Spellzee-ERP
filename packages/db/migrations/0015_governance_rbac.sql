-- 0015_governance_rbac.sql
-- Governance & Platform batch 3: role, permission, role_permission, user_role,
-- user_session, approval_request, plus MFA columns on the pre-existing minimal
-- user_account (0003).
--
-- Sources: DD §38-41 (RBAC/session/audit), DD §39 (approval_request), Master §22
-- (governance, maker-checker, RBAC), rules 21-25.
--
-- SCOPE NOTE:
--   * CASL `team`/`department` scopes need an org hierarchy the source docs
--     haven't defined yet (Master §30, open decision). Phase 1 ships `own` and
--     `all` only on user_role.scope, per the confirmed stack decision recorded
--     in CLAUDE.md. The column accepts only those two values today; widening it
--     later is a new migration, not a silent CHECK relaxation.
--   * TOTP secret storage: `totp_secret_encrypted` is application-encrypted
--     opaque text (KMS/envelope encryption is an apps/api concern, not a DB
--     concern) — this migration only enforces that a secret must exist whenever
--     mfa_enabled is true.
--   * No RLS policies here. CLAUDE.md's confirmed stack scopes Postgres RLS to
--     audit_event only in Phase 1; RBAC enforcement at these tables is via
--     grants + CASL in the application layer, per the same decision.

BEGIN;

-- ---------------------------------------------------------------------------
-- user_account -- add MFA columns to the 0003 minimal table
-- ---------------------------------------------------------------------------
ALTER TABLE user_account
  ADD COLUMN mfa_enabled            boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_secret_encrypted  text,
  ADD COLUMN last_login_at          timestamptz;

ALTER TABLE user_account
  ADD CONSTRAINT user_account_mfa_secret_required
  CHECK (NOT mfa_enabled OR totp_secret_encrypted IS NOT NULL);

COMMENT ON COLUMN user_account.mfa_enabled IS
  'TOTP MFA is mandatory for Finance / Restricted Admin / any approver role '
  '(CLAUDE.md confirmed stack) -- enforced at the application/CASL layer by role, '
  'not by a DB constraint tied to role membership. This CHECK only guarantees a '
  'flag cannot be true with no secret behind it.';

-- ---------------------------------------------------------------------------
-- role / permission / role_permission -- DD §40
-- ---------------------------------------------------------------------------
CREATE TABLE role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE role IS
  'Named collection of permissions. Rule 24: permission is separate from business '
  'hierarchy -- seniority alone never grants a role.';
COMMENT ON COLUMN role.is_system IS
  'True for roles the application depends on structurally (cannot be deleted via '
  'ordinary admin UI). Distinguishes seed roles from custom ones.';

CREATE TABLE permission (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  resource    text NOT NULL,
  action      text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE permission IS
  'Atomic (resource, action) capability, compiled into CASL abilities per session '
  '(CLAUDE.md confirmed stack: DB-driven RBAC compiled into CASL).';

-- role_permission is a current-state capability mapping, not a transactional
-- record -- same deliberate exception as teacher_subject/teacher_level/
-- teacher_language (0009): ordinary DELETE is allowed; the generic audit
-- trigger below still captures every add/remove as an audit_event row, so the
-- change remains attributable (rule 21) even though the join row itself isn't
-- kept.
CREATE TABLE role_permission (
  -- Own uuid PK (not a composite PK on role_id/permission_id) so attach_audit()'s
  -- assumption of a NEW.id column holds -- same shape as teacher_subject (0009).
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id       uuid NOT NULL REFERENCES role(id),
  permission_id uuid NOT NULL REFERENCES permission(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES user_account(id),
  CONSTRAINT role_permission_uq UNIQUE (role_id, permission_id)
);

CREATE INDEX role_permission_permission_idx ON role_permission (permission_id);

-- ---------------------------------------------------------------------------
-- user_role -- effective-dated (layer 2 history), NOT a plain join table.
--
-- A role grant is a security-sensitive event with a past that matters (rule
-- 21, rule 24) -- unlike role_permission's catalog-config shape, who-has-which-
-- role must supersede, not silently disappear. Same pattern as
-- teacher_allocation / coordinator_ownership.
-- ---------------------------------------------------------------------------
CREATE TABLE user_role (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_account_id  uuid NOT NULL REFERENCES user_account(id),
  role_id          uuid NOT NULL REFERENCES role(id),
  -- Phase 1 ships 'own'/'all' only -- see header scope note.
  scope            text NOT NULL DEFAULT 'own',

  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,
  is_current       boolean NOT NULL DEFAULT true,
  superseded_by_id uuid REFERENCES user_role(id),
  change_reason    text,
  granted_by       uuid NOT NULL REFERENCES user_account(id),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES user_account(id),
  updated_by       uuid NOT NULL REFERENCES user_account(id),

  CONSTRAINT user_role_scope_valid CHECK (scope IN ('own','all')),
  CONSTRAINT user_role_period_sane CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT user_role_current_open CHECK (
    (is_current AND valid_to IS NULL AND superseded_by_id IS NULL) OR (NOT is_current)
  ),
  CONSTRAINT user_role_not_self_superseded CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
);

COMMENT ON TABLE user_role IS
  'Effective-dated role assignment. A revoke/re-grant supersedes the previous row '
  '(rule 12) rather than deleting it -- who held what access, and when, must '
  'remain reconstructable.';

-- At most one current assignment of a given role to a given user.
CREATE UNIQUE INDEX user_role_current_uq
  ON user_role (user_account_id, role_id) WHERE is_current;

CREATE INDEX user_role_user_idx ON user_role (user_account_id) WHERE is_current;
CREATE INDEX user_role_history_idx ON user_role (user_account_id, role_id, valid_from);

-- ---------------------------------------------------------------------------
-- user_session -- DD §41: audit_event requires session/IP/device metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE user_session (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_account_id uuid NOT NULL REFERENCES user_account(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoke_reason   text,

  ip_address      inet,
  user_agent      text,
  mfa_verified_at timestamptz,

  CONSTRAINT user_session_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT user_session_revoke_reason_required CHECK (
    revoked_at IS NULL OR revoke_reason IS NOT NULL
  )
);

COMMENT ON TABLE user_session IS
  'Server-side opaque session record (CLAUDE.md confirmed stack: httpOnly cookie, '
  'Redis-backed at runtime; this table is the durable/auditable record). Sessions '
  'are revoked, never deleted -- a role change or employee exit must bind on the '
  'next request against a live session row (CLAUDE.md rationale for server-side '
  'sessions over JWT).';

CREATE INDEX user_session_user_idx ON user_session (user_account_id);
CREATE INDEX user_session_active_idx ON user_session (user_account_id, expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- approval_request -- DD §39, the maker-checker infrastructure table.
-- ---------------------------------------------------------------------------
CREATE TABLE approval_request (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id      text NOT NULL UNIQUE DEFAULT next_public_id('APR'),

  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,
  action         text NOT NULL,
  -- The proposed change, captured at request time so the checker reviews the
  -- actual intended new state, not just a description of it.
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason         text NOT NULL,

  status         text NOT NULL DEFAULT 'pending',
  requested_by   uuid NOT NULL REFERENCES user_account(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  approved_by    uuid REFERENCES user_account(id),
  decided_at     timestamptz,
  decision_reason text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES user_account(id),
  updated_by     uuid NOT NULL REFERENCES user_account(id),

  CONSTRAINT approval_request_public_id_format CHECK (public_id ~ '^APR-\d{4}-\d{6}$'),
  CONSTRAINT approval_request_status_valid CHECK (
    status IN ('pending','approved','rejected','cancelled')
  ),
  CONSTRAINT approval_request_reason_present CHECK (btrim(reason) <> ''),
  CONSTRAINT approval_request_decision_complete CHECK (
    (status = 'pending' AND approved_by IS NULL AND decided_at IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL)
  ),
  -- Rule 22's core guarantee, enforced where it cannot be bypassed: a DB CHECK,
  -- not only an application-layer if-statement.
  CONSTRAINT approval_request_no_self_approval CHECK (
    approved_by IS NULL OR approved_by <> requested_by
  )
);

COMMENT ON TABLE approval_request IS
  'Maker-checker infrastructure (DD §39). The requester and approver are '
  'structurally forbidden from being the same user (rule 22) -- '
  'approval_request_no_self_approval cannot be worked around by any caller with '
  'ordinary UPDATE privilege on this table.';

CREATE INDEX approval_request_pending_idx ON approval_request (status) WHERE status = 'pending';
CREATE INDEX approval_request_entity_idx ON approval_request (entity_type, entity_id);
CREATE INDEX approval_request_requester_idx ON approval_request (requested_by);

COMMIT;
