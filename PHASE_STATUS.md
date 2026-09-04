# Spellzee ERP — Phase Status

> Single source of truth for `phase-gatekeeper`. Mirrors CLAUDE.md §5/§7. If this file and CLAUDE.md
> ever disagree, that's a bug — flag it, don't silently pick one.

## Current phase

**Phase 1 — Operations MVP** (Master §29). Next phase (not started, do not build into): Phase 2 —
Academic & Parent Experience.

## Approved entity list — Phase 1 (40 tables, CLAUDE.md §5)

Identity & Master Data: `parent_guardian`, `student`, `student_parent_link`, `contact_history`,
`identity_match`, `merge_event`, `employee`

Reference / Master Data: `course`, `subject`, `level`, `language`

Governance & Platform: `user_account`, `user_session`, `role`, `permission`, `role_permission`,
`user_role`, `approval_request`, `audit_event`, `external_id_map`, `policy_parameter`, `outbox_event`,
`notification`

Commercial: `enrollment`, `subscription`, `session_credit_ledger`, `payment` (pulled forward from Phase
4 — see CLAUDE.md §5 "Scope change" note; treat as already-answered, not open)

Operations & Delivery: `admission_handover`, `coordinator_ownership`, `teacher`, `teacher_subject`,
`teacher_level`, `teacher_language`, `teacher_availability`, `teacher_capacity`, `teacher_allocation`,
`class_schedule`, `session`, `session_participant`, `attendance`, `compensation`,
`reschedule_request`

Support: `ticket`, `sla_policy`, `sla_instance`

## Explicitly deferred — do NOT create without a logged exception

`lesson`, `assessment`, `progress`, `material`, `recording`, `academic_program` (Phase 2) ·
`training`, `certification`, `observation`, `incentive`, `leave` (Phase 3) · `refund`, `credit_note`
as separate entities (Phase 4 — currently folded into `payment.adjustment_type`) ·
`retention_interaction`, `student_health`, `demand_forecast`, `ai_output`, `communication`, `call`
(Phase 2/5).

## What's built so far (mirrors CLAUDE.md §6)

- **Batch 1 — Identity & commercial core**: `parent_guardian`, `student`, `enrollment`, `subscription`,
  `payment`, `external_id_map`, `audit_event`. Migrations 0001-0008. 50 tests passing.
- **Batch 2 — Workforce & delivery scheduling**: `employee`, `teacher` (+ capability tables),
  `teacher_availability`, `teacher_capacity`, `coordinator_ownership`, `class_schedule`,
  `teacher_allocation`, `session`. Migrations 0009-0014. 113 tests passing (44 domain + 69 Postgres
  integration). Compensation/session-outcome logic and Merithub sync explicitly deferred to the next
  batch — `session.outcome` is an unconstrained nullable column, `external_id_map` already lists the
  mappable types.
- **Batch 3 — Governance & RBAC**: `role`, `permission`, `role_permission`, `user_role`
  (effective-dated), `user_session`, `approval_request` (maker-checker infrastructure, DD §39), plus
  MFA columns (`mfa_enabled`/`totp_secret_encrypted`/`last_login_at`) added to the pre-existing minimal
  `user_account`. Migrations 0015-0016. 15 new Testcontainers tests (`governance-invariants.test.ts`),
  written test-first per the TDD mandate — self-approval rejection (rule 22), one-current-role-per-user
  partial unique index, no-hard-delete on `user_role`/`user_session`/`approval_request`, MFA-secret
  `CHECK`. `user_role.scope` ships `own`/`all` only (CASL team/department scopes are an open decision,
  Master §30). No RLS policies added — Phase 1 scopes RLS to `audit_event` only, per CLAUDE.md's
  confirmed stack.
- **Batch 4 — Policy, outbox, notification**: `policy_parameter` (effective-dated, rule 28),
  `outbox_event` (layer 4 transactional outbox), `notification`. Migrations 0017-0018, 16
  Testcontainers tests, written test-first — all 16 passed on the first migration attempt (no
  bugs found this batch, unlike batches 2-3). Built ahead of compensation/session-outcome logic
  specifically because that logic needs `policy_parameter` (compensation validity period, max
  reschedules) to avoid hard-coding values rule 28 forbids hard-coding.
- **Batch 5 — Session credit ledger**: `session_credit_ledger` (layer 3, append-only). Migration
  0019, 11 Testcontainers tests, written test-first — all 11 passed on the first migration
  attempt. Reuses `guard_append_only()` (already protecting `audit.audit_event` since 0002) for
  the UPDATE/DELETE rejection rather than inventing a new mechanism. Schema only — no
  service-layer code that writes entries yet (session completion, teacher-absence
  compensation, goodwill exceptions are still the compensation/session-outcome batch). No
  materialized subscription balance columns either — `sum(amount)` is correct today; the
  materialized/derived balance is a read-path optimization, not a correctness requirement.
- **Batch 6 — Compensation (rule 18 start)**: `session.outcome` constrained to a real vocabulary
  (migration 0020 — was unconstrained since 0012), `compensation` table (migration 0021-0022),
  `createCompensation()` service (`packages/db/src/services/compensation.service.ts`). 14 new
  Testcontainers tests (8 schema + 6 service), all written test-first and all passing on the
  first implementation attempt. Proves the rule 18 guarantee directly: a test asserts
  `class_schedule.updated_at` is byte-identical before and after a compensation session is
  created. Reads `compensation_validity_days` live from `policy_parameter` (rule 28) — throws
  `MissingPolicyParameterError` rather than defaulting silently if the row isn't seeded.
  Compensation-qualifying outcomes are `teacher_absent`/`teacher_technical_failure` only (rule 19).
  Explicitly NOT built: what happens when the compensation session itself is missed/cancelled/
  expires (a 'compensated' ledger debit on its completion, expiry handling), student-side
  technical failure / goodwill-exception handling, cancellation-cutoff-driven protection.
- **Batch 7 — Reschedule & cancellation cutoff**: `reschedule_request` table (migration 0023-0024),
  `createReschedule()` service. Reuses `session.status='rescheduled'` +
  `rescheduled_to_session_id` (already on `session` since 0012) rather than editing the original
  session's scheduled time in place. `cancellation_cutoff_hours` and
  `max_reschedules_per_subscription` both read live from `policy_parameter` (rule 28). Outside the
  cutoff records a `protected` (+1) ledger entry, inside records `consumed` (-1). 11 tests, TDD,
  one fixture bug caught and fixed (two replacement sessions collided on `session_no_teacher_double_booking`
  from reusing the same time slot).
- **Batch 8 — Compensation completion/expiry**: `completeCompensation()` and `expireCompensations()`
  added to `compensation.service.ts`. Completion records a `compensated` (-1) ledger entry — nets
  to zero against batch 6's `protected` (+1) entry over a fully-delivered cycle. Expiry
  deliberately does NOT touch the ledger (rule 17: never silently forgiven) — an overdue
  compensation is flagged `expired`, the protected credit stays visible/available for a
  coordinator to act on. 10 tests (6 original createCompensation + 4 new), all passing.
- **Batch 9 — Attendance**: pure `classifyAttendance()` domain function
  (`packages/domain/src/delivery/attendance.ts`, 12 unit tests, present/late/partial/absent per
  CLAUDE.md §4's thresholds), `attendance` table (0025-0026), `recordAttendance()` service reading
  `attendance_present_threshold_pct`/`attendance_partial_threshold_pct`/`attendance_late_minutes`
  live from `policy_parameter`. One attendance row per session. 10 tests (6 schema + 4 service).
- **Batch 10 — Admission handover**: `admission_handover` table (0027-0028),
  `createAdmissionHandover()` (SLA deadline computed from `admission_allocation_sla_hours`, read
  live) + `acknowledgeHandover()`. Keeps its own `sla_deadline_at` column rather than depending on
  batch 11's generic SLA engine — the two are deliberately uncoupled in Phase 1. 9 tests (5 schema
  + 4 service).
- **Batch 11 — Support (ticket + SLA engine)**: `sla_policy`, `ticket` (public_id `TKT-`), `sla_instance`
  (0029-0030) — a GENERIC, reusable SLA engine (entity_type/entity_id, not ticket-specific), plus
  `createTicket()`/`resolveTicket()`/`checkSlaBreaches()`. SLA numbers (36h warn / 48h breach) come
  from a named `sla_policy` row, not `policy_parameter` — SLA definitions are their own dedicated
  entity per DD, distinct from the general configurable-policy table. 16 tests (10 schema + 6
  service), one fixture bug caught (moving `warn_at` into the past without `started_at` violated
  `sla_instance_warn_after_start` — a real constraint doing its job).

**All 40 Phase 1 entities are now built**, except `session_participant` (deliberately not built —
see the scope note above; group-class modelling is still open question A1). Final count: 175 db
integration tests (Testcontainers, real Postgres 16) + 56 pure domain unit tests = 231 tests, all
passing, 30 migrations (0001-0030) apply cleanly on every fresh container spin-up.

> Note: keep this list in sync with `packages/db/migrations/` after every build session —
> `phase-gatekeeper` should spot-check against the actual migration directory, not just this file, if
> anything looks stale.

## Exception log

_(none yet — log any explicitly user-approved out-of-phase or out-of-list work here: entity name, date,
who approved it, and why, before any code is written for it.)_

| Date | Item | Approved by | Reason |
|---|---|---|---|
| — | — | — | — |
