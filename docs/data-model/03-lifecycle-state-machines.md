# 03 — Lifecycle State Machines (Phase 1)

DD §47 requires **status-transition validation** as a data-quality control. This document
defines the legal states and transitions for every stateful Phase 1 entity. Anything not drawn
here is an illegal transition and must be rejected.

Implementation note: these become XState machines in `packages/domain` (pure, exhaustively
unit-tested) plus a `CHECK`-backed transition table in the database. The application never
writes a status directly — it dispatches an event and the machine decides.

---

## Student — DD §6.1

```mermaid
stateDiagram-v2
    [*] --> Active
    Active --> Break : break_started
    Break --> Active : resumed
    Active --> Completed : all_enrollments_completed
    Active --> Cancelled : cancelled
    Break --> Cancelled : cancelled
    Active --> Inactive : no_active_enrollment
    Inactive --> Active : new_enrollment
    Completed --> Active : returned
    Active --> Merged : merge_approved
    Cancelled --> [*]
    Merged --> [*]
```

- **`Completed → Active` is legal and important.** A returning student reuses the same
  identity — rule 2. No new `STU-` is ever issued to a returning family.
- `Merged` is terminal for the *source* record only, which is **retained** with
  `merged_into_student_id` set (rule 4). No delete.
- Lead/Prospect states are deliberately absent — DD §6.1 says leads are handled separately,
  and Sales stays in Delicio/TeliCRM for Phase 1.

---

## Enrollment — DD §8

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Active : allocation_confirmed
    Pending --> Cancelled : cancelled_before_start
    Active --> Paused : break_started
    Paused --> Active : resumed
    Active --> Completed : entitlement_exhausted
    Active --> Cancelled : cancelled
    Paused --> Cancelled : cancelled
    Completed --> [*]
    Cancelled --> [*]
```

`Pending → Active` requires a current `teacher_allocation` **and** a current `class_schedule`.
An enrollment cannot go Active without both — allocation is teacher *plus* schedule (rule 9).

`end_reason` is mandatory on every transition into `Completed`, `Cancelled` or `Paused`
(DD §8).

---

## Subscription — DD §9

```mermaid
stateDiagram-v2
    [*] --> Active
    Active --> Exhausted : remaining_credits_zero
    Active --> Expired : valid_until_passed
    Exhausted --> Active : credits_added
    Expired --> Active : validity_extended
    Active --> Cancelled : cancelled
    Exhausted --> Renewed : renewal_purchased
    Expired --> Renewed : renewal_purchased
    Cancelled --> [*]
    Renewed --> [*]
```

- `Exhausted` and `Expired` are **distinct**: out of sessions vs out of time. A subscription can
  be either without being both.
- Both are **reversible** — a compensation credit or an approved validity extension reopens it.
  Modelling these as terminal would break the compensation backlog (Master §25.1).
- `Renewed` points forward to the new subscription; the old record is retained.
- **No transition writes a balance.** Every balance change is a `session_credit_ledger` entry;
  status is derived from the ledger sum and `valid_until`.

---

## Admission Handover — Master §8

```mermaid
stateDiagram-v2
    [*] --> Received
    Received --> VerificationPending : sla_started
    VerificationPending --> Verified : parent_confirmed
    VerificationPending --> Unreachable : max_attempts_exhausted
    Unreachable --> VerificationPending : contact_reattempted
    Verified --> Matching : requirements_captured
    Matching --> AllocationProposed : teacher_matched
    AllocationProposed --> Allocated : coordinator_confirmed
    Allocated --> Closed : first_class_completed
    Received --> Cancelled : admission_reversed
    VerificationPending --> Cancelled : admission_reversed
    Closed --> [*]
    Cancelled --> [*]
```

The SLA clock starts on entry to `VerificationPending` and stops on entry to `Allocated`
(the accepted default in `CLAUDE.md` §4 — 24h, unratified). `Unreachable` is a *pause*
condition candidate for the SLA policy — see [05](05-open-modelling-questions.md).

---

## Teacher Allocation — DD §13 (effective-dated)

```mermaid
stateDiagram-v2
    [*] --> Proposed
    Proposed --> PendingApproval : requires_approval
    Proposed --> Active : auto_approved
    PendingApproval --> Active : approved
    PendingApproval --> Rejected : rejected
    Active --> Superseded : replaced_by_new_allocation
    Active --> Ended : enrollment_ended
    Rejected --> [*]
    Superseded --> [*]
    Ended --> [*]
```

**`Active → Superseded` never UPDATEs the row's substance.** It sets `valid_to`, `is_current =
false` and `superseded_by_id`, then inserts a new row. Rule 12: teacher changes create history.

`Proposed → Active` is **blocked** when `teacher.is_allocation_eligible = false` (rule 25),
and blocked when the teacher's capacity for the slot is exhausted.

---

## Class Schedule — DD §15 (versioned)

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Active : confirmed_and_synced
    Draft --> Discarded : abandoned
    Active --> Superseded : schedule_changed
    Active --> Paused : student_break
    Paused --> Active : resumed
    Active --> Ended : enrollment_completed
    Active --> Cancelled : enrollment_cancelled
```

`Draft → Active` requires a successful Merithub class creation, or an explicit
operator override recorded with a reason. Rule 27 — a schedule must not silently go live while
the LMS believes it does not exist.

**A compensation session never causes a schedule transition** (rule 18).

---

## Session — DD §16, Master §15.1

```mermaid
stateDiagram-v2
    [*] --> Scheduled
    Scheduled --> ReminderSent : reminder_dispatched
    ReminderSent --> Confirmed : parent_confirmed
    Scheduled --> Live : started
    ReminderSent --> Live : started
    Confirmed --> Live : started
    Live --> Completed : ended
    Scheduled --> Cancelled : cancelled
    ReminderSent --> Cancelled : cancelled
    Confirmed --> Cancelled : cancelled
    Scheduled --> Rescheduled : reschedule_applied
    ReminderSent --> Rescheduled : reschedule_applied
    Live --> Abandoned : technical_failure
    Completed --> [*]
    Cancelled --> [*]
    Rescheduled --> [*]
    Abandoned --> [*]
```

On entry to any terminal state, an **`outcome`** must be set. The outcome — not the status —
drives credit impact and compensation.

### Session outcome → credit impact

> **This is the highest-risk table in the model.** It decides whether a parent's purchased
> session is consumed or protected. Every value below is an **engineering default**
> (`source = 'engineering_default'`, `ratified_at = NULL`) and requires business ratification
> before go-live. Every row is resolved from `policy_parameter` at decision time and stamped
> onto the ledger entry with its version — never hard-coded.

| Outcome | Credit impact | Compensation | Source |
|---|---|---|---|
| Attended / Completed | `consumed` −1 | No | Master §15.1 |
| Partial attendance (≥ threshold) | `consumed` −1 | No | DD §17 — threshold is policy |
| Partial attendance (< threshold) | `protected` | **Yes** | [ENGINEERING] |
| Student absent / no-show | `consumed` −1 | No | Master §15.1 |
| Parent advance cancellation (outside cutoff) | `protected` | No — session released, not owed | Master §15.3 |
| Parent late cancellation (inside cutoff) | `consumed` −1 | No | Master §15.3 |
| Teacher absent | `protected` | **Yes** | Master §15.4 |
| Teacher-side technical issue | `protected` | **Yes** | Master §15.4 |
| Spellzee cancellation | `protected` | **Yes** | Master §15.4 |
| Student-side technical issue | `consumed` −1 (one goodwill exception per subscription) | No | [ENGINEERING] — Master §30 explicitly open |
| Rescheduled | no ledger entry | No | The moved session carries the credit |
| Compensation session completed | `compensated` −1 | — | Master §15.7 |

**Invariant (rule 17):** every terminal session outcome produces **exactly one**
`session_credit_ledger` entry per participant, except `Rescheduled` which produces none. A
terminal session with no ledger entry is a reconciliation failure and must alarm.

---

## Attendance — DD §17

```mermaid
stateDiagram-v2
    [*] --> Recorded
    Recorded --> PendingCorrection : correction_requested
    PendingCorrection --> Corrected : correction_approved
    PendingCorrection --> Recorded : correction_rejected
```

Corrections require `correction_reason`, `corrected_by` and `approved_by` (DD §17). The
original values are preserved in `audit_event` — the correction overwrites nothing that cannot
be recovered.

---

## Compensation — DD §18

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Approved : eligibility_confirmed
    Pending --> Rejected : not_eligible
    Approved --> Scheduled : compensation_session_created
    Scheduled --> Completed : session_completed
    Scheduled --> Rescheduled : moved
    Rescheduled --> Scheduled : rebooked
    Approved --> Expired : validity_elapsed
    Scheduled --> Expired : validity_elapsed
    Approved --> Cancelled : cancelled
    Completed --> [*]
```

- `reschedule_count` increments on every `Scheduled → Rescheduled`; the max is a policy
  parameter (default 3, unratified).
- `Expired` releases the protected credit per policy — currently it **stays protected** rather
  than being consumed, pending ratification. This is a real money question:
  see [05](05-open-modelling-questions.md).
- **No transition here may touch `class_schedule`** (rule 18).

---

## Reschedule Request — DD §19

```mermaid
stateDiagram-v2
    [*] --> Requested
    Requested --> CapacityChecked : availability_evaluated
    CapacityChecked --> PendingApproval : requires_approval
    CapacityChecked --> Approved : within_coordinator_authority
    PendingApproval --> Approved : approved
    PendingApproval --> Rejected : rejected
    CapacityChecked --> Rejected : no_capacity
    Approved --> Applied : change_effected
    Applied --> [*]
    Rejected --> [*]
```

`Applied` is the only state that mutates a session or schedule, and it does so by
**superseding**, never by editing in place.

---

## Ticket — DD §31, Master §20

```mermaid
stateDiagram-v2
    [*] --> Open
    Open --> InProgress : assigned_and_started
    InProgress --> Resolved : resolution_recorded
    Resolved --> Closed : closure_confirmed
    Resolved --> Reopened : parent_not_satisfied
    Reopened --> InProgress : reassigned
    Open --> Escalated : sla_breached_or_manual
    InProgress --> Escalated : sla_breached_or_manual
    Escalated --> InProgress : ownership_accepted
    Closed --> [*]
```

`Resolved` requires a `resolution`. `Escalated` is a state, not a flag, because ownership
genuinely changes — and that change writes a `coordinator_ownership` row with
`ownership_role = 'escalation'` (rule 12).

---

## SLA Instance — DD §32

```mermaid
stateDiagram-v2
    [*] --> Running
    Running --> Warned : warning_threshold_reached
    Warned --> Met : resolved_in_time
    Running --> Met : resolved_in_time
    Warned --> Breached : target_passed
    Running --> Breached : target_passed
    Breached --> Met : resolved_late
    Running --> Paused : pause_condition_met
    Warned --> Paused : pause_condition_met
    Paused --> Running : pause_condition_cleared
```

`Breached → Met` is deliberate: late resolution must still be recorded as resolution, while the
breach remains permanently visible in history. Overwriting the breach would violate rule 11.

---

## Approval Request — DD §39

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Approved : approved_by_other_user
    Pending --> Rejected : rejected
    Pending --> Withdrawn : withdrawn_by_requester
    Pending --> Expired : decision_window_elapsed
    Approved --> Applied : change_effected
    Approved --> Failed : application_error
```

`Pending → Approved` is **blocked at the database level** when the approver equals the
requester (rule 22). `Approved → Applied` is separate from approval itself so that a failure to
apply an approved change is visible rather than silently lost.

---

## Cross-cutting transition rules

1. Every transition writes an `audit_event` with `old_value`/`new_value` — by trigger, not by
   application code (rule 21).
2. Every transition into a terminal or exceptional state requires a **reason**.
3. No status column is ever written directly by application code; the machine decides and the
   database validates against the transition table.
4. A transition that fails its guard writes an audit row with `outcome = 'blocked'`. Blocked
   attempts are evidence — DD §41 lists `blocked` as a first-class outcome.
