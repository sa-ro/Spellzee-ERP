# Spellzee ERP — Phase 1 Logical Data Model

**Status:** Draft 1 for validation · **Date:** 2026-09-04 · **Scope:** Phase 1 Operations MVP only

This directory is the deliverable DD §50 asks for before any table is created:

> *"Do not start by creating hundreds of tables from this document. First validate the business
> entities and relationships."*

It converts the business entities in the Data Architecture & Data Dictionary into a **logical**
model — entities, cardinality, mandatory/optional fields, lifecycle transitions and integrity
rules — without yet committing to physical DDL, indexes or storage layout.

## Contents

| Document | Covers | DD sequence step |
|---|---|---|
| [01 — Entity Relationship Model](01-entity-relationship-model.md) | ERDs per domain, every relationship with explicit cardinality and optionality | "Convert entities into a formal logical data model" / "Define cardinality" |
| [02 — Entity Specifications](02-entity-specifications.md) | Field-level spec per entity: mandatory vs optional, type concept, source rule | "Define mandatory/optional fields" |
| [03 — Lifecycle State Machines](03-lifecycle-state-machines.md) | Legal states and transitions for the 12 stateful entities, incl. the session-outcome → credit-impact matrix | "Define lifecycle/status transitions" |
| [04 — History, Audit & Integrity](04-history-audit-and-integrity.md) | The four history layers applied concretely; every DB-enforced business rule | "Define permission and audit requirements" |
| [05 — Open Modelling Questions](05-open-modelling-questions.md) | What this model could not settle and who must decide | Feeds `docs/policies/` |

## How to read this

- **Cardinality notation:** `1` exactly one · `0..1` at most one · `1..n` one or more ·
  `0..n` any number. Optionality of the *foreign key* is stated separately from cardinality.
- Every entity and rule cites its source as **DD §n** (Data Dictionary) or **Master §n**
  (Master Product & Business Requirements Draft 3).
- Anything not traceable to a source document is marked **[ENGINEERING]** and is a proposal
  requiring business validation.

## Validation checklist for the business

Before physical schema design begins, please confirm:

1. The relationship cardinalities in [01](01-entity-relationship-model.md) match how Spellzee
   actually operates — especially the group-class and multi-guardian cases.
2. The mandatory fields in [02](02-entity-specifications.md) are genuinely mandatory. A field
   marked mandatory that Operations cannot always supply at creation time will block real work.
3. The state transitions in [03](03-lifecycle-state-machines.md) contain no missing state you
   use in practice, and no transition you would consider illegal.
4. The **session outcome → credit impact matrix** in
   [03](03-lifecycle-state-machines.md#session-outcome--credit-impact) is correct. This is the
   single highest-risk table in the model: it decides whether a parent's purchased session is
   consumed or protected, and it is currently populated with engineering defaults.
5. The open questions in [05](05-open-modelling-questions.md) are routed to named owners.

## What this model deliberately excludes

Phase 2–5 entities. No lesson, assessment, progress, material, recording, training,
observation, incentive, leave, payment, refund, communication, call, retention interaction,
student health, demand forecast or AI output. See `CLAUDE.md` §5 and §7.
