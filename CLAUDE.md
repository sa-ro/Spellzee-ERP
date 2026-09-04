# Spellzee ERP — Project Memory

> Persistent context for all Claude Code sessions on this repository.
> Read this before doing anything. Do not re-read the source PDFs unless a question is not
> answered here.

---

## Engineering Priorities (Management Mandate — 2026-09-04)

> This is a **production-grade application**, not a prototype. Management has set a fixed
> priority order that overrides convenience or speed whenever they conflict. This order does
> not change without an explicit new management directive — do not reorder it based on a
> single feature's convenience.

**1. Security → 2. Performance → 3. Scalability** — in that order, always. When a design choice
trades one against another (e.g. a caching layer that weakens an authz check, a denormalization
that makes an audit trail harder to reconstruct), security wins over performance, and performance
wins over scalability. Cite which priority a trade-off serves when making one.

**TDD is mandatory for all code, every time, no exceptions.** Write the failing test first, then
the implementation that makes it pass, then refactor. This applies to every layer already
established in this repo: pure domain logic in `packages/domain` (Vitest), constraints/triggers
in `packages/db` (Testcontainers — the test must exist and fail before the migration exists), and
service-layer workflows. "Add tests after" is not TDD and does not satisfy this mandate — if a
task is done and the tests were written after the code, say so explicitly rather than presenting
it as TDD.

Concretely, for this codebase:
- **Security** → every one of the 31 rules in §4 is a security/integrity boundary as much as a
  business rule (permanent identity, maker-checker, audit immutability, RLS on `audit_event`,
  RBAC/CASL separate from seniority — rule 24). Treat `business-rules-auditor` findings as
  blocking, not advisory, when they touch rules 21-26.
- **Performance** → covered by existing structural choices (indexed FKs, partial indexes for
  "current row" lookups, `GENERATED ALWAYS AS ... STORED` for derived columns like
  `free_capacity_minutes`) — do not regress these when adding new tables; a new effective-dated
  table needs its partial unique index and its history-lookup index from day one, not as a
  follow-up.
- **Scalability** → monthly partitioning on `audit_event` from day one, minute-based integer
  capacity units, `outbox_event` decoupling integration calls from the request path — preserve
  this shape; do not introduce synchronous cross-system calls inside a request/transaction.

---

## 1. Product Summary

Spellzee is an online tutoring company migrating off a patchwork of spreadsheets, WhatsApp
groups, TeliCRM/Delicio and Merithub into a single controlled ERP. **Spellzee ERP is a system
of record and a system of control**: it knows who the student is, what they purchased, what
was scheduled, what was actually delivered, who owns the relationship, what went wrong, what
capacity exists, what changes were approved, and what should happen next. Its north-star
principle is *"nothing important should happen invisibly."* The product spans eleven domains
(Identity, Sales/Admissions, Student, Operations/Delivery, Academic, Teacher & HR, Finance,
Communication, Governance, Analytics, AI) delivered across five phases. **We are currently in
Phase 1 — the Operations MVP**, and the posture is explicitly *foundation before code*: the
source documents forbid mass table creation ahead of validated business entities, and require
that reliable identities, relationships, history and permissions exist before any analytics or
AI is layered on top.

**Phase 1 scope:** student identity + duplicate controls, admission handover, coordinator
ownership, teacher availability/capacity basics, allocation, scheduling, session ledger,
compensation rules, Merithub integration, notifications, tickets, SLA, audit.

### Source documents (in `docs/source/`)

| Document | Authority |
|---|---|
| `Spellzee_ERP_Master_Product_Business_Requirements_Draft_3.pdf` | **MASTER** for product scope. Supersedes Draft 2. |
| `Spellzee_ERP_Data_Architecture_Data_Dictionary_Draft_1.pdf` | **AUTHORITATIVE** for entities, fields, relationships, identifiers. |
| `Spellzee_ERP_Product_Business_Requirements_Draft_2.pdf` | Historical/supplementary only. No conflicts with Draft 3. |
| `Spellzee_Product_Department_Document_V1_Draft1 (1).pdf` | Supplementary — user stories, acceptance criteria, MVP priorities. |

Citations below use **DD §n** (Data Dictionary) and **Master §n** (Draft 3).

---

## 2. Confirmed Tech Stack

| Layer | Choice |
|---|---|
| Backend | **TypeScript + NestJS** modular monolith, Node 22 |
| Database | **PostgreSQL 16** (managed) |
| Cache / queue | **Redis** — session store + BullMQ |
| ORM / migrations | **Drizzle ORM + drizzle-kit**, hand-authored SQL migrations |
| API | **REST + OpenAPI** generated from NestJS + Zod; typed client generated for the SPA |
| Frontend | **React 19 + TypeScript + Vite** SPA |
| UI | TanStack Query, TanStack Table, shadcn/ui + Tailwind, React Hook Form + Zod |
| Workflows | **XState** for allocation and session-outcome state machines only |
| Auth | Server-side opaque sessions (httpOnly, SameSite=Strict cookie; Redis), Argon2id, **TOTP MFA** for Finance / Restricted Admin / any approver role |
| AuthZ | DB-driven RBAC compiled into **CASL** abilities per session; Postgres RLS as defense-in-depth on `audit_event` only in Phase 1 |
| Jobs | **BullMQ** — class reminders, SLA timers/escalation, Merithub retry, notification dispatch, retention triggers, capacity recalc |
| Files | S3 + presigned URLs |
| Testing | Vitest (policy units), **Testcontainers** against real Postgres, Playwright (critical flows) |
| Ops | Docker → AWS ECS Fargate (or Fly.io/Render), GitHub Actions, Sentry, pino |

**Deliberately excluded:** microservices, Kubernetes, GraphQL, a second datastore, Next.js for
the internal ERP, event sourcing as the primary persistence model.

### Why these, briefly

- **NestJS modules map 1:1 to the eleven domains** — Phase 2–5 means adding modules, not
  restructuring. DI makes the configurable policy engine testable; guards and interceptors
  make RBAC and maker-checker declarative rather than 400 hand-written checks.
- **Postgres is load-bearing, not incidental**: `EXCLUDE USING gist` + `btree_gist` makes
  teacher double-booking structurally impossible; `tstzrange`/`daterange` give correct overlap
  semantics for effective-dated records; `JSONB` holds audit values and policy parameters;
  triggers + revoked grants give tamper-evident audit.
- **Drizzle over Prisma** because migrations must express triggers, exclusion constraints,
  partial indexes and `REVOKE` — which Prisma's migration engine fights.
- **Server-side sessions over JWT** because role changes and employee exits must bind on the
  next request, and DD §41 requires session/IP/device metadata on audit events.

---

## 3. Identifier Standard (DD §4 — authoritative)

Format is `PREFIX-YYYY-NNNNNN`, where `YYYY` is the year of creation and `NNNNNN` is a
zero-padded sequence. Example: `STU-2026-000184`.

| Entity | ID Format | Purpose |
|---|---|---|
| Student | `STU-YYYY-NNNNNN` | Permanent student identity. |
| Parent/Guardian | `PAR-YYYY-NNNNNN` | Permanent parent/guardian identity. |
| Employee | `EMP-YYYY-NNNNNN` | Permanent employee identity. |
| Teacher | `TCH-YYYY-NNNNNN` | Permanent teacher identity; may map to Employee. |
| Enrollment | `ENR-YYYY-NNNNNN` | Specific academic participation. |
| Subscription | `SUB-YYYY-NNNNNN` | Commercial session/service entitlement. |
| Payment | `PAY-YYYY-NNNNNN` | Individual financial transaction. |
| Class Schedule | `CLS-YYYY-NNNNNN` | Recurring/planned class arrangement. |
| Session | `SES-YYYY-NNNNNN` | Individual class occurrence. |
| Ticket | `TKT-YYYY-NNNNNN` | Operational issue/request. |
| Observation | `OBS-YYYY-NNNNNN` | Teacher quality observation. |
| Training | `TRN-YYYY-NNNNNN` | Training participation/program record. |
| Approval | `APR-YYYY-NNNNNN` | Controlled approval request. |
| Communication | `COM-YYYY-NNNNNN` | Conversation/message record where required. |
| Call | `CAL-YYYY-NNNNNN` | Call activity record. |
| Audit Event | `AUD-YYYY-NNNNNN` | Immutable/controlled audit event. |

> The full table is recorded here for continuity. Several of these entities (Payment,
> Observation, Training, Communication, Call) belong to **later phases** — see §5. Do not
> create their tables now.

### Identifier rules

- Every major entity receives a Spellzee-generated stable ID (DD §2).
- **Never** use names, phone numbers or email addresses as primary identifiers (DD §2).
- Business IDs are a **public-facing column**, not the primary key. Use an internal `uuid`
  PK plus a unique, immutable `public_id` in the format above.
- External system IDs live **only** in `external_id_map` — no Merithub/TeliCRM/FreeJump ID
  column exists on any core table (DD §42).
- Changing an entity's identifier format requires an ADR.

---

## 4. Non-Negotiable Business Rules

Merged from **DD §43** and **Master §3.2**. These are invariants — if a design violates one,
the design is wrong, not the rule. Enforce at the database layer wherever possible.

### Identity

1. **One permanent Student ID per person.** It never changes when contact details, course,
   teacher, schedule, subscription change, or when the student takes a break or returns.
   *(DD §43, §6.3, Master §6.1)*
2. Returning students create a **new enrollment/subscription, not a new student identity**.
   *(DD §6.3)*
3. Potential duplicates must be surfaced **before** creation; high-confidence duplicates are
   blocked or require approval. *(Master §6.4)*
4. Duplicate merges must **preserve source records, references and audit trail**, and redirect
   relationships safely. *(DD §43, §6.3)*
5. Contact details (phone/email/name) are **history, not identity** — store `contact_history`
   with effective dates rather than creating a new identity. *(DD §7)*

### Separation of concepts

6. **Student, Enrollment, Subscription, Payment, Class Schedule and Session are distinct
   concepts linked by identifiers.** Never collapse them. *(Master §3.2, §6.2)*
7. **A recurring schedule is not the same as a session.** *(DD §43)*
8. **Teacher availability is not the same as capacity.** Availability answers "is this person
   free?"; capacity answers "how much can Spellzee realistically deliver?" *(DD §43, Master §13)*
9. Allocation = **teacher assignment PLUS class schedule/arrangement**, not just a teacher.
   *(DD §13, Master glossary)*
10. Communication, tickets, academic records and financial records are **connected but not
    conflated**. A conversation is a channel; a ticket is a tracked issue with owner, SLA and
    resolution. *(Master §3.2, §19.3)*

### History and deletion

11. **Never silently overwrite important history.** *(Master §3.2)*
12. **Teacher changes create history**, not overwrite-only updates. Same for **coordinator
    ownership changes**. *(DD §43)*
13. Critical business records are **cancelled/archived, not deleted**. Permanent deletion
    requires exceptional authorization and is preferably prohibited. *(DD §2, Master §3.2, §22.4)*
14. Critical financial/history records must **never be silently deleted**. Financial
    corrections create **controlled adjustments**, never a rewrite of a settled transaction.
    *(DD §10, §43)*
15. Completed payments, classes, allocations, tickets and academic records must not disappear
    or be overwritten. *(Master §22.6)*

### Entitlement and delivery

16. A subscription has a **defined entitlement**; individual sessions consume or protect that
    entitlement according to policy. *(DD §43)*
17. **A purchased session is never silently lost, and a missed session is never silently
    forgiven.** Every session outcome carries a reason, policy outcome, credit impact and
    history. *(Draft 2 §8)*
18. **A compensation session is a separate, additional session linked to the original affected
    session. It MUST NOT modify or reschedule the original recurring schedule.** A missed
    Monday can produce a Saturday compensation class while Monday remains the regular
    schedule. *(DD §18, Master §15.5)*
19. Teacher absence or verified teacher/Spellzee-side failure generally **protects** the
    student's entitlement and triggers compensation. *(Master §15.4)*
20. A student may have multiple enrollments and subscriptions over time. *(DD §43)*

### Governance

21. **Every critical action is attributable and auditable** — user, timestamp, old value, new
    value, reason, approval reference. *(Master §3.2, §22.5, DD §41)*
22. **Maker and checker are separated for sensitive actions.** Approval rules must prevent
    self-approval where maker-checker applies. Enforced by a DB `CHECK`, not only the UI.
    *(DD §43, Master §22.3)*
23. Audit records for critical actions are **protected from ordinary editing and deletion**.
    *(DD §41)*
24. Permission is **separate from business hierarchy**. Seniority alone must not grant
    financial or sensitive-data access. *(DD §40)*
25. A teacher must **not be allocated** if mandatory onboarding/certification rules are
    unsatisfied. *(DD §43)* — Phase 1 models the eligibility flag; the training records that
    populate it arrive in Phase 3.

### Integrations and data

26. **Spellzee owns its core identifiers.** External IDs never replace Spellzee core IDs, and
    external systems must never silently overwrite critical Spellzee records.
    *(DD §43, Master §23.5)*
27. External API failures must **not silently create incomplete or misleading Spellzee
    records** — failures are visible, retryable and reconcilable. *(Product Dept §10)*
28. **Business rules must be configurable**, not hard-coded. Every policy-driven decision
    record stamps the rule/criteria version it was decided under, so old records stay
    interpretable after the rules change. *(Master §3.2, DD §27)*
29. **Capacity must be measurable and forecastable**; current capacity plus forecast releases
    is comparable against demand. *(DD §43, Master §3.2)*
30. **AI-generated fields are derived information, not authoritative source records**, and must
    never overwrite source records. *(DD §2, §49, Master §27.2)*
31. **Foundation first** — analytics and AI only after data quality is established.
    *(Master §3.2)*

> **North star:** *Nothing important should happen invisibly.* (Master §3.2)

### Open policy parameters — do NOT hard-code

All of these are undecided (Master §30). They live in `policy_parameter` as effective-dated,
versioned rows: cancellation cutoff, late-cancellation credit treatment, teacher-vs-student
technical failure rules, maximum reschedules, compensation validity period, maximum completion
extension, admission-allocation SLA, ticket SLA (currently discussed as 48h, unconfirmed),
attendance thresholds for Present/Late/Partial/Absent, duplicate-match confidence thresholds,
capacity unit (minutes/hours/sessions/weighted slots), target teacher utilization range,
retention trigger interval (discussed as every 3 sessions, unconfirmed), reminder timing.

### Accepted working defaults (2026-09-04)

The values below were **accepted as engineering working defaults so development is not
blocked**. They are explicitly revisable as requirements firm up.

> **Important distinction:** these are *not* business-ratified policy. A seeded 48-hour SLA
> that management never actually approved must never be mistaken later for an approved one.
> Every seeded row carries `source = 'engineering_default'` and `ratified_at = NULL`. When the
> business confirms a value, flip it to `source = 'business_ratified'` with the date and owner.
> Reports and any parent-facing surface must not present an unratified policy as company policy.

**Structural (Tier 1 — settled, changing these later costs a migration):**

| Decision | Accepted |
|---|---|
| Capacity storage unit | **Minutes** atomic; **sessions** for display/planning |
| Class duration | On `class_schedule`, defaulted from course |
| Group classes | Schema supports group (`session_participant`, credits per student); **Phase 1 UI is 1-to-1 only** |
| Student vs Employee | **Separate**, no shared person master |
| Teacher ↔ Employee | `teacher` optionally links to `employee` (0..1) so contractors exist without an HR record |
| Currency | INR assumed; ISO-4217 column retained regardless |
| Timezone | `timestamptz` UTC + IANA tz on `class_schedule`, wall-clock recurrence — retained regardless of current geography |
| Audit retention | 7 years, monthly partitions, cold storage rather than drop |
| Forecast capacity | **Deferred to Phase 5.** Phase 1 = availability + current-allocation counting only |

**Policy seed values (Tier 2 — `policy_parameter` rows, change without a migration):**

Admission→allocation SLA 24h (start: handover receipt; stop: allocation confirmed) · Ticket SLA
48h, warn 36h, escalate to Team Lead on breach · Cancellation cutoff 24h (outside = protected,
inside = consumed) · Teacher/Spellzee-side failure = protected + compensation · Student-side
technical failure = consumed, one goodwill exception per subscription · Compensation validity
30 days · Max 3 reschedules per subscription · Max completion extension 60 days · Attendance
≥90% Present, 50–89% Partial, <50% Absent, >10 min late = Late · Reminders 3h and 30 min before
· Retention trigger every 3 sessions · Duplicates: exact phone/email = block, fuzzy name +
parent phone = warn + require approval.

### Still outstanding — not decisions, deliverables

These were not answered and remain open. Track in `docs/policies/`:

1. **Merithub API documentation + sandbox credentials** — gates all integration contract
   design. If the API lacks class creation or attendance webhooks, Phase 1 scope changes.
2. **WhatsApp BSP selection** — Meta verification and template approval take weeks of calendar
   time that engineering speed cannot recover. Schedule risk, not a technical one.
3. Anonymised sample data (allocation sheet, TeliCRM export, one month of Merithub sessions)
   — needed to design duplicate matching against real shapes.
4. Volume figures — current students/teachers/sessions-per-day and 12-month growth. The
   "don't over-engineer for scale we don't have" assumption is currently unverified.
5. Named decision owners per policy area + a recurring slot to ratify the seeded values above.
6. Cloud account, repository and secret ownership in Spellzee's name (Master §28).
7. Actual Spellzee role/job titles, to replace the illustrative four in Master §22.4.

---

## 5. Phase 1 MVP Entities — THIS LIST ONLY

Create **only** these. Everything else is out of scope.

> The logical model in `docs/data-model/` is the detailed expansion of this list.

### Identity & Master Data
`parent_guardian` · `student` · `student_parent_link` · `contact_history` · `identity_match` ·
`merge_event` · `employee`

### Reference / Master Data
`course` · `subject` · `level` · `language`

### Governance & Platform
`user_account` · `user_session` · `role` · `permission` · `role_permission` · `user_role` ·
`approval_request` · `audit_event` · `external_id_map` · `policy_parameter` · `outbox_event` ·
`notification`

### Commercial (operations-facing only)
`enrollment` · `subscription` · `session_credit_ledger`

### Operations & Delivery
`admission_handover` · `coordinator_ownership` · `teacher` · `teacher_subject` ·
`teacher_level` · `teacher_language` · `teacher_availability` · `teacher_capacity` ·
`teacher_allocation` · `class_schedule` · `session` · `session_participant` · `attendance` ·
`compensation` · `reschedule_request`

### Support
`ticket` · `sla_policy` · `sla_instance`

**40 tables.** Nine more than the original 35, added during logical modelling and flagged for
confirmation in `docs/data-model/05-open-modelling-questions.md` (A2) rather than added
silently: the four reference tables and three teacher-capability tables are required by
allocation matching (Master §8) and are scoped to Phase 1 by Master §5 Domain 1;
`session_participant` avoids special-casing group classes; `user_session` supplies the session
metadata DD §41 requires on audit rows.

### Scope change: `payment` was pulled forward into Phase 1 (2026-09-04)

Originally deferred to Phase 4 (see history below). **The user explicitly instructed
`payment` to be implemented now**, alongside Parent/Guardian, Student, Enrollment,
Subscription, External ID Mapping and Audit Event — DD §10 fully specifies the entity, so
it was built to that spec: append-oriented, settled-amount immutable by trigger, refunds/
corrections as new adjustment rows referencing the original, maker-checker on
approval-required adjustments. Still absent: `refund`/`credit_note` as separate entities
(modelled as `payment.adjustment_type` instead), and the full Phase 4 approval matrix.

Original reasoning for the Phase 4 deferral, kept for context: Master §29 places payments
in Phase 4, and `subscription.external_payment_ref` (opaque text + `external_id_map`) was
meant to let Operations see entitlement without Finance being built. That plan is
superseded for `payment` specifically — treat future prompts naming Payment as already
answered, not as a fresh scope question.

### Explicitly deferred — do not create

`lesson`, `assessment`, `progress`, `material`, `recording`, `academic_program`
(Phase 2) · `training`, `certification`, `observation`, `incentive`, `leave` (Phase 3) ·
`refund`, `credit_note` as separate entities (Phase 4 — currently folded into `payment`) ·
`retention_interaction`, `student_health`, `demand_forecast`, `ai_output`, `communication`,
`call` (Phase 2/5).

### The four-layer history model — get this right

Do not build one "history table." The docs describe **four distinct mechanisms**:

1. **`audit_event` — generic trigger-based audit log.** One `AFTER INSERT/UPDATE/DELETE FOR
   EACH ROW` trigger function attached to every business table via a shared migration helper.
   Stores `old_value`/`new_value` JSONB, `changed_fields`, `reason`, `approval_id`,
   `correlation_id`, `source` (UI/API/WEBHOOK/JOB/MIGRATION), `outcome`, and session
   metadata. Actor arrives via `SET LOCAL app.actor_id` set by NestJS middleware; **a write
   with no actor set must raise.** The application DB role has `INSERT` only —
   `UPDATE`/`DELETE` are revoked. Partitioned monthly from day one.
2. **Effective-dated business history** — for `teacher_allocation`, `coordinator_ownership`,
   `contact_history`, `class_schedule` versions, `teacher_availability`, `teacher_capacity`.
   These are *business records*, not audit rows: `valid_from`, `valid_to`, `is_current`,
   `superseded_by_id`, `change_reason`, `requested_by`, `approved_by` as first-class columns,
   with exclusion constraints preventing two current rows per subject. A teacher change
   *closes* the old row and *opens* a new one — it never UPDATEs in place.
3. **`session_credit_ledger` — append-only.** Signed entries (+purchased, −consumed,
   +protected, −compensated, ±adjusted), each carrying `reason_code`, `session_id`,
   `policy_version_id`, `created_by`, `approval_id`. `UPDATE`/`DELETE` revoked. Subscription
   balances (scheduled/completed/consumed/protected/remaining) are **derived sums**,
   materialized for speed but always reconcilable from the ledger.
4. **`outbox_event` — transactional outbox.** Written in the *same transaction* as the
   business change; a BullMQ worker drains it. Drives Merithub sync, notifications, SLA
   timers, capacity recalculation. This is what makes integration failure visible instead of
   silently corrupting state.

---

## 6. Coding Conventions

### Current build status (2026-09-04)

**Batch 1 — Identity & commercial core:** Parent/Guardian, Student, Enrollment, Subscription,
Payment, External ID Mapping, Audit Event. Verified against real Postgres 16
(migrations 0001–0008, 30 Testcontainers tests + 20 pure unit tests).

**Batch 2 — Workforce & delivery scheduling:** Employee (Phase 1 subset, built as a
prerequisite — see below), Teacher master profile, Teacher Availability + Capacity,
Coordinator Ownership, Class Schedule, Teacher Allocation, Session. Verified against real
Postgres 16 (migrations 0009–0014, 24 + 15 Testcontainers tests). Compensation/session-outcome
logic and Merithub integration are explicitly deferred to a later prompt (see migration 0012's
header) — `session.outcome` is an unconstrained nullable column and `external_id_map` already
lists `teacher`/`class_schedule`/`session` as valid mappable types, but no sync logic exists.

**Batch 3 — Governance & RBAC:** Role, Permission, Role-Permission, User-Role (effective-dated,
`own`/`all` scope), User Session, Approval Request (maker-checker infrastructure, DD §39), plus
MFA columns on the pre-existing minimal `user_account`. Migrations 0015–0016, 15 Testcontainers
tests, written test-first per the TDD mandate (see "Engineering Priorities" above). No RLS
policies added — Phase 1 scopes RLS to `audit_event` only, per the confirmed stack.

**Batch 4 — Policy, outbox, notification:** Policy Parameter (effective-dated, rule 28), Outbox
Event (layer 4 transactional outbox), Notification. Migrations 0017–0018, 16 Testcontainers
tests, written test-first. Built ahead of compensation/session-outcome logic on purpose — that
logic needs `policy_parameter` rows (compensation validity period, max reschedules) rather than
hard-coded values.

**Batch 5 — Session credit ledger:** `session_credit_ledger` (layer 3, append-only — signed
entries, `UPDATE`/`DELETE` rejected via the same `guard_append_only()` primitive already
protecting `audit.audit_event`). Migration 0019, 11 Testcontainers tests, written test-first.
Schema only — no service-layer code writing entries yet.

**Batch 6 — Compensation (rule 18):** `session.outcome` constrained to a real vocabulary
(migration 0020), `compensation` table (0021–0022), `createCompensation()` service. 14
Testcontainers tests, written test-first, all passing on the first implementation attempt. A
test asserts `class_schedule.updated_at` is unchanged before/after a compensation session is
created — rule 18's guarantee proven directly, not just asserted in a comment. Reads
`compensation_validity_days` live from `policy_parameter` (rule 28); throws
`MissingPolicyParameterError` rather than silently defaulting if unset. Compensation-qualifying
outcomes are `teacher_absent`/`teacher_technical_failure` only (rule 19).

**Batch 7 — Reschedule & cancellation cutoff:** `reschedule_request` (0023–0024),
`createReschedule()`. Reuses `session.status='rescheduled'`/`rescheduled_to_session_id` rather
than editing the original session's time in place. `cancellation_cutoff_hours` and
`max_reschedules_per_subscription` both read live from `policy_parameter`; outside the cutoff
records a `protected` ledger entry, inside records `consumed`.

**Batch 8 — Compensation completion/expiry:** `completeCompensation()`/`expireCompensations()`
close out batch 6. Completion records a `compensated` (-1) entry, netting to zero against the
earlier `protected` (+1) over a full cycle. Expiry deliberately does NOT touch the ledger (rule
17) — it only flags the record `expired`; the credit stays visible for a coordinator to act on.

**Batch 9 — Attendance:** pure `classifyAttendance()` in `packages/domain/src/delivery/`
(present/late/partial/absent per CLAUDE.md §4's thresholds), `attendance` table (0025–0026),
`recordAttendance()` reading the three attendance-threshold policy keys live.

**Batch 10 — Admission handover:** `admission_handover` (0027–0028), `createAdmissionHandover()`
(SLA deadline from `admission_allocation_sla_hours`, read live) + `acknowledgeHandover()`. Keeps
its own `sla_deadline_at` rather than depending on batch 11's generic SLA engine — the two are
deliberately uncoupled in Phase 1.

**Batch 11 — Support (ticket + SLA engine):** `sla_policy`, `ticket` (`TKT-`), `sla_instance`
(0029–0030) — a generic, reusable SLA engine (entity_type/entity_id, not ticket-specific) — plus
`createTicket()`/`resolveTicket()`/`checkSlaBreaches()`. SLA numbers come from a named
`sla_policy` row, not `policy_parameter` — SLA definitions are their own dedicated entity per DD.

**All 40 Phase 1 entities are now built**, except `session_participant` (deliberately not built —
group-class modelling is still open question A1). See `PHASE_STATUS.md` for the full batch-by-batch
breakdown. Final count: 175 db integration tests + 56 pure domain tests = 231, all passing, 30
migrations (0001–0030) apply cleanly on every fresh container.

No API layer or UI yet — this remains data-layer-and-service-layer work. What exists:

- `packages/db/migrations/0001`–`0030` — hand-authored SQL: schema, triggers, constraints,
  grants. Every `SECURITY DEFINER` function's dependencies (tables it writes to) have their
  ownership explicitly pinned to `spellzee_owner` — see
  `docs/data-model/04-history-audit-and-integrity.md` §1a. §1b of the same doc documents a
  second real finding: a DB guard trigger cannot durably self-log a "blocked" audit row via
  `audit.record_blocked()`, because `RAISE EXCEPTION` rolls back everything written earlier in
  the same transaction (Postgres has no autonomous-transaction primitive) — durable blocked-
  attempt logging is a SERVICE-layer responsibility (`recordBlockedAttempt()` in `client.ts`),
  run in a fresh transaction after the failure, not the DB trigger's job.
- `packages/db/src/schema/` — Drizzle models mirroring the SQL (SQL is the source of truth).
  `workforce.ts` (employee, teacher, capability tables, availability, capacity) and
  `operations.ts` (coordinator ownership, class schedule, teacher allocation, session) added
  in batch 2. `governance.ts` (role, permission, role_permission, user_role, user_session,
  approval_request) added in batch 3; MFA columns added directly to `reference.ts`'s
  `userAccount`. `platform.ts` (policy_parameter, outbox_event, notification) added in batch 4.
  `entitlement.ts` (session_credit_ledger) added in batch 5. `compensation.ts` added in batch 6;
  `operations.ts`'s `session.outcome` gained a real `SessionOutcome` type + `SESSION_OUTCOME`/
  `COMPENSATION_QUALIFYING_OUTCOMES` exports in the same batch. `reschedule.ts` (batch 7),
  `attendance.ts` (batch 9), `admission.ts` (batch 10), `support.ts` — sla_policy/ticket/
  sla_instance (batch 11).
- `packages/db/src/client.ts` — `withActor()`, the only supported write path; sets the
  `app.*` session variables the audit trigger requires. `recordBlockedAttempt()` added in
  batch 2 for the reason above.
- `packages/db/src/services/identity-match.service.ts` — duplicate-detection retrieval
  (SQL) + decision recording, per DD §7.
- `packages/db/src/services/allocation.service.ts` — the allocation WORKFLOW (not CRUD):
  `createAllocation()` checks teacher availability + capacity via the pure domain logic
  before writing anything, supersedes the previous allocation/schedule rather than
  overwriting (Master §14.3, rule 12), and keeps capacity bookkeeping in the same
  transaction. `changeTeacher()` is a thin wrapper for the common case.
- `packages/db/src/services/coordinator-ownership.service.ts` — `transferOwnership()`:
  every transfer is logged with a reason and effective date, superseding the previous owner
  rather than overwriting it (DD §14, rule 12).
- `packages/db/src/services/compensation.service.ts` — `createCompensation()`/
  `completeCompensation()`/`expireCompensations()`: the full rule 18/19 lifecycle (qualifying-
  outcome check, live policy reads, new session + ledger entries, class_schedule never written,
  expiry that never touches the ledger).
- `packages/db/src/services/reschedule.service.ts` — `createReschedule()`: cutoff + max-reschedule
  policy reads, replacement session, protected/consumed ledger entry per cutoff side.
- `packages/db/src/services/attendance.service.ts` — `recordAttendance()`: policy-driven
  classification via `@spellzee/domain`'s `classifyAttendance()`.
- `packages/db/src/services/admission-handover.service.ts` — `createAdmissionHandover()`/
  `acknowledgeHandover()`: SLA deadline from a live policy read.
- `packages/db/src/services/support.service.ts` — `createTicket()`/`resolveTicket()`/
  `checkSlaBreaches()`: the generic SLA engine's create/resolve/batch-check cycle.
- `packages/domain/src/identity/matching.ts` — pure duplicate-scoring logic. No I/O.
- `packages/domain/src/workforce/availability.ts` — pure availability/capacity checking
  (`checkAvailability`, `checkCapacity`, `checkAllSlots`) and date arithmetic
  (`nextOccurrenceOnOrAfter`). No I/O; this is what's unit-tested without a database.
- `packages/domain/src/delivery/attendance.ts` — pure `classifyAttendance()` (batch 9).
- `packages/db/test/*-invariants.test.ts` (11 files) — the constraint-rejection tests CLAUDE.md
  §6 requires, run via Testcontainers against real Postgres, not a mock. Every test file from
  batch 3 onward was written before its migration existed (TDD mandate) and confirmed failing
  for the right reason first.
- `packages/db/test/*-service.test.ts` (6 files: allocation, compensation, reschedule,
  attendance, admission-handover, support) — service-layer tests proving the WORKFLOW, not just
  the underlying constraints.
- `apps/`, `packages/contracts/`, `packages/config/`, `infra/` do not exist yet — build as
  those layers are implemented.

**Scope notes, recorded so they aren't re-litigated:**
- `payment` was pulled into batch 1 on explicit instruction — see §5's "Scope change" note.
- `employee` (Phase 1 subset) was pulled into batch 2 as a prerequisite for
  `coordinator_ownership.employee_id` (mandatory, DD §14) and `teacher.employee_id`
  (optional, DD §11) — confirmed with the user before building, per the spec already
  documented in `docs/data-model/02-entity-specifications.md`.
- `class_schedule.teacher_id` and `teacher_allocation.teacher_id` are two views of the same
  fact by design: `class_schedule` holds the current OPERATIONAL configuration (DD §15 lists
  Teacher ID directly on the entity), `teacher_allocation` is the auditable DECISION record
  (who/why/what it replaced). The allocation service keeps them in lockstep inside one
  transaction — this is a service-layer invariant, not a cross-table DB trigger.
- `session_participant` (multi-participant/group modelling, floated in
  `docs/data-model/02-entity-specifications.md`) was NOT built. `session` carries
  `enrollment_id`/`student_id`/`teacher_id` directly, matching DD §16's literal fields —
  simpler, and avoids modelling group classes ahead of open question A1
  (`docs/data-model/05-open-modelling-questions.md`) being resolved.
- `role_permission` follows the same capability-tag pattern as `teacher_subject`/`teacher_level`/
  `teacher_language` (batch 2): audited (attach_audit), but ordinary DELETE is allowed rather than
  the effective-dated pattern — the join itself is disposable admin config, the resulting
  `audit_event` row is what makes a permission grant/revoke attributable (rule 21). `user_role` is
  the opposite case: who-has-which-role is security-sensitive with a past that matters, so it's
  effective-dated (layer 2 history) like `teacher_allocation`/`coordinator_ownership`, not a plain
  join. `role`/`permission` themselves follow the `course`/`subject`/`level`/`language`
  reference-data pattern (audited, no delete guard, no `updated_by`-driven touch trigger).

### Repository layout (pnpm workspace + Turborepo)

```
spellzee-erp/
├── CLAUDE.md
├── docs/
│   ├── source/            # the 4 discovery PDFs
│   ├── decisions/         # ADRs
│   ├── data-model/        # logical model, ERD, lifecycle diagrams
│   └── policies/          # Master §30 open decisions, tracked to closure
├── apps/
│   ├── api/               # NestJS modular monolith
│   │   └── src/
│   │       ├── common/    # audit/ authz/ approval/ policy/  (cross-cutting)
│   │       ├── modules/   # identity governance operations delivery
│   │       │              # entitlement workforce support notifications integrations
│   │       └── jobs/      # BullMQ processors + schedules
│   └── web/               # React + Vite internal ERP SPA
│       └── src/           # app/ features/ components/ui/ lib/
├── packages/
│   ├── contracts/         # Zod schemas + generated OpenAPI types (shared api↔web)
│   ├── db/                # Drizzle schema, migrations/, seeds, trigger SQL
│   ├── domain/            # pure policy/rule engines, zero I/O
│   └── config/            # eslint, tsconfig, prettier, vitest presets
├── infra/                 # docker/, terraform/
└── .github/workflows/
```

`apps/web/src/features/` mirrors `apps/api/src/modules/` 1:1. Future apps
(`apps/parent-portal` Phase 2, `apps/teacher-app` Phase 3) slot in without restructuring.

### Naming

- Database: `snake_case`, **singular** table names (`student`, not `students`). Timestamps
  `created_at` / `updated_at` / `valid_from` / `valid_to`. Foreign keys `<entity>_id`.
- TypeScript: `camelCase` values, `PascalCase` types/classes/components, `SCREAMING_SNAKE`
  constants. Files `kebab-case.ts`; NestJS suffixes `*.service.ts`, `*.controller.ts`,
  `*.module.ts`, `*.repository.ts`.
- Enums: Postgres **check-constrained text**, not native enum types (alterable without a table
  rewrite), mirrored by a Zod enum in `packages/contracts`.
- No abbreviations in schema names except the established ID prefixes.

### Migrations

- **Forward-only, numbered SQL** in `packages/db/migrations/`. Never edit a migration after
  it merges — write a new one.
- Every business table gets the audit trigger via the shared migration helper. A table added
  without it is a bug.
- Every constraint that encodes a business rule (exclusion constraints, `CHECK
  (requester_id <> approver_id)`, ledger grant revocations) is written in SQL, in a migration.
- Destructive changes (drop column, drop table, data backfill) require an ADR in
  `docs/decisions/` and explicit user sign-off.

### Data rules

- **Money:** integer minor units + an ISO-4217 currency column. Never floats, never a bare
  `amount`.
- **Time:** `timestamptz` everywhere, UTC storage. `class_schedule` carries an IANA timezone
  and recurrence is **wall-clock**, not a fixed UTC instant — a "3 PM Monday class" stays at
  3 PM local across DST transitions.
- **Soft state:** archive/cancel via status + `valid_to`; no `DELETE` on business tables.

### Module boundaries

Enforced mechanically by `eslint-plugin-boundaries`. Modules communicate through published
service interfaces or domain events — **never** by importing another module's repository or
querying its tables directly. Without this the monolith decays and Phase 4 extraction becomes
impossible.

### Testing

- **TDD, always** (management mandate, see top of this file): failing test first, then the
  minimal code to pass it, then refactor. This is not optional and does not relax as deadlines
  approach.
- `packages/domain` (pure policy/rule engines, zero I/O) is unit-tested exhaustively with
  Vitest, including every branch of every configurable policy.
- **Every migration that adds a constraint or trigger gets a Testcontainers integration test
  proving the constraint *rejects* the bad case** — the double-booked teacher, the
  self-approval, the audit-row UPDATE, the ledger DELETE. These constraints *are* business
  logic; a mocked database tests none of it.
- Playwright covers the allocation flow and the session-outcome flow end to end.
- No PR merges with a failing test. If a test is wrong, fix the test in its own commit and say
  why.

### Documentation

- ADR required in `docs/decisions/` for any change to: identifier formats, the audit strategy,
  the approval/maker-checker model, module boundaries, or the phase scope.
- `docs/policies/` tracks the Master §30 open decisions; when the business closes one, record
  the decision and the `policy_parameter` row that implements it.

### Working style on this repo

- Read `CLAUDE.md` before acting. Prefer the Data Dictionary over your own judgment on
  entities, fields and relationships.
- When a business rule is ambiguous, **ask** — do not invent a policy. The open-parameter list
  in §4 exists precisely because these are management decisions.
- Cite the source section (DD §n / Master §n) in PR descriptions and schema comments when
  implementing a rule.

---

## 7. Scope Guard

> **Do not create Phase 2+ entities (Academic, Teacher Training, Finance, Analytics, AI) until
> explicitly instructed. Ask before expanding scope beyond what the current prompt requests.**

Phase order (Master §29): **Phase 1 Operations MVP** → Phase 2 Academic & Parent Experience →
Phase 3 Teacher & HR → Phase 4 Finance & Enterprise Controls → Phase 5 Analytics & AI.

The Phase 1 entity list in §5 is the boundary. If a task appears to require a deferred entity,
stop and ask rather than adding it.

**Enforcement mechanism**: `PHASE_STATUS.md` (repo root) is the single source of truth the
`phase-gatekeeper` sub-agent consults before any entity/module is created — it mirrors this
section's entity list, the deferred list, a live "what's built" checklist, and a log of any
explicitly user-approved exceptions. If `PHASE_STATUS.md` and this section ever disagree, that's
a bug to flag, not a choice to make silently.

---

## 8. Claude Code Configuration for This Project

This repo has project-level Claude Code sub-agents and skills configured so that scope discipline
and business-rule compliance are enforced mechanically, not just by convention. See `WORKFLOWS.md`
for how they chain together on recurring tasks.

**Sub-agents** (`.claude/agents/`) — backend/data-layer only for now, since Phase 1 has no
API/frontend code yet:
- `schema-guardian` — Data Dictionary compliance (entities, fields, identifier format).
- `business-rules-auditor` — reviews diffs against the 31 numbered rules in §4.
- `integration-mapper` — external-ID-mapping pattern for Merithub/TeliCRM/Delicio/FreeJump/WhatsApp.
- `history-audit-architect` — correct history layer (§5's four-layer model) + rejection-test coverage.
- `phase-gatekeeper` — scope-only check against `PHASE_STATUS.md`; the enforcement arm of §7.

**Skills** (`.claude/skills/`):
- `new-entity` — scaffold a new Phase-approved entity end-to-end.
- `add-state-transition` — add/change a lifecycle-status field with explicit legal transitions.
- `add-maker-checker-flow` — wire a sensitive action through `approval_request` with a DB-level
  self-approval guard.
- `add-external-integration` — new external-system touchpoint via `external_id_map` +
  `outbox_event`.
- `add-effective-dated-history` — apply the layer-2 versioning pattern to an entity that needs it.
- `policy-parameter-change` — change a configurable value as a new effective-dated
  `policy_parameter` row.

A future session adding API (`apps/api`) or frontend (`apps/web`) code should extend this roster
with NestJS-module and React-feature-focused agents/skills once real conventions exist to ground
them — not before.
