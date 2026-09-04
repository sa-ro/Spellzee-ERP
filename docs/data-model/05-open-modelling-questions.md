# 05 — Open Modelling Questions

Questions this model could **not** settle from the source documents. Each has a working
assumption so development proceeds, and a note on what changes if the answer differs.

Routed to `docs/policies/` for ratification.

---

## A. Structural — answer changes the schema

| # | Question | Working assumption | Cost if wrong |
|---|---|---|---|
| A1 | **Do group classes exist today, or is 1-to-1 the only real mode?** | Schema supports group (`session_participant`, per-participant attendance and credit); Phase 1 UI is 1-to-1 only. | **Low if group is later, high if group exists now and we ship 1-to-1 UI.** This is the question I most want answered — it was raised earlier and waved through, but it changes what Operations can actually do on day one. |
| A2 | Do the 5 extra tables (`course`, `subject`, `level`, `language`, `session_participant`) plus 3 teacher-capability tables count as Phase 1? | Yes — Master §5 Domain 1 scopes "course, subject, master records" to Phase 1, and Master §8 matching cannot work without them. | Low. Flagged rather than added silently, per the `CLAUDE.md` scope guard. |
| A3 | Can a student have **concurrent** enrollments (two subjects at once), or only sequential? | Concurrent permitted. | Medium — a unique constraint would need adding, and Student 360 changes shape. |
| A4 | Can one subscription fund **multiple** enrollments? | No — `subscription.enrollment_id` is `0..1`. | Medium — would need a join table and the credit ledger would need per-enrollment attribution. |
| A5 | Does parent **address history** need preserving, like contact history? | No — current address only on `parent_guardian`. DD §5 says "address history may be needed" without deciding. | Low — address moves into `contact_history` as another `contact_type`. |
| A6 | Is a teacher ever also a parent or student at Spellzee? | No. `student` and `employee` are separate with no shared person master (accepted default). | High if wrong — but genuinely unlikely. |
| A7 | Should `ticket` link to **many** related entities, or is one of each enough? | One nullable FK per related type (session, teacher, subscription, enrollment). | Low — becomes a `ticket_related_entity` join table. |

## B. Policy — answer seeds `policy_parameter`, no schema change

All of these are already seeded with engineering defaults (`CLAUDE.md` §4) and marked
`ratified_at = NULL`.

| # | Question | Why it matters |
|---|---|---|
| B1 | **What happens to a protected credit when compensation expires?** Stay protected, convert to consumed, or extend? | Real money. Currently *stays protected*, which is generous to the parent and grows the compensation backlog indefinitely. Master §30 leaves it open. |
| B2 | Attendance thresholds — exact minutes/percentage for Present, Late, Partial, Absent. | Drives the credit-impact matrix row "partial attendance". Currently 90/50/10-min. |
| B3 | Is `Unreachable` an SLA **pause** condition for admission handover? | Determines whether the 24h clock keeps running when a parent will not answer. Currently it keeps running — arguably unfair to coordinators. |
| B4 | Does a *group* session consume one credit per participant? | Assumed yes. Affects revenue recognition if wrong. |
| B5 | Student-side technical failure — consumed, protected, or goodwill-limited? | Currently consumed with one goodwill exception per subscription. Master §30 explicitly open. |
| B6 | Which Phase 1 actions require maker-checker? | Currently: merge duplicates, historical corrections, attendance corrections, manual ledger adjustments, teacher change. Student creation and contact edits do not. |
| B7 | Cancellation cutoff — 24h? Different by course or plan? | Currently a single global 24h value. The `scope` column on `policy_parameter` allows per-course later. |

## C. Deferred by phase — confirm the deferral is acceptable

| # | Item | Deferred to | Risk of deferring |
|---|---|---|---|
| C1 | `payment` entity | Phase 4 | Student 360 shows entitlement but not payment history in Phase 1. Renewal forecasting (Master §16) works off subscription dates, not payments — so this holds. |
| C2 | Forecast capacity (expected releases from breaks/completions) | Phase 5 | Management sees current capacity vs demand but not projected gaps. Master §13.3's headline example is a *forecast*, so this is a visible reduction — confirm it is acceptable. |
| C3 | `communication` / `call` entities | Phase 2 | Tickets exist in Phase 1 but conversation history does not. Coordinators keep using WhatsApp directly during Phase 1. |
| C4 | `retention_interaction`, `student_health` | Phase 2 | The every-3-sessions retention trigger (Master §20.4) cannot fire in Phase 1. |
| C5 | Teacher certification driving `is_allocation_eligible` | Phase 3 | Phase 1 sets the flag manually with a reason. Rule 25 is enforced; only its *input* is manual. |
| C6 | Demo assessment as a first-class entity | Phase 2 | Carried as JSONB on `admission_handover`, which satisfies Master §17.3 without opening Phase 2. |

## D. Non-modelling blockers (repeated from `CLAUDE.md` §4)

Still outstanding and now on the critical path:

1. **Merithub API documentation + sandbox credentials.** The `class_schedule` `Draft → Active`
   transition and `external_id_map` sync semantics cannot be finalised without knowing what the
   API actually supports. If it lacks attendance webhooks, the `attendance` source strategy
   changes materially.
2. **WhatsApp BSP selection.** Template approval is calendar time, not engineering time.
3. Anonymised sample data — needed to tune `identity_match` signals and confidence against real
   name/phone patterns rather than invented ones.
4. Volume figures — validate the partitioning and indexing assumptions.
5. Named owners for section B above.

---

## Recommended next step

Sections **A1–A7** should be answered before physical schema work begins; they are the only
ones that cost a migration. Section B can be answered any time before go-live, and section C
just needs a nod.
