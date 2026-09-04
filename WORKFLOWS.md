# Spellzee ERP — Workflows

> How the sub-agents (`.claude/agents/`) and skills (`.claude/skills/`) in this repo chain together for
> recurring high-level tasks. Backend/data-layer only for now (Phase 1 has no API/frontend layer yet) —
> see CLAUDE.md and the agent/skill descriptions for individual responsibilities.

## 1. New module workflow

Use for: adding a new entity or small group of related entities.

1. **`phase-gatekeeper`** — is this in scope for the current phase per `PHASE_STATUS.md`? Stop and ask
   if not; do not proceed even partially.
2. **`schema-guardian`** — does the proposed table/field set match the Data Dictionary? Resolve any
   unresolved fields before writing SQL.
3. **`new-entity` skill** — scaffold the migration, Drizzle schema, service layer (if there's a
   workflow, not just CRUD), and tests, per table.
4. **`history-audit-architect`** — confirm the correct history layer(s) are attached and a
   constraint-rejection test exists for every new CHECK/EXCLUDE/trigger.
5. **`business-rules-auditor`** — final pass over the whole diff against CLAUDE.md §4's 31 rules.
6. Update CLAUDE.md's build-status section and `PHASE_STATUS.md`'s "what's built" checklist.

## 2. Policy / business-rule change workflow

Use for: changing a value like the cancellation cutoff, ticket SLA hours, max reschedules, attendance
thresholds — anything in CLAUDE.md §4's "Open policy parameters" / "Accepted working defaults" lists.

1. Identify the affected `policy_parameter` row(s).
2. **`policy-parameter-change` skill** — insert the new effective-dated row, stamp `source` correctly
   (engineering_default vs business_ratified), never edit the old row in place.
3. **`business-rules-auditor`** — confirm every service reading this parameter reads it live from
   `policy_parameter`, not a hard-coded fallback or cached copy that would silently diverge.
4. Update `docs/policies/` with the decision record, and CLAUDE.md §4's defaults table if the value
   itself changed.

## 3. Phase-boundary workflow

Use for: any prompt that implies scope beyond what's explicitly already approved — a new entity, a new
column that belongs to a later phase's concept (e.g. a training/incentive field on `teacher`), a new
module.

1. **`phase-gatekeeper`** checks `PHASE_STATUS.md`'s approved and deferred lists first, before any other
   agent or skill runs.
2. If out of scope: stop, state which deferred-list entry applies, and ask the user directly for an
   explicit exception. Do not scaffold "just a draft" or "just the schema" in the meantime.
3. If the user grants an exception: log it in `PHASE_STATUS.md`'s exception table (date, item, approver,
   reason) BEFORE any code is written — the log entry is not a formality done afterward.
4. Only then does workflow 1 (new module) or the relevant skill proceed.

## 4. State-transition / lifecycle change workflow

Use for: adding or changing a status field's legal transitions (session, class_schedule, ticket, etc.).

1. **`add-state-transition` skill** — enumerate the full transition graph, decide CHECK+trigger vs.
   service-layer enforcement, decide if any transition needs maker-checker.
2. If maker-checker applies to a transition: **`add-maker-checker-flow` skill** for that transition
   specifically.
3. **`business-rules-auditor`** — check the change doesn't violate rule 17 (a purchased session is never
   silently lost / a missed one never silently forgiven) or rule 19 (teacher-side failure protects
   entitlement) if this is a session/attendance-adjacent status.
4. **`history-audit-architect`** — rejection test for at least one illegal transition exists.

## 5. External integration workflow

Use for: Merithub, TeliCRM, Delicio, FreeJump, WhatsApp touchpoints.

1. **`integration-mapper`** — confirm the entity mapping and that no external ID column is being added
   to a core table.
2. **`add-external-integration` skill** — implement via `external_id_map` + `outbox_event`.
3. **`integration-mapper`** (second pass) — confirm failure visibility/retry exists, and flag anything
   relying on an unconfirmed API contract (Merithub docs/WhatsApp BSP are open deliverables per
   CLAUDE.md §4).

---

All workflows assume `CLAUDE.md` has already been read this session — it is the baseline every
agent/skill above is instructed to consult before opening a source PDF.
