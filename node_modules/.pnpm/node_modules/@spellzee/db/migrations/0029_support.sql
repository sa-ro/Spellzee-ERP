-- 0029_support.sql
-- ticket, sla_policy, sla_instance -- Phase 1 "Support" entities (CLAUDE.md §5).
--
-- ticket is polymorphic (entity_type/entity_id) -- it can concern a student,
-- session, subscription, teacher, etc. without a table per ticket-subject.
-- sla_policy/sla_instance are a GENERIC SLA engine, not ticket-specific --
-- entity_type/entity_id on sla_instance let the same mechanism cover other
-- SLA-bearing entities later (e.g. admission_handover) without a redesign,
-- though admission_handover currently keeps its own sla_deadline_at column
-- (0027) rather than being retrofitted onto this engine in Phase 1.

BEGIN;

-- ---------------------------------------------------------------------------
-- sla_policy -- CLAUDE.md §4 accepted default: ticket SLA 48h, warn 36h.
-- ---------------------------------------------------------------------------
CREATE TABLE sla_policy (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  entity_type    text NOT NULL,
  policy_code    text NOT NULL UNIQUE,
  warn_hours     integer NOT NULL,
  breach_hours   integer NOT NULL,
  escalate_to_role_id uuid REFERENCES role(id),
  is_active      boolean NOT NULL DEFAULT true,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES user_account(id),
  updated_by     uuid NOT NULL REFERENCES user_account(id),

  CONSTRAINT sla_policy_hours_positive CHECK (warn_hours > 0 AND breach_hours > 0),
  CONSTRAINT sla_policy_warn_before_breach CHECK (warn_hours < breach_hours)
);

COMMENT ON TABLE sla_policy IS
  'Named SLA definition (warn/breach hours + escalation role). Ticket default: '
  '36h warn / 48h breach, escalate to Team Lead (CLAUDE.md §4).';

-- ---------------------------------------------------------------------------
-- ticket -- DD-listed Phase 1 entity.
-- ---------------------------------------------------------------------------
CREATE TABLE ticket (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id      text NOT NULL UNIQUE DEFAULT next_public_id('TKT'),

  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,

  category       text NOT NULL,
  subject        text NOT NULL,
  description    text NOT NULL,
  priority       text NOT NULL DEFAULT 'normal',
  status         text NOT NULL DEFAULT 'open',

  raised_by      uuid NOT NULL REFERENCES user_account(id),
  assigned_to    uuid REFERENCES employee(id),

  resolved_at    timestamptz,
  resolution_notes text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES user_account(id),
  updated_by     uuid NOT NULL REFERENCES user_account(id),
  source         text NOT NULL DEFAULT 'ui',

  CONSTRAINT ticket_public_id_format CHECK (public_id ~ '^TKT-\d{4}-\d{6}$'),
  CONSTRAINT ticket_priority_valid CHECK (priority IN ('low','normal','high','urgent')),
  CONSTRAINT ticket_status_valid CHECK (
    status IN ('open','in_progress','resolved','closed','reopened')
  ),
  CONSTRAINT ticket_resolved_has_timestamp CHECK (
    status NOT IN ('resolved','closed') OR resolved_at IS NOT NULL
  )
);

COMMENT ON TABLE ticket IS
  'Operational issue/request. entity_type/entity_id points at whatever the '
  'ticket concerns (student, session, subscription, teacher, ...) -- a '
  'conversation is a channel, a ticket is a tracked issue with owner/SLA/'
  'resolution (rule 10).';

CREATE INDEX ticket_entity_idx ON ticket (entity_type, entity_id);
CREATE INDEX ticket_open_idx ON ticket (status) WHERE status IN ('open','in_progress','reopened');
CREATE INDEX ticket_assignee_idx ON ticket (assigned_to);

-- ---------------------------------------------------------------------------
-- sla_instance -- one running SLA clock per (entity_type, entity_id).
-- ---------------------------------------------------------------------------
CREATE TABLE sla_instance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  sla_policy_id  uuid NOT NULL REFERENCES sla_policy(id),
  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,

  started_at     timestamptz NOT NULL DEFAULT now(),
  warn_at        timestamptz NOT NULL,
  breach_at      timestamptz NOT NULL,

  status         text NOT NULL DEFAULT 'active',
  resolved_at    timestamptz,
  escalated_at   timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES user_account(id),
  updated_by     uuid NOT NULL REFERENCES user_account(id),

  CONSTRAINT sla_instance_status_valid CHECK (
    status IN ('active','warned','breached','resolved','cancelled')
  ),
  CONSTRAINT sla_instance_breach_after_warn CHECK (breach_at > warn_at),
  CONSTRAINT sla_instance_warn_after_start CHECK (warn_at > started_at)
);

COMMENT ON TABLE sla_instance IS
  'One SLA clock per (entity_type, entity_id) at a time -- at most one active/'
  'warned instance per subject (sla_instance_active_uq).';

-- At most one active-or-warned instance per subject.
CREATE UNIQUE INDEX sla_instance_active_uq
  ON sla_instance (entity_type, entity_id) WHERE status IN ('active','warned');

CREATE INDEX sla_instance_entity_idx ON sla_instance (entity_type, entity_id);
CREATE INDEX sla_instance_breach_check_idx ON sla_instance (breach_at) WHERE status IN ('active','warned');
CREATE INDEX sla_instance_warn_check_idx ON sla_instance (warn_at) WHERE status = 'active';

COMMIT;
