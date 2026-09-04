---
name: new-entity
description: Scaffold a new Phase-approved entity end-to-end - migration, Drizzle schema, service layer if needed, audit hooks, and rejection tests, following Spellzee's exact conventions. Use when asked to add a new table/entity to the data model.
---

# New entity

Scaffolds one entity fully, matching the pattern already established in
`packages/db/migrations/0001`-`0014` and `packages/db/src/schema/`.

## Steps

1. **Phase check first.** Confirm the entity is on the current phase's approved list in
   `PHASE_STATUS.md`. If not, stop — do not scaffold anything, even a draft. Ask the user for an
   explicit exception if they insist.
2. **Cite the source.** Find the entity's field list in the Data Dictionary
   (`docs/source/Spellzee_ERP_Data_Architecture_Data_Dictionary_Draft_1.pdf`) and note the DD section
   number — it goes in the migration's header comment.
3. **TDD — write the rejection/invariant tests first** (`packages/db/test/`), against a
   migration file that doesn't exist yet. Run them and confirm they fail for the right reason
   (table/constraint missing), then write the migration in step 4 to make them pass. Do not
   write the migration before the test exists — see CLAUDE.md's TDD mandate.
4. **Write the migration** (`packages/db/migrations/00NN_<entity>.sql`):
   - `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`.
   - `public_id text NOT NULL UNIQUE DEFAULT next_public_id('PREFIX')` per CLAUDE.md §3's prefix table,
     with a `CHECK (public_id ~ '^PREFIX-\d{4}-\d{6}$')`.
   - Every field from the DD section, correctly typed (money = integer minor units + currency; time =
     `timestamptz`; enums = check-constrained text).
   - `created_at`/`updated_at`/`created_by`/`updated_by`/`source` audit columns matching the existing
     pattern.
   - If this entity needs effective-dated history (ask: "is this current-state-with-a-past, like
     teacher_allocation?") — add `valid_from`/`valid_to`/`is_current`/`superseded_by_id`/`change_reason`
     and a partial unique index for "one current row per subject."
   - Attach the audit trigger via the shared `attach_audit()` helper (see 0014 for the pattern) — never
     skip this.
   - Add `guard_no_delete` unless the table is a pure current-state capability/tag table (like
     `teacher_subject`) that's explicitly allowed ordinary DELETE — document why if so.
5. **Write the Drizzle schema model** (`packages/db/src/schema/<domain>.ts`) mirroring the SQL exactly —
   SQL is the source of truth, Drizzle reflects it. Export any status/enum const arrays with derived
   types.
6. **Service layer, only if there's a workflow** (not just CRUD) — e.g. an allocation-style pre-check,
   a supersession pattern, a maker-checker gate. If so, write the service-level test (e.g. "blocked
   allocation makes zero writes") before the service function, same TDD rule as step 3. Plain CRUD
   entities don't need a service file.
7. **Confirm every test written in step 3 (and step 6, if applicable) now passes**, and add a
   happy-path test if step 3 didn't already cover one.
8. **Update CLAUDE.md's build-status section** and `PHASE_STATUS.md`'s checklist once verified.

## Always

- TDD: tests exist and fail before the migration/service code exists — never written after as an
  afterthought.
- Cite the DD section in the migration's header comment.
- Attach the audit trigger — a business table with no audit trigger is a bug per
  `history-audit-architect`.
- Add at least one constraint-rejection test, not just the happy path.
- Never invent a field not in the DD section — if you need a field the DD doesn't list, ask instead of
  guessing.
