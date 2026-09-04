-- 0017_policy_outbox_notification.sql
-- Governance & Platform batch 4: policy_parameter, outbox_event, notification.
--
-- Sources: rule 28 (configurable policy, versioned decisions), CLAUDE.md §5
-- layer 4 (transactional outbox), rule 27 (integration failures visible/
-- retryable), Master §30 (the ~20 open policy parameters).
--
-- SCOPE NOTE: none of these three entities are in the identifier-prefix table
-- (CLAUDE.md §3) -- they are internal/operational records, not business
-- entities a human looks up by a Spellzee-issued ID. No public_id column.

BEGIN;

-- ---------------------------------------------------------------------------
-- policy_parameter -- rule 28. Effective-dated (layer 2 history): a policy
-- change supersedes the previous value rather than editing it in place, so a
-- decision record made under the old value stays interpretable (rule 28's
-- "stamp the rule/criteria version" requirement is satisfied by joining to the
-- row that was current at decision time, not a separate version column).
-- ---------------------------------------------------------------------------
CREATE TABLE policy_parameter (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  key              text NOT NULL,
  value            jsonb NOT NULL,
  description      text,

  -- CLAUDE.md "Accepted working defaults": an unratified engineering default
  -- must never be presented as company policy on a report or parent-facing
  -- surface. This column is how a reader tells the difference.
  source           text NOT NULL DEFAULT 'engineering_default',
  ratified_at      timestamptz,
  ratified_by      uuid REFERENCES user_account(id),

  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,
  is_current       boolean NOT NULL DEFAULT true,
  superseded_by_id uuid REFERENCES policy_parameter(id),
  change_reason    text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES user_account(id),
  updated_by       uuid NOT NULL REFERENCES user_account(id),

  CONSTRAINT policy_parameter_source_valid CHECK (source IN ('engineering_default','business_ratified')),
  CONSTRAINT policy_parameter_ratification_complete CHECK (
    (source = 'engineering_default' AND ratified_at IS NULL AND ratified_by IS NULL)
    OR (source = 'business_ratified' AND ratified_at IS NOT NULL AND ratified_by IS NOT NULL)
  ),
  CONSTRAINT policy_parameter_period_sane CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT policy_parameter_current_open CHECK (
    (is_current AND valid_to IS NULL AND superseded_by_id IS NULL) OR (NOT is_current)
  ),
  CONSTRAINT policy_parameter_not_self_superseded CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
);

COMMENT ON TABLE policy_parameter IS
  'Every configurable business rule (cancellation cutoff, SLA hours, reschedule '
  'limits, attendance thresholds, etc. -- Master §30) as an effective-dated row, '
  'never a hard-coded constant (rule 28).';
COMMENT ON COLUMN policy_parameter.source IS
  'engineering_default = a working assumption seeded so development is not '
  'blocked; business_ratified = management actually confirmed this value. Never '
  'conflate the two on a report or parent-facing surface (CLAUDE.md §4).';

-- At most one current value per key.
CREATE UNIQUE INDEX policy_parameter_current_uq
  ON policy_parameter (key) WHERE is_current;

CREATE INDEX policy_parameter_history_idx ON policy_parameter (key, valid_from);

-- ---------------------------------------------------------------------------
-- outbox_event -- CLAUDE.md §5 layer 4. Written in the SAME transaction as the
-- business change that triggers an external side effect; a BullMQ worker
-- drains it. Never deleted -- failures must stay reconstructable (rule 27).
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  aggregate_type   text NOT NULL,
  aggregate_id     uuid NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id   uuid,

  status           text NOT NULL DEFAULT 'pending',
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 5,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  processed_at     timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES user_account(id),

  CONSTRAINT outbox_event_status_valid CHECK (
    status IN ('pending','processing','sent','failed','dead_letter')
  ),
  CONSTRAINT outbox_event_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT outbox_event_max_attempts_positive CHECK (max_attempts > 0),
  -- A row cannot land in a terminal failure state with no explanation --
  -- rule 27's "failures are visible" enforced structurally, not just by
  -- worker-code convention.
  CONSTRAINT outbox_event_failure_reason_required CHECK (
    status NOT IN ('failed','dead_letter') OR last_error IS NOT NULL
  ),
  CONSTRAINT outbox_event_processed_when_terminal CHECK (
    status NOT IN ('sent','dead_letter') OR processed_at IS NOT NULL
  )
);

COMMENT ON TABLE outbox_event IS
  'Transactional outbox. Written in the same transaction as the business '
  'change; the worker that drains this table never fires an external call '
  'synchronously inside a request/business transaction (Engineering Priorities: '
  'scalability shape) or leaves a failure silent (rule 27).';

CREATE INDEX outbox_event_dispatch_idx ON outbox_event (next_attempt_at)
  WHERE status IN ('pending','failed');
CREATE INDEX outbox_event_aggregate_idx ON outbox_event (aggregate_type, aggregate_id);

-- ---------------------------------------------------------------------------
-- notification
-- ---------------------------------------------------------------------------
CREATE TABLE notification (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Polymorphic recipient (not every recipient is a user_account -- a parent
  -- or student contacted via WhatsApp/SMS has no login). Two-column addressing
  -- rather than a shared person master, consistent with CLAUDE.md's confirmed
  -- "Student vs Employee: separate, no shared person master" decision extended
  -- to notification recipients generally.
  recipient_type  text NOT NULL,
  recipient_id    uuid NOT NULL,

  channel         text NOT NULL,
  template_code   text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,

  status          text NOT NULL DEFAULT 'pending',
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  failure_reason  text,

  -- Dispatch goes through the same outbox worker path as any other external
  -- side effect -- a notification is never fired synchronously either.
  outbox_event_id uuid REFERENCES outbox_event(id),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES user_account(id),
  updated_by      uuid NOT NULL REFERENCES user_account(id),

  CONSTRAINT notification_channel_valid CHECK (
    channel IN ('email','sms','whatsapp','in_app','push')
  ),
  CONSTRAINT notification_status_valid CHECK (
    status IN ('pending','sent','delivered','failed','cancelled')
  ),
  CONSTRAINT notification_failure_reason_required CHECK (
    status <> 'failed' OR failure_reason IS NOT NULL
  ),
  CONSTRAINT notification_sent_at_present CHECK (
    status NOT IN ('sent','delivered') OR sent_at IS NOT NULL
  )
);

COMMENT ON TABLE notification IS
  'Reminder/status dispatch record (session reminders at 3h/30min, SLA '
  'breach alerts, etc.). recipient_type/recipient_id address whoever should '
  'receive it -- not necessarily a user_account.';

CREATE INDEX notification_recipient_idx ON notification (recipient_type, recipient_id);
CREATE INDEX notification_pending_idx ON notification (scheduled_for) WHERE status = 'pending';

COMMIT;
