-- 0006_commercial.sql
-- Enrollment (DD §8), Subscription (DD §9), Payment (DD §10).
--
-- SCOPE NOTE: payment was deferred to Phase 4 in CLAUDE.md §5. It is built here
-- on explicit instruction. CLAUDE.md has been updated to record the change.
--
-- DD §10: "Financial records should be append-oriented where possible: corrections
-- should create controlled adjustments rather than silently rewriting settled
-- transactions." Implemented below as an immutability guard on settled payments
-- plus self-referencing adjustment rows.

BEGIN;

-- ---------------------------------------------------------------------------
-- enrollment -- DD §8
-- "Enrollment represents participation in a particular course/program and is
--  separate from the student and commercial subscription."
-- ---------------------------------------------------------------------------
CREATE TABLE enrollment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id           text NOT NULL UNIQUE DEFAULT next_public_id('ENR'),

  student_id          uuid NOT NULL REFERENCES student(id),

  course_id           uuid NOT NULL REFERENCES course(id),
  subject_id          uuid NOT NULL REFERENCES subject(id),
  level_id            uuid NOT NULL REFERENCES level(id),
  session_type        text NOT NULL DEFAULT 'one_to_one',

  start_date          date NOT NULL,
  expected_end_date   date,
  actual_end_date     date,

  status              text NOT NULL DEFAULT 'pending',
  end_reason          text,

  archived_at         timestamptz,
  archived_by         uuid REFERENCES user_account(id),
  archive_reason      text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES user_account(id),
  updated_by          uuid NOT NULL REFERENCES user_account(id),
  source              text NOT NULL DEFAULT 'ui',

  CONSTRAINT enrollment_public_id_format CHECK (public_id ~ '^ENR-\d{4}-\d{6}$'),
  CONSTRAINT enrollment_session_type_valid CHECK (session_type IN ('one_to_one','group')),
  CONSTRAINT enrollment_status_valid CHECK (
    status IN ('pending','active','paused','completed','cancelled','archived')
  ),
  -- DD §8 requires a reason for cancellation/pause/completion.
  CONSTRAINT enrollment_end_reason_required CHECK (
    status NOT IN ('completed','cancelled','paused') OR end_reason IS NOT NULL
  ),
  CONSTRAINT enrollment_dates_sane CHECK (
    actual_end_date IS NULL OR actual_end_date >= start_date
  ),
  CONSTRAINT enrollment_expected_end_sane CHECK (
    expected_end_date IS NULL OR expected_end_date >= start_date
  ),
  CONSTRAINT enrollment_archive_complete CHECK (
    (status <> 'archived' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL
        AND archived_by IS NOT NULL AND archive_reason IS NOT NULL)
  )
);

COMMENT ON TABLE enrollment IS
  'A student''s participation in a specific course/program. DD §8. Distinct from the '
  'commercial subscription (rule 6). A student may hold several over time and concurrently.';

CREATE INDEX enrollment_student_idx ON enrollment (student_id);
CREATE INDEX enrollment_status_idx  ON enrollment (status);
CREATE INDEX enrollment_active_idx  ON enrollment (student_id) WHERE status = 'active';
CREATE INDEX enrollment_course_idx  ON enrollment (course_id);

-- ---------------------------------------------------------------------------
-- subscription -- DD §9
--
-- The session counts DD §9 lists (scheduled / completed / consumed / protected /
-- remaining) are DERIVED from session_credit_ledger, which arrives with the
-- delivery module. They are deliberately NOT columns here: rule 16 and rule 17
-- depend on the ledger being the single source of truth for entitlement.
-- Only the purchased entitlement -- a term of the sale -- is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE subscription (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id                text NOT NULL UNIQUE DEFAULT next_public_id('SUB'),

  student_id               uuid NOT NULL REFERENCES student(id),
  enrollment_id            uuid REFERENCES enrollment(id),   -- DD §9 "where applicable"

  plan_name                text NOT NULL,
  purchased_session_count  integer NOT NULL,

  -- Money: integer minor units + ISO-4217. Never floats (CLAUDE.md §6).
  price_minor_units        bigint NOT NULL,
  currency                 char(3) NOT NULL DEFAULT 'INR',

  purchase_date            date NOT NULL,
  start_date               date NOT NULL,
  valid_until              date NOT NULL,

  status                   text NOT NULL DEFAULT 'active',

  -- Renewal chain (DD §9 "renewal information").
  renewed_from_subscription_id uuid REFERENCES subscription(id),
  renewed_to_subscription_id   uuid REFERENCES subscription(id),

  -- Retained for records imported before Payment existed, and for external
  -- gateways that are mapped rather than modelled (DD §42).
  external_payment_ref     text,

  cancellation_reason      text,

  archived_at              timestamptz,
  archived_by              uuid REFERENCES user_account(id),
  archive_reason           text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid NOT NULL REFERENCES user_account(id),
  updated_by               uuid NOT NULL REFERENCES user_account(id),
  source                   text NOT NULL DEFAULT 'ui',

  CONSTRAINT subscription_public_id_format CHECK (public_id ~ '^SUB-\d{4}-\d{6}$'),
  CONSTRAINT subscription_status_valid CHECK (
    status IN ('active','exhausted','expired','cancelled','renewed','archived')
  ),
  CONSTRAINT subscription_sessions_positive CHECK (purchased_session_count > 0),
  CONSTRAINT subscription_price_non_negative CHECK (price_minor_units >= 0),
  CONSTRAINT subscription_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT subscription_validity_sane CHECK (valid_until >= start_date),
  CONSTRAINT subscription_cancellation_reason_required CHECK (
    status <> 'cancelled' OR cancellation_reason IS NOT NULL
  ),
  CONSTRAINT subscription_no_self_renewal CHECK (
    renewed_from_subscription_id IS NULL OR renewed_from_subscription_id <> id
  ),
  CONSTRAINT subscription_archive_complete CHECK (
    (status <> 'archived' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL
        AND archived_by IS NOT NULL AND archive_reason IS NOT NULL)
  )
);

COMMENT ON TABLE subscription IS
  'Commercial entitlement purchased for a student. DD §9. Not the student identity and '
  'not a substitute for individual payment records. Session balances are derived from '
  'session_credit_ledger (delivery module), never stored here (rule 16).';
COMMENT ON COLUMN subscription.enrollment_id IS
  'Nullable per DD §9 ("where applicable") -- a subscription may be sold before the '
  'enrollment exists. Must be set before the first session is scheduled.';

CREATE INDEX subscription_student_idx    ON subscription (student_id);
CREATE INDEX subscription_enrollment_idx ON subscription (enrollment_id) WHERE enrollment_id IS NOT NULL;
CREATE INDEX subscription_status_idx     ON subscription (status);
CREATE INDEX subscription_expiry_idx     ON subscription (valid_until) WHERE status = 'active';

-- A subscription must belong to the same student as its enrollment. Without this,
-- one student's entitlement could silently fund another's classes.
CREATE OR REPLACE FUNCTION guard_subscription_student_matches_enrollment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_enrollment_student uuid;
BEGIN
  IF NEW.enrollment_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT student_id INTO v_enrollment_student FROM enrollment WHERE id = NEW.enrollment_id;
  IF v_enrollment_student <> NEW.student_id THEN
    RAISE EXCEPTION
      'Subscription student % does not match enrollment % student %.',
      NEW.student_id, NEW.enrollment_id, v_enrollment_student
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_subscription_student_consistent
  BEFORE INSERT OR UPDATE OF student_id, enrollment_id ON subscription
  FOR EACH ROW EXECUTE FUNCTION guard_subscription_student_matches_enrollment();

-- ---------------------------------------------------------------------------
-- payment -- DD §10
-- ---------------------------------------------------------------------------
CREATE TABLE payment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id             text NOT NULL UNIQUE DEFAULT next_public_id('PAY'),

  student_id            uuid NOT NULL REFERENCES student(id),
  parent_guardian_id    uuid REFERENCES parent_guardian(id),   -- DD §10 "parent/customer reference"
  subscription_id       uuid REFERENCES subscription(id),
  enrollment_id         uuid REFERENCES enrollment(id),        -- DD §10 "where applicable"

  amount_minor_units    bigint NOT NULL,
  currency              char(3) NOT NULL DEFAULT 'INR',

  payment_method        text NOT NULL,
  gateway_name          text,
  gateway_reference_id  text,

  paid_at               timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'pending',

  invoice_reference     text,
  receipt_reference     text,

  -- DD §10: refund/adjustment references. A correction is a NEW row pointing at
  -- the original, never an edit of the settled transaction.
  adjusts_payment_id    uuid REFERENCES payment(id),
  adjustment_type       text,
  adjustment_reason     text,

  -- DD §10 "approval status where relevant" -- maker-checker for refunds/adjustments.
  requires_approval     boolean NOT NULL DEFAULT false,
  approval_status       text,
  approval_id           uuid,
  requested_by          uuid REFERENCES user_account(id),
  approved_by           uuid REFERENCES user_account(id),
  approved_at           timestamptz,

  archived_at           timestamptz,
  archived_by           uuid REFERENCES user_account(id),
  archive_reason        text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NOT NULL REFERENCES user_account(id),
  updated_by            uuid NOT NULL REFERENCES user_account(id),
  source                text NOT NULL DEFAULT 'ui',

  CONSTRAINT payment_public_id_format CHECK (public_id ~ '^PAY-\d{4}-\d{6}$'),
  CONSTRAINT payment_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payment_method_valid CHECK (
    payment_method IN ('upi','card','netbanking','bank_transfer','cash','wallet','gateway','other')
  ),
  CONSTRAINT payment_status_valid CHECK (
    status IN ('pending','settled','failed','refunded','partially_refunded','cancelled','archived')
  ),
  CONSTRAINT payment_adjustment_type_valid CHECK (
    adjustment_type IS NULL
    OR adjustment_type IN ('refund','partial_refund','correction','chargeback','credit_note')
  ),
  -- An adjustment must name what it adjusts and why, and vice versa.
  CONSTRAINT payment_adjustment_complete CHECK (
    (adjusts_payment_id IS NULL AND adjustment_type IS NULL AND adjustment_reason IS NULL)
    OR (adjusts_payment_id IS NOT NULL AND adjustment_type IS NOT NULL AND adjustment_reason IS NOT NULL)
  ),
  CONSTRAINT payment_no_self_adjustment CHECK (
    adjusts_payment_id IS NULL OR adjusts_payment_id <> id
  ),
  -- A positive charge; adjustments carry negative amounts.
  CONSTRAINT payment_amount_sign CHECK (
    (adjusts_payment_id IS NULL AND amount_minor_units > 0)
    OR (adjusts_payment_id IS NOT NULL AND amount_minor_units <> 0)
  ),
  CONSTRAINT payment_approval_status_valid CHECK (
    approval_status IS NULL OR approval_status IN ('pending','approved','rejected')
  ),
  -- rule 22 -- no self-approval on financial actions (Master §22.4).
  CONSTRAINT payment_no_self_approval CHECK (
    approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by
  ),
  CONSTRAINT payment_approved_attributed CHECK (
    approval_status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  -- Anything requiring approval must not sit in a terminal financial state unapproved.
  CONSTRAINT payment_approval_required_before_settle CHECK (
    NOT requires_approval OR status <> 'settled' OR approval_status = 'approved'
  ),
  CONSTRAINT payment_archive_complete CHECK (
    (status <> 'archived' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL
        AND archived_by IS NOT NULL AND archive_reason IS NOT NULL)
  )
);

COMMENT ON TABLE payment IS
  'Individual financial transaction. DD §10. One Payment ID per transaction (rule, DD §43). '
  'Append-oriented: a settled payment''s financial facts are immutable; corrections are new '
  'adjustment rows referencing the original.';
COMMENT ON COLUMN payment.adjusts_payment_id IS
  'Refund/correction chain. DD §10 -- corrections never rewrite a settled transaction.';

CREATE INDEX payment_student_idx      ON payment (student_id);
CREATE INDEX payment_subscription_idx ON payment (subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX payment_parent_idx       ON payment (parent_guardian_id) WHERE parent_guardian_id IS NOT NULL;
CREATE INDEX payment_status_idx       ON payment (status);
CREATE INDEX payment_paid_at_idx      ON payment (paid_at DESC);
CREATE INDEX payment_adjusts_idx      ON payment (adjusts_payment_id) WHERE adjusts_payment_id IS NOT NULL;

-- Gateway references must be unique per gateway -- prevents the same provider
-- transaction being ingested twice (DD §47 "external ID uniqueness per provider").
CREATE UNIQUE INDEX payment_gateway_reference_uq
  ON payment (gateway_name, gateway_reference_id)
  WHERE gateway_name IS NOT NULL AND gateway_reference_id IS NOT NULL;

-- DD §10 -- once settled, the financial facts of a payment cannot be rewritten.
-- Status may still advance (settled -> refunded) and archival is allowed; the
-- money itself is frozen.
CREATE OR REPLACE FUNCTION guard_settled_payment_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('settled','refunded','partially_refunded') THEN
    IF NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
       OR NEW.currency          IS DISTINCT FROM OLD.currency
       OR NEW.paid_at           IS DISTINCT FROM OLD.paid_at
       OR NEW.student_id        IS DISTINCT FROM OLD.student_id
       OR NEW.subscription_id   IS DISTINCT FROM OLD.subscription_id
       OR NEW.payment_method    IS DISTINCT FROM OLD.payment_method
       OR NEW.gateway_reference_id IS DISTINCT FROM OLD.gateway_reference_id
    THEN
      RAISE EXCEPTION
        'Payment % is settled; its financial facts are immutable. Create an adjustment row instead (DD §10).',
        OLD.public_id
        USING ERRCODE = 'raise_exception',
              HINT = 'INSERT a new payment with adjusts_payment_id set to this payment.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payment_settled_immutable
  BEFORE UPDATE ON payment
  FOR EACH ROW EXECUTE FUNCTION guard_settled_payment_immutable();

-- A payment must belong to the same student as the subscription it funds.
CREATE OR REPLACE FUNCTION guard_payment_student_matches_subscription()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_student uuid;
BEGIN
  IF NEW.subscription_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT student_id INTO v_student FROM subscription WHERE id = NEW.subscription_id;
  IF v_student <> NEW.student_id THEN
    RAISE EXCEPTION
      'Payment student % does not match subscription % student %.',
      NEW.student_id, NEW.subscription_id, v_student
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payment_student_consistent
  BEFORE INSERT OR UPDATE OF student_id, subscription_id ON payment
  FOR EACH ROW EXECUTE FUNCTION guard_payment_student_matches_subscription();

COMMIT;
