---
name: add-maker-checker-flow
description: Wire a new sensitive action through the approval_request / maker-checker pattern, with a DB-level self-approval guard, per Master Draft 3 Section 22 and CLAUDE.md rule 22. Use when adding an action that should require a second person's approval before taking effect.
---

# Add a maker-checker approval flow

Rule 22 (CLAUDE.md §4): maker and checker are separated for sensitive actions, enforced by a DB
`CHECK`, not only the UI.

## Steps

1. Confirm this action is actually "sensitive" per Master §22 — not every status change needs
   maker-checker. If unclear, ask rather than assuming; over-applying approval gates is its own kind of
   scope creep.
2. Decide what "the change" is: the exact before/after state this approval gates. It gets recorded as
   the pending change (JSONB is fine for the proposed new values) on `approval_request`.
3. The DB-level guard is non-negotiable: `CHECK (requester_id <> approver_id)` on `approval_request` (or
   the equivalent column names for this flow) so self-approval is structurally impossible, not just
   blocked in application code.
4. The action's actual effect must not apply until the approval is granted — model this as two steps:
   (a) write the `approval_request` row and stop, (b) a separate approve-and-apply path that checks the
   request's status is `approved` and the approver isn't the requester before executing the real change.
5. The audit trail must capture both the request and the approval as distinct events (rule 21) — who
   requested, who approved, when, and the reason for both.
6. Write a rejection test proving self-approval is blocked at the DB layer (not just that the happy path
   with two different actors succeeds).

## Always

- TDD: write the self-approval-rejection test first (expect it to fail because the `CHECK` doesn't
  exist yet), then add the constraint.
- Enforce `requester_id <> approver_id` as a DB `CHECK`, never only an application-layer if-statement.
- Never let the sensitive action take effect before approval — no "optimistic apply, roll back if
  rejected" shortcut.
- Add a rejection test for the self-approval case specifically.
