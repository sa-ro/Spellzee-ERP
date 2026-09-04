-- 0023_reschedule_request.sql
-- reschedule_request -- Phase 1 entity (CLAUDE.md §5 "Operations & Delivery").
--
-- Distinct from `compensation` (0021): a reschedule MOVES the same
-- entitlement to a new time (the original session's status becomes
-- 'rescheduled', session.rescheduled_to_session_id points at the new one),
-- while a compensation session is a separate ADDITIONAL session alongside an
-- original that stays exactly as scheduled (rule 18). Both produce a new
-- `session` row with session_purpose='replacement'/'compensation'
-- respectively -- never edit the original session's scheduled_start_at in
-- place (rule 11).
--
-- Sources: rule 17 (never silently lost/forgiven), the cancellation-cutoff
-- policy (CLAUDE.md §4 accepted defaults: 24h, outside=protected/
-- inside=consumed), rule 20 (max 3 reschedules per subscription -- policy,
-- enforced by the service layer reading policy_parameter, not a DB CHECK,
-- since it requires counting existing rows).

BEGIN;

CREATE TABLE reschedule_request (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  session_id              uuid NOT NULL REFERENCES session(id),
  -- Nullable until fulfilled -- a 'pending'/'rejected' request never gets one.
  new_session_id          uuid REFERENCES session(id),
  subscription_id         uuid NOT NULL REFERENCES subscription(id),

  requested_new_start_at  timestamptz NOT NULL,
  requested_new_end_at    timestamptz NOT NULL,

  -- Which side of the cancellation cutoff this fell on when decided --
  -- determines the ledger consequence (protected vs consumed).
  cutoff_status           text NOT NULL,
  status                  text NOT NULL DEFAULT 'pending',
  reason                  text NOT NULL,

  requested_by            uuid NOT NULL REFERENCES user_account(id),
  approved_by             uuid REFERENCES user_account(id),

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NOT NULL REFERENCES user_account(id),
  updated_by              uuid NOT NULL REFERENCES user_account(id),
  source                  text NOT NULL DEFAULT 'ui',

  CONSTRAINT reschedule_request_cutoff_status_valid CHECK (
    cutoff_status IN ('outside_cutoff','inside_cutoff')
  ),
  CONSTRAINT reschedule_request_status_valid CHECK (
    status IN ('pending','approved','fulfilled','rejected','cancelled')
  ),
  CONSTRAINT reschedule_request_reason_present CHECK (btrim(reason) <> ''),
  CONSTRAINT reschedule_request_time_order CHECK (requested_new_end_at > requested_new_start_at),
  CONSTRAINT reschedule_request_fulfilled_has_new_session CHECK (
    status <> 'fulfilled' OR new_session_id IS NOT NULL
  )
);

COMMENT ON TABLE reschedule_request IS
  'One request to move a session to a new time. Multiple rows per session_id '
  'are allowed -- a session can legitimately be rescheduled more than once '
  'over its life; each attempt is its own auditable record (rule 21).';

CREATE INDEX reschedule_request_session_idx ON reschedule_request (session_id);
CREATE INDEX reschedule_request_subscription_idx ON reschedule_request (subscription_id);
CREATE INDEX reschedule_request_pending_idx ON reschedule_request (status) WHERE status = 'pending';

COMMIT;
