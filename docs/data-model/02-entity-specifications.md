# 02 — Entity Specifications (Phase 1)

Field-level specification: **what is mandatory, what is optional, and why**.

## Conventions applied to every entity (not repeated below)

| Column | Rule |
|---|---|
| `id` | `uuid` primary key, system-generated. Mandatory. |
| `public_id` | DD §4 format, immutable, unique. Mandatory on entities that have a DD §4 prefix. |
| `created_at` / `updated_at` | `timestamptz`, system-generated. Mandatory. |
| `created_by` / `updated_by` | FK to `user_account`. Mandatory — a write with no actor raises (DD §41). |
| `source` | How the record arose: `ui` \| `api` \| `webhook:<system>` \| `job` \| `migration`. Mandatory (DD §2: "records should carry source/context when created by an integration or workflow"). |
| Effective-dated entities (M3) | `valid_from`, `valid_to` (NULL = open), `is_current`, `superseded_by_id`, `change_reason`, `requested_by`, `approved_by`. |

**M = mandatory · O = optional · D = derived (never written directly)**

---

## A. Identity & Master Data

### `student` — DD §6

| Field | M/O | Notes |
|---|---|---|
| `public_id` | M | `STU-YYYY-NNNNNN`. **Immutable** — rule 1. Enforced by a trigger rejecting any UPDATE. |
| `full_name` | M | Never a unique key (DD §6.1). |
| `preferred_name` | O | |
| `date_of_birth` | O | DD §6.1: "use according to policy". Optional pending the privacy decision (see [05](05-open-modelling-questions.md)). |
| `gender` | O | DD §6.1: "only if operationally required". |
| `preferred_language_id` | O | FK `language`. |
| `learning_language_id` | M | FK `language`. Required for allocation matching (Master §8). |
| `status` | M | See [03](03-lifecycle-state-machines.md#student). Default `Active`. |
| `source_channel` | M | Origin: admission system, import, manual. |
| `merged_into_student_id` | O | Set only when `status = Merged`. Rule 4 — the source record is retained, never deleted. |

> **Not on this table:** phone, email, address, primary parent, current teacher, current
> schedule, attendance summary. Contacts live in `contact_history` (rule 5); the rest are
> derived from relationships. DD §6.2 lists them as "operational fields/links" — they are
> **views**, not columns, or they will drift.

### `parent_guardian` — DD §5

| Field | M/O | Notes |
|---|---|---|
| `public_id` | M | `PAR-YYYY-NNNNNN`. |
| `full_name` | M | |
| `preferred_language_id` | O | |
| `communication_preference` | O | WhatsApp \| in-app \| email \| phone. |
| `address` | O | Structured. DD §5 notes address history may be needed — Phase 1 stores current only; historical address is [deferred, see 05]. |
| `status` | M | Active \| Inactive. |

> Phone and email are **not** columns here. They live in `contact_history` (DD §5: "may change;
> history retained").

### `student_parent_link` — DD §5

| Field | M/O | Notes |
|---|---|---|
| `student_id`, `parent_guardian_id` | M | |
| `relationship_type` | M | parent \| guardian \| grandparent \| other. |
| `is_primary_contact` | M | Exactly one current `true` per student — DB-enforced. |
| `may_receive_reports`, `may_request_changes` | M | Default `true` for primary, `false` otherwise. DD §5 requires permissions be storable on the relationship. |
| `valid_from` / `valid_to` | M / O | Guardianship can change. |

### `contact_history` — DD §7

| Field | M/O | Notes |
|---|---|---|
| `student_id` **or** `parent_guardian_id` | M (exactly one) | `CHECK` per M2. |
| `contact_type` | M | phone \| alternate_phone \| email \| name. |
| `value` | M | |
| `effective_from` | M | |
| `effective_to` | O | NULL = current. |
| `is_primary`, `is_verified` | M | |

> Name changes are recorded here too, so DD §6.3's "previous names where permitted" is
> satisfied without a separate mechanism.

### `identity_match` — DD §7 · `merge_event` — DD §7

`identity_match`: `attempted_record` (JSONB snapshot of what the user tried to create) M ·
`candidate_student_id` M · `match_signals` (JSONB) M · `confidence` M · `decision`
(`created_new` \| `used_existing` \| `blocked`) M · `decided_by` M · `decided_at` M.
Retained even for "not a duplicate" outcomes — the negative decision is audit evidence.

`merge_event`: `source_student_id` M · `target_student_id` M · `reason` M · `requested_by` M ·
`approved_by` M (rule 22 — merge is maker-checker) · `approval_id` M · `relationships_moved`
(JSONB manifest) M.

### `employee` — DD §29 (Phase 1 subset)

`public_id` (`EMP-`) M · `full_name` M · `department` M · `role_title` M · `joining_date` M ·
`employment_status` M · `manager_employee_id` O · `exit_date`/`exit_reason` O.

> Phase 1 subset only. Documents, training records, leave records and payroll reference are
> **Phase 3** — do not add them (DD §29 lists them, `CLAUDE.md` §7 defers them).

### `teacher` — DD §11 (Phase 1 subset)

| Field | M/O | Notes |
|---|---|---|
| `public_id` | M | `TCH-YYYY-NNNNNN`. |
| `employee_id` | O | Nullable — contractors (CLAUDE.md accepted default). |
| `full_name` | M | |
| `employment_status` | M | onboarding \| active \| inactive \| exited. |
| `qualifications`, `experience`, `specializations` | O | Structured/JSONB. |
| `is_allocation_eligible` | M | **Rule 25.** Default `false`. In Phase 1 this is set manually by an authorised user with a reason; in Phase 3 it becomes derived from certification records. Allocation is DB-blocked when false. |
| `allocation_eligibility_reason` | M when eligible | Forces an explicit justification while the training module does not exist. |

**Capability tables:** `teacher_subject`, `teacher_level`, `teacher_language`
(`language_id`, `proficiency`, `is_bilingual_pair`) — all `m..n`, all mandatory for matching.

### Master data

`course` (`name` M, `subject_id` M, `default_duration_minutes` M, `status` M) ·
`subject` · `level` · `language` — each `code` M, `name` M, `is_active` M.

---

## B. Commercial & Entitlement

### `enrollment` — DD §8

| Field | M/O | Notes |
|---|---|---|
| `public_id` | M | `ENR-YYYY-NNNNNN`. |
| `student_id` | M | |
| `course_id`, `subject_id`, `level_id` | M | |
| `session_type` | M | `one_to_one` \| `group`. |
| `start_date` | M | |
| `expected_end_date` | D | Planned completion — computed from entitlement + schedule (Master §16). |
| `actual_end_date` | O | Set on completion/cancellation. |
| `status` | M | See [03](03-lifecycle-state-machines.md#enrollment). |
| `end_reason` | M when ending | DD §8: "reason for cancellation/pause/completion". |
| `admission_handover_id` | O | Null for enrollments not originating from a handover. |

### `subscription` — DD §9

| Field | M/O | Notes |
|---|---|---|
| `public_id` | M | `SUB-YYYY-NNNNNN`. |
| `student_id` | M | Always present — entitlement always has an owner. |
| `enrollment_id` | O | DD §9 "where applicable"; must be set before the first session is scheduled. |
| `plan_name`, `purchased_session_count` | M | |
| `price_minor_units`, `currency` | M | Integer minor units + ISO-4217. Never floats. |
| `purchase_date`, `start_date` | M | |
| `valid_until` | M | Expiry. |
| `external_payment_ref` | O | **Opaque text.** Payment is Phase 4 (`CLAUDE.md` §5). |
| `status` | M | See [03](03-lifecycle-state-machines.md#subscription). |
| `sessions_purchased / scheduled / completed / consumed / protected / remaining` | **D** | **Derived from `session_credit_ledger`.** Materialised for read speed, always reconcilable. Never written directly — rule 16. |

### `session_credit_ledger` — Master §15.7 (append-only)

| Field | M/O | Notes |
|---|---|---|
| `subscription_id` | M | |
| `entry_type` | M | `purchased` \| `consumed` \| `protected` \| `released` \| `compensated` \| `expired` \| `adjustment`. |
| `quantity` | M | **Signed** integer. Sum = remaining balance. |
| `session_id` | O | Null for purchase, expiry, manual adjustment. |
| `reason_code` | M | Controlled vocabulary, matches the outcome matrix in [03](03-lifecycle-state-machines.md#session-outcome--credit-impact). |
| `policy_parameter_version_id` | M | Rule 28 — the rule version this decision was made under. |
| `approval_id` | M for `adjustment` | Manual adjustments are maker-checker. |
| `created_by` | M | |

> `UPDATE` and `DELETE` are revoked from the application role. A correction is a new
> compensating entry (DD §10), never a rewrite.

---

## C. Operations & Delivery

### `admission_handover` — Master §8

`student_id` O (null until the student record is created — the handover may *precede* identity
creation) · `parent_details` (JSONB as received) M · `course_id`, `subject_id`, `level_id` M ·
`preferred_days` M · `primary_timing_option` M · `alternative_timing_options` O ·
`requested_start_date` M · `demo_assessment` (JSONB) O · `demo_feedback` O ·
`received_at` M · `status` M · `verification_attempts` D · `verified_at` O · `verified_by` O.

> Demo assessment/feedback are carried as **JSONB payloads on the handover**, not as an
> `assessment` entity — that entity is Phase 2. This satisfies Master §17.3 (the teacher must
> see the starting point) without opening Phase 2 scope.

### `coordinator_ownership` — DD §14 · effective-dated

`student_id` M · `parent_guardian_id` O · `employee_id` M · `ownership_role` M
(onboarding \| student_success \| retention \| operations \| ticket \| escalation) ·
`escalation_level` O · `transfer_reason` M when superseding · plus all M3 columns.

**Constraint:** at most one current row per (`student_id`, `ownership_role`).

### `teacher_allocation` — DD §13 · effective-dated

`enrollment_id` M · `student_id` M · `teacher_id` M · `class_schedule_id` M ·
`allocation_type` M (new_admission \| teacher_change \| schedule_change \| day_change \|
session_type_change \| course_change \| student_requested \| teacher_unavailability \|
academic \| break \| resume — Master §14.1) · `previous_teacher_id` O ·
`previous_class_schedule_id` O · `reason` M · `requested_by` M · `approved_by` O ·
`reschedule_request_id` O · plus M3 columns.

**Constraint:** at most one current allocation per enrollment.

### `teacher_availability` — DD §12.1

`teacher_id` M · `availability_type` M (regular \| specific_date \| temporary \| unavailable) ·
`day_of_week` M for `regular` / `specific_date_on` M for `specific_date` · `start_time`,
`end_time` M · `timezone` M · `effective_from` M · `effective_to` O · `reason` O ·
`approval_id` O.

### `teacher_capacity` — DD §12.2 (Phase 1: current only)

`teacher_id` M · `time_slot` M · `planned_capacity_minutes` M · `allocated_capacity_minutes` D ·
`free_capacity_minutes` D · `reserved_minutes` O · `effective_from`/`to` M/O.

> **Forecast capacity (DD §12.3) is Phase 5.** No `expected_release_*` or `forecast_demand`
> columns in Phase 1.

### `class_schedule` — DD §15 · versioned

`public_id` (`CLS-`) M · `enrollment_id` M · `teacher_id` M · `session_type` M ·
`course_id`, `subject_id` M · `days_of_week` M · `start_time`, `end_time` M ·
`timezone` M (**IANA**) · `start_date` M · `planned_end_date` O · `is_recurring` M ·
`status` M · plus M3 versioning columns.

> **No `merithub_class_id` column** — it lives in `external_id_map` (rule 26).
> Recurrence is **wall-clock in `timezone`**, not a fixed UTC instant (DST correctness).

### `session` — DD §16

| Field | M/O | Notes |
|---|---|---|
| `public_id` | M | `SES-YYYY-NNNNNN`. |
| `class_schedule_id` | M | |
| `teacher_id` | M | Denormalised from the allocation current at generation time, so history survives reallocation. |
| `scheduled_start_at`, `scheduled_end_at` | M | `timestamptz`. |
| `actual_start_at`, `actual_end_at` | O | From Merithub. |
| `session_purpose` | M | `regular` \| `compensation` \| `replacement` \| `extra`. |
| `status` | M | See [03](03-lifecycle-state-machines.md#session). |
| `outcome` | O | Set on terminal status; drives credit impact. |
| `cancellation_reason` | M when cancelled | |
| `rescheduled_to_session_id` | O | |
| `compensation_required` | M | Default `false`, set by the outcome matrix. |

**Constraint:** `EXCLUDE USING gist (teacher_id WITH =, tstzrange(scheduled_start_at,
scheduled_end_at) WITH &&) WHERE (status NOT IN ('Cancelled','Rescheduled'))` — teacher
double-booking becomes impossible.

### `session_participant` [ENGINEERING M4] · `attendance` — DD §17

`session_participant`: `session_id` M · `enrollment_id` M · `student_id` M. Unique on
(`session_id`, `enrollment_id`).

`attendance`: `session_participant_id` M · `scheduled_minutes` M · `attended_minutes` M ·
`attendance_percentage` **D** (generated) · `attendance_status` M · `joined_at`/`left_at` O ·
`source_system` M · `manual_correction_flag` M · `correction_reason` M when corrected ·
`corrected_by`, `approved_by` M when corrected (DD §17).

### `compensation` — DD §18

`public_id` O · `original_session_id` M · `enrollment_id` M · `student_id` M · `reason` M ·
`eligibility_decision` M · `policy_parameter_version_id` M · `credit_treatment` M
(protected \| consumed) · `requested_by` M · `approved_by` O · `teacher_id` O ·
`compensation_session_id` O (**null until scheduled**) · `status` M · `valid_until` M ·
`reschedule_count` M default 0 · `outcome` O.

> **Rule 18 guard:** creating a compensation must not write to `class_schedule`. Enforced by a
> trigger that raises if a `class_schedule` row is modified within a transaction that inserts a
> compensation.

### `reschedule_request` — DD §19

`session_id` **or** `class_schedule_id` M (exactly one, M2) · `student_id` M ·
`enrollment_id` M · `change_type` M · `requested_new_datetime` O · `reason` M ·
`requested_by` M · `requested_by_party` M (parent \| teacher \| operations) ·
`teacher_availability_result` O · `coordinator_decision` O · `approval_id` O · `status` M ·
`effective_date` O.

---

## D. Support & SLA

### `ticket` — DD §31

`public_id` (`TKT-`) M · `student_id` M · `parent_guardian_id` O · `category` M
(class \| teacher \| academic \| schedule \| subscription \| general — Master §20.2) ·
`priority` M · `description` M · `assigned_team` M · `assigned_employee_id` O ·
`status` M · `resolution` M when resolved · `related_session_id`, `related_teacher_id`,
`related_subscription_id`, `related_enrollment_id` O.

### `sla_policy` / `sla_instance` — DD §32

`sla_policy`: `name` M · `trigger_event` M · `target_duration` M · `warning_duration` M ·
`escalation_levels` (JSONB) M · `pause_conditions` O · `is_active` M · effective-dated.

`sla_instance`: `sla_policy_id` M · `ticket_id` **or** `admission_handover_id` M (exactly one) ·
`owner_employee_id` M · `started_at` M · `target_at` M · `warning_at` M · `paused_at`/
`resumed_at` O · `breached_at` O · `resolved_at` O · `status` M.

---

## E. Governance & Platform

| Entity | Key fields |
|---|---|
| `user_account` | `employee_id` M · `email` M unique · `password_hash` M (Argon2id) · `totp_secret` O · `totp_required` M · `status` M · `last_login_at` O · `failed_attempts` M |
| `user_session` | `user_account_id` M · `token_hash` M · `ip`, `user_agent` M · `created_at`, `expires_at`, `revoked_at` — supplies the session metadata DD §41 requires on audit rows |
| `role` / `permission` / `role_permission` / `user_role` | `permission` = (`action`, `entity`) where action ∈ view, create, edit, delete, archive, approve, export (DD §40). `user_role.scope` ∈ own, all (team/department reserved, `CLAUDE.md` trade-off 6) |
| `approval_request` | `public_id` (`APR-`) M · `requested_action` M · `entity_type`, `record_id` M · `requester_user_id` M · `approver_role_id` M · `approver_user_id` O · `requested_value` (JSONB) M · `old_value` (JSONB) O · `reason` M · `supporting_evidence` O · `status` M · `decision_reason` M on decision · **`CHECK (approver_user_id <> requester_user_id)`** |
| `audit_event` | `public_id` (`AUD-`) · `occurred_at` · `actor_user_id` · `actor_session_id` · `ip` · `user_agent` · `action` · `entity_type` · `record_id` · `old_value`/`new_value` JSONB · `changed_fields` text[] · `reason` · `approval_id` · `correlation_id` · `source` · `outcome`. All M except `old_value` (INSERT), `new_value` (DELETE), `reason`, `approval_id` |
| `external_id_map` | `spellzee_entity_type`, `spellzee_id`, `external_system`, `external_id`, `status`, `last_sync_at`, `sync_status`, `sync_error` — all M except the last two |
| `policy_parameter` | `key` M · `value` (JSONB) M · `scope` O · `version` M · `valid_from` M · `valid_to` O · **`source`** M (`engineering_default` \| `business_ratified`) · `ratified_at` O · `ratified_by` O — see `CLAUDE.md` §4 |
| `outbox_event` | `aggregate_type`, `aggregate_id`, `event_type`, `payload` JSONB, `status`, `attempts`, `next_attempt_at`, `last_error` |
| `notification` | `recipient_student_id` \| `recipient_parent_id` \| `recipient_teacher_id` \| `recipient_employee_id` (exactly one) · `channel` M · `template_key` M · `trigger_event` M · `scheduled_at` M · `sent_at` O · `delivery_status` M · `related_entity_type`/`related_entity_id` O · `retry_count`, `last_error` |

---

## Entity count check

40 tables: 7 identity + 4 master data + 3 teacher capability + 3 commercial + 11 operations +
3 support + 9 governance/platform. This is **five more** than the 35 named in `CLAUDE.md` §5 —
the additions are `course`, `subject`, `level`, `language`, `session_participant`,
`teacher_subject`, `teacher_level`, `teacher_language`, `user_session`, minus overlaps.

These are **not scope expansion into Phase 2+**. Master §5 Domain 1 explicitly places "course,
subject, master records" in Phase 1, and allocation matching (Master §8) cannot function
without the teacher capability tables. Flagged here for your confirmation rather than added
silently — see [05](05-open-modelling-questions.md).
