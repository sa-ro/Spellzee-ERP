# Spellzee ERP

A system of record and control for Spellzee, an online tutoring company — currently **Phase 1
(Operations MVP)**. See [`CLAUDE.md`](./CLAUDE.md) for full project context (product summary,
tech stack, identifier standard, non-negotiable business rules); this file is just how to get the
code running.

## Stack

TypeScript + NestJS (backend, not yet built) · PostgreSQL 16 + Drizzle ORM · React + Vite
(frontend, not yet built) · pnpm workspace + Turborepo-style monorepo. Full rationale in
`CLAUDE.md` §2.

## Repository layout

```
packages/
  db/       Drizzle schema, hand-authored SQL migrations, services, Testcontainers tests
  domain/   Pure business-rule/policy logic — zero I/O, unit-tested with Vitest
apps/       NestJS API + React SPA — not built yet (Phase 1 is data-layer-and-service-layer only)
docs/
  source/       the 4 discovery PDFs (Master BRD, Data Dictionary, etc.)
  data-model/   logical data model, ERD, lifecycle diagrams
  decisions/    ADRs
  policies/     open Master §30 policy decisions, tracked to closure
.claude/
  agents/   project-specific sub-agents (schema-guardian, business-rules-auditor, etc.)
  skills/   repeatable procedures (new-entity, add-state-transition, etc.)
```

## Prerequisites

- Node.js ≥ 22
- pnpm 9
- Docker (the test suite spins up real, ephemeral PostgreSQL 16 containers via Testcontainers —
  no mocked database anywhere in this repo)

## Setup

```bash
pnpm install
```

## Running tests

```bash
pnpm test          # every package: domain (pure Vitest) + db (Testcontainers against real Postgres)
pnpm typecheck      # tsc --noEmit across the workspace
```

Or scoped to one package:

```bash
pnpm --filter @spellzee/domain test
pnpm --filter @spellzee/db test
```

Every migration that adds a constraint or trigger ships with a Testcontainers test proving the
constraint *rejects* the bad case — see `CLAUDE.md` §6 for why, and `PHASE_STATUS.md` for which
batch added which test file.

## Database

```bash
pnpm db:migrate     # applies packages/db/migrations/*.sql in order, against DATABASE_URL
pnpm db:seed        # seed data
```

Migrations are forward-only, hand-authored SQL — never edited after merge; see `CLAUDE.md` §6
("Migrations") for the conventions (audit trigger on every business table, exclusion constraints
for double-booking, etc.).

## Where things stand

- **`PHASE_STATUS.md`** — the current phase, the full Phase 1 entity list, what's built vs. not,
  and the exception log for any approved out-of-phase work.
- **`WORKFLOWS.md`** — how the project's Claude Code sub-agents and skills chain together for
  recurring tasks (new entity, policy change, phase-boundary check, etc.).
- **`CLAUDE.md`** — everything else: product context, business rules, coding conventions. Read it
  before making any change in this repo.
