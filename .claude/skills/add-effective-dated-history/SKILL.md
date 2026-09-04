---
name: add-effective-dated-history
description: Add the valid_from/valid_to/is_current/superseded_by_id/change_reason versioning pattern to an entity that needs "current state with a past" (teacher_allocation, coordinator_ownership, contact_history, class_schedule style). Use when an entity needs history-preserving updates instead of overwrite-in-place.
---

# Add effective-dated history (layer 2 of the four-layer history model)

For entities where a change should be visible as a NEW row superseding the old one — never an UPDATE
of the substantive fields in place (rule 12: teacher changes and coordinator ownership changes create
history, not overwrites).

## Steps

1. Confirm this entity actually needs this pattern — it's for "current state that changes over time and
   whose past states matter" (an allocation, an ownership assignment, a schedule version). A pure
   transactional fact (a payment, a session occurrence) does NOT need this — it needs the audit trigger
   (layer 1) or the ledger pattern (layer 3) instead, not this one.
2. Add the columns: `valid_from timestamptz NOT NULL DEFAULT now()`, `valid_to timestamptz`,
   `is_current boolean NOT NULL DEFAULT true`, `superseded_by_id uuid REFERENCES <same_table>(id)`,
   `change_reason text`, `requested_by`/`approved_by` if this change should be attributable to a person
   beyond the generic audit actor.
3. Add a partial unique index enforcing "at most one current row per subject" — e.g.
   `CREATE UNIQUE INDEX ..._current_uq ON <table> (<subject_id>) WHERE is_current;` (see
   `class_schedule_current_uq`, `teacher_allocation_current_uq`, `coordinator_ownership_current_uq` for
   the exact pattern).
4. Add a `CHECK` that a current row has `valid_to IS NULL AND superseded_by_id IS NULL`, and a non-self-
   supersession check (`superseded_by_id IS NULL OR superseded_by_id <> id`).
5. Write the change path as a service function (never a bare UPDATE from the application) doing, inside
   one transaction: (a) close the old current row — `is_current = false`, `valid_to = <effective time>`,
   `change_reason = ...`; (b) insert the new row; (c) update the old row's `superseded_by_id` to point at
   the new row's id. See `packages/db/src/services/allocation.service.ts` and
   `coordinator-ownership.service.ts` for the reference implementation.
6. Write a rejection test proving the partial unique index blocks two simultaneous current rows for the
   same subject, and a service-layer test proving the supersession chain is queryable (old row still
   exists, points to new row).

## Always

- TDD: write the "two simultaneous current rows rejected" test first, confirm it fails without the
  partial unique index, then add the index.
- Supersede-then-insert-then-link inside one transaction — never UPDATE the substantive fields in place.
- Enforce "one current row per subject" with a DB-level partial unique index, not just application logic.
- Keep both old and new rows permanently queryable — this is what makes the history real, not cosmetic.
