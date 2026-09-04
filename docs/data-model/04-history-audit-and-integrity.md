# 04 — History, Audit & Integrity Model (Phase 1)

How the four history layers from `CLAUDE.md` §5 apply to the actual Phase 1 entities, and every
business rule that is enforced by the **database** rather than by application code.

The governing requirement (DD §41): audit records for critical actions must be *"protected from
ordinary editing/deletion."* That is only achievable at the storage layer.

---

## 1. Which layer applies to which entity

| Layer | Mechanism | Entities |
|---|---|---|
| **1. Audit log** | `audit_event`, written by trigger on every business table | All 40 tables |
| **2. Effective-dated business history** | `valid_from`/`valid_to`/`is_current`/`superseded_by_id` columns | `teacher_allocation`, `coordinator_ownership`, `contact_history`, `class_schedule`, `student_parent_link`, `teacher_availability`, `teacher_capacity`, `user_role`, `sla_policy`, `policy_parameter` |
| **3. Append-only ledger** | `INSERT` only; `UPDATE`/`DELETE` revoked | `session_credit_ledger`, `audit_event` |
| **4. Transactional outbox** | Same-transaction write, async drain | `outbox_event` |

Everything else is an ordinary mutable table protected by Layer 1 alone.

**Do not confuse layers 1 and 2.** A question like *"who taught this student in March?"* is
answered by layer 2 with a plain `WHERE` clause. If you find yourself reconstructing business
state by replaying `audit_event`, the entity needed layer 2 and didn't get it.

---

## 1a. Object ownership — a bootstrap-order trap worth naming

`audit.record_change()` and `audit.ensure_partition()` are `SECURITY DEFINER`, running
with the privileges of whichever role owns them (`spellzee_owner`), regardless of who
calls them. That only works if every object those functions touch — `audit.audit_event`,
its default and monthly partitions, and `identifier_sequence` (used to mint the audit
row's own `AUD-` id) — is **also** owned by `spellzee_owner`.

Object ownership in Postgres defaults to whichever role ran the `CREATE`. If migrations
are ever applied by a bootstrapping superuser rather than `spellzee_owner` itself — a
real scenario for a fresh managed-Postgres instance — that default silently produces a
database where the audit trigger cannot write to its own table. This was caught during
manual verification of migrations 0001–0002 against a real Postgres 16 instance: the
trigger failed with `permission denied for table identifier_sequence` the first time
migrations were applied as `postgres` rather than `spellzee_owner`.

**Fix, and the pattern to repeat:** every table a `SECURITY DEFINER` function writes to
gets an explicit `ALTER TABLE ... OWNER TO spellzee_owner` (or `ALTER SCHEMA`) in the same
migration that creates it — never left implicit. See migrations 0001 and 0002. A
regression test (`packages/db/test/invariants.test.ts`, "migration ownership is
bootstrap-role independent") asserts the ownership directly so this cannot regress
silently. Apply the same pattern to any future `SECURITY DEFINER` function (the
maker-checker approval interceptor, when it arrives, is the next likely candidate).

## 1b. Blocked attempts cannot self-log — Postgres has no autonomous transactions

`audit.record_blocked()` (DD §41's `outcome = 'blocked'`) exists so a refused attempt is
evidence, not silence. It is tempting to call it from inside the very guard trigger that
is about to `RAISE EXCEPTION` — that was tried while building
`guard_teacher_allocation_eligible()` (rule 25) and caught by live-database verification:
the `RAISE EXCEPTION` aborts the **entire enclosing transaction**, and Postgres has no
autonomous-transaction primitive, so the `record_blocked()` row written a few lines
earlier in the same transaction is rolled back along with everything else. The blocked
attempt vanishes — the opposite of the intent.

**The fix is layered, not a single mechanism:**

- DB guard triggers (`guard_teacher_allocation_eligible`, `guard_no_delete`, etc.) just
  `RAISE EXCEPTION` — reliably blocking the write — and do **not** attempt to self-log.
  They remain the defense-in-depth backstop against any code path that bypasses the
  service layer, but a bypass-path block is visible only as a surfaced error, not as a
  durable audit row.
- The **service layer** is where blocked attempts get durable evidence. A service
  pre-checks the same rule *before* attempting the write (exactly what "check teacher
  availability + capacity before confirming" already requires), so the DB trigger is a
  backstop that rarely fires in practice. When the service's own pre-check fails, or when
  it catches the DB guard's exception, it calls `recordBlockedAttempt()`
  (`packages/db/src/client.ts`) — which runs in a **fresh transaction**, unaffected by the
  failed one — to persist the blocked-outcome audit row.

Apply this pattern to every future guard: never call `record_blocked()` from inside the
transaction that is failing. Log from the catching service, afterward, in a new one.

## 2. Audit capture — how the actor gets in

The trigger cannot know who the user is. The application must tell it, per transaction:

```sql
-- NestJS middleware, at the start of every request transaction
SET LOCAL app.actor_id       = '<user_account uuid>';
SET LOCAL app.session_id     = '<user_session uuid>';
SET LOCAL app.correlation_id = '<request/job/webhook id>';
SET LOCAL app.source         = 'ui';       -- ui | api | webhook:merithub | job | migration
SET LOCAL app.reason         = '<optional>';
```

The trigger function reads these with `current_setting('app.actor_id', true)` and **raises if
it is null**. Consequences, all intentional:

- A background job must set an actor (a service account) or it cannot write.
- A webhook handler must set `source = 'webhook:merithub'`, so integration-caused changes are
  distinguishable from human ones.
- A migration must set `source = 'migration'`.
- Nobody can write business data anonymously, including a developer at a `psql` prompt.

### Grants

```sql
REVOKE UPDATE, DELETE ON audit.audit_event            FROM spellzee_app;
REVOKE UPDATE, DELETE ON public.session_credit_ledger FROM spellzee_app;
```

The application role can only `INSERT` into these. Corrections are new compensating rows
(DD §10). Partitioned monthly on `occurred_at`; retention 7 years per `CLAUDE.md` §4.

### What is *not* audited

Reference/master data reads, `outbox_event` churn, and `user_session` heartbeat updates. Audit
business tables only — otherwise `audit_event` fills with noise and the signal is lost
(`CLAUDE.md` trade-off 1).

---

## 3. Database-enforced business rules

Each rule below is enforced in SQL, in a migration, with a Testcontainers test proving it
**rejects** the bad case. This is the list that makes the invariants real rather than aspirational.

| # | Rule | Enforcement |
|---|---|---|
| 1 | Teacher is never double-booked | `EXCLUDE USING gist (teacher_id WITH =, tstzrange(scheduled_start_at, scheduled_end_at) WITH &&) WHERE (status NOT IN ('Cancelled','Rescheduled'))` on `session` |
| 2 | Student ID never changes (rule 1) | `BEFORE UPDATE` trigger on `student` raising if `public_id` differs |
| 3 | Exactly one primary guardian per student | Partial unique index on `student_parent_link (student_id) WHERE is_primary_contact AND is_current` |
| 4 | One current allocation per enrollment (rule 12) | Partial unique index on `teacher_allocation (enrollment_id) WHERE is_current` |
| 5 | One current ownership per (student, role) | Partial unique index on `coordinator_ownership (student_id, ownership_role) WHERE is_current` |
| 6 | One current schedule per enrollment | Partial unique index on `class_schedule (enrollment_id) WHERE is_current` |
| 7 | Effective-dated rows never overlap | `EXCLUDE USING gist (subject_id WITH =, daterange(valid_from, valid_to) WITH &&)` on each layer-2 table |
| 8 | No self-approval (rule 22) | `CHECK (approver_user_id IS NULL OR approver_user_id <> requester_user_id)` on `approval_request` |
| 9 | Ledger is append-only (rule 14) | `REVOKE UPDATE, DELETE`; plus a `BEFORE UPDATE OR DELETE` trigger raising unconditionally |
| 10 | Audit is tamper-evident (rule 23) | Same treatment as #9 |
| 11 | Compensation never alters the recurring schedule (rule 18) | Constraint trigger: raises if a `class_schedule` row is modified in a transaction that inserts into `compensation` |
| 12 | A compensation's fulfilling session is marked as such | `CHECK` via trigger: any session referenced as `compensation_session_id` must have `session_purpose = 'compensation'` |
| 13 | Ineligible teachers cannot be allocated (rule 25) | `BEFORE INSERT` trigger on `teacher_allocation` raising when `teacher.is_allocation_eligible = false` |
| 14 | Every terminal session yields exactly one ledger entry per participant (rule 17) | Deferred constraint trigger at commit; plus a nightly reconciliation job that alarms on drift |
| 15 | Money is never a float | `bigint` minor units + `char(3)` currency, `CHECK (currency ~ '^[A-Z]{3}$')` |
| 16 | External IDs live only in the mapping table (rule 26) | Convention + a CI check failing any migration adding a column matching `%merithub%`, `%telicrm%`, `%external_id%` outside `external_id_map` |
| 17 | No actor, no write | Audit trigger raises when `app.actor_id` is unset |
| 18 | Critical records are archived, not deleted (rule 13) | `REVOKE DELETE` on `student`, `enrollment`, `subscription`, `session`, `ticket`, `teacher_allocation` from the app role |
| 19 | Policy-driven decisions are version-stamped (rule 28) | `NOT NULL` `policy_parameter_version_id` on `session_credit_ledger`, `compensation`, `sla_instance` |
| 20 | Every session has at least one participant | Deferred constraint trigger at commit |

> **#18 is the one people push back on.** Yes, it means a typo'd student cannot be deleted — it
> is archived with a reason. That is precisely what DD §2 and Master §22.6 require, and it is
> the difference between an ERP and a spreadsheet.

---

## 4. Reconstruction guarantees

The model must answer these without ambiguity. Each is a query, not an investigation:

| Question | Answered by | Layer |
|---|---|---|
| Who taught this student in March 2026? | `teacher_allocation WHERE enrollment_id = ? AND daterange(valid_from, valid_to) @> '2026-03-15'` | 2 |
| Why did this student's teacher change? | Same row's `change_reason`, `requested_by`, `approved_by` | 2 |
| Who owned this student when the complaint came in? | `coordinator_ownership` at that timestamp, by role | 2 |
| Where did this session's credit go? | `session_credit_ledger WHERE session_id = ?` | 3 |
| Does the subscription balance reconcile? | `SUM(quantity)` vs the materialised column | 3 |
| Who changed this parent's phone number, when, and why? | `audit_event WHERE entity_type='contact_history'` | 1 |
| What did someone try to do and get blocked from doing? | `audit_event WHERE outcome='blocked'` | 1 |
| Which Merithub sync failed and why? | `outbox_event WHERE status='failed'` + `external_id_map.sync_error` | 4 |
| What was the cancellation policy on the day this credit was consumed? | `policy_parameter` row referenced by the ledger entry's `policy_parameter_version_id` | 3 |

That last one is the point of rule 28: a ledger entry from six months ago stays interpretable
after the policy changes.

---

## 5. Student 360 (DD §48) — a view, not a table

Assembled from: `student` + current `student_parent_link` + `contact_history` (current) +
`enrollment` (all) + `subscription` + derived ledger balances + current and historical
`teacher_allocation` + `class_schedule` + `session` history + `attendance` + `compensation`
(incl. backlog) + `coordinator_ownership` (current and historical) + `ticket` + `audit_event`
timeline.

**Never denormalise these onto `student`.** DD §6.2 lists them as links; the moment they become
columns they drift, and the drift is silent — which is exactly what this whole architecture
exists to prevent.

Academic progress, lessons, assessments, communications and retention health are **Phase 2+**
and will extend this view later. The Phase 1 Student 360 is deliberately incomplete.

---

## 6. Data quality checks (DD §47)

Implemented as scheduled jobs writing to an ops dashboard, not as silent fixes:

1. Subscription balance vs ledger sum — drift alarms.
2. Terminal sessions with no ledger entry (rule 17 violation).
3. Enrollments `Active` with no current allocation or no current schedule.
4. Effective-dated tables with zero or multiple `is_current` rows per subject.
5. Sessions whose `teacher_id` disagrees with the allocation current at their scheduled time.
6. `external_id_map` rows with `sync_status = 'error'` older than N hours.
7. Compensation past `valid_until` still in `Approved`/`Scheduled`.
8. `outbox_event` stuck beyond max attempts.
9. Orphaned sessions — schedule cancelled but future sessions still `Scheduled`.
10. Audit gap detection: business rows whose `updated_at` has no corresponding `audit_event`.

Check 10 is the meta-check — it catches a table that was created without its audit trigger.
