---
name: policy-parameter-change
description: Change a value in the open policy-parameter list (cancellation cutoff, SLA hours, reschedule limits, attendance thresholds, etc.) as a new effective-dated policy_parameter row, never a hard-coded constant. Use when a business rule's numeric/configurable value needs to change.
---

# Policy parameter change

Rule 28 (CLAUDE.md §4): business rules must be configurable, not hard-coded, and every policy-driven
decision stamps the rule/criteria version it was decided under.

## Steps

1. Identify whether this value already has a `policy_parameter` row (check CLAUDE.md §4's "Accepted
   working defaults" table — cancellation cutoff, ticket SLA, compensation validity, max reschedules,
   attendance thresholds, etc. are all seeded there already).
2. Never edit a settled `policy_parameter` row's value in place — insert a new effective-dated row (same
   pattern as layer 2 history: `valid_from`, superseding the previous value) so old decisions stay
   interpretable under the rule version that was actually in force at the time (rule 28).
3. Stamp `source`: `'engineering_default'` if this is still an unratified working assumption, or
   `'business_ratified'` with `ratified_at` set if the business has actually confirmed it. Never silently
   promote an engineering default to ratified without an explicit business confirmation — CLAUDE.md §4 is
   explicit that reports and parent-facing surfaces must not present an unratified policy as company
   policy.
4. Confirm every service reading this parameter reads it live from `policy_parameter` (joined/queried at
   decision time) — not a cached constant, an enum, or a value copied into application config.
5. Update `docs/policies/` with the decision (what changed, who decided it, when) and, if the value
   itself changed, update CLAUDE.md §4's "Accepted working defaults" table to match.

## Always

- TDD: write a test proving the service reads the NEW value live before changing the row, so the test
  fails against the old value first, then passes once the new row is inserted.
- Insert a new effective-dated row — never UPDATE a settled policy value in place.
- Stamp `source` accurately; don't let an engineering default masquerade as business-ratified.
- Verify no service has hard-coded the old value as a fallback/default that would silently diverge from
  the new `policy_parameter` row.
