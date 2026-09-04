---
name: add-state-transition
description: Add or modify a lifecycle-status field on an existing entity (session.status, class_schedule.status, ticket.status, etc.), with explicit legal-transition enforcement rather than an unconstrained text field. Use when a status/lifecycle field needs adding or its transitions need changing.
---

# Add a controlled state transition

Many Spellzee entities carry a status column whose values must follow a defined lifecycle, not
arbitrary changes (rule 7, rule 9's allocation state, session status per DD §16).

## Steps

1. Enumerate every legal status value and, explicitly, every legal transition between them (e.g.
   `scheduled -> confirmed -> live -> completed`, plus the exception paths like `-> cancelled` or
   `-> rescheduled`). Write this out before touching SQL.
2. Decide the enforcement point:
   - A simple linear/branching lifecycle: a `CHECK` constraint on the column values, plus a trigger that
     validates the OLD -> NEW transition on UPDATE (reject the illegal jump, e.g. `scheduled ->
     completed` skipping `live`).
   - A lifecycle with side effects (capacity release, ledger entries, notifications): a service-layer
     function is the only supported write path for that transition — never a bare UPDATE from the
     application.
3. Decide if any transition needs maker-checker (e.g. does moving to this status require someone other
   than the requester to approve?). If yes, use the `add-maker-checker-flow` skill for that transition
   specifically rather than bolting on an ad hoc approval field.
4. Add the CHECK/trigger in a migration, following the existing pattern in
   `packages/db/migrations/0012_class_schedule_session.sql` and `0013_teacher_allocation.sql` (see
   `guard_allocation_student_matches_enrollment`-style guard triggers).
5. Write a rejection test proving at least one illegal transition is blocked, not just that the legal
   path works.
6. If the status change should be visible downstream (a notification, a Merithub sync, an SLA timer),
   write to `outbox_event` in the same transaction — never fire the side effect inline.

## Always

- TDD: write the legal- and illegal-transition tests first, confirm they fail (no CHECK/trigger yet),
  then add the constraint/trigger to make them pass.
- Enumerate the full transition graph before writing the constraint — an unconstrained status column
  masquerading as a lifecycle is a bug, not a shortcut.
- Add a rejection test for at least one illegal transition.
- Route side-effecting transitions through a service function, not a bare table UPDATE.
