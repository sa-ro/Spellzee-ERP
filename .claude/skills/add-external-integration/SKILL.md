---
name: add-external-integration
description: Add a new external-system touchpoint (Merithub, TeliCRM, Delicio, FreeJump, WhatsApp) following Spellzee's external_id_map + outbox_event pattern, so identifiers never leak onto core tables and failures stay visible. Use when wiring up or extending an integration with an external system.
---

# Add an external integration

Rule 26/27 (CLAUDE.md §4): Spellzee owns its core identifiers; external API failures must never
silently create incomplete or misleading records.

## Steps

1. Confirm the external system and the specific Spellzee entity it maps to (e.g. Merithub class ↔
   `class_schedule`, Merithub session ↔ `session`). Check `external_id_map`'s existing entity-type list
   (`packages/db/migrations/0007_external_id_map.sql`) — add the new type there if it's missing, never
   as a new column on the core table.
2. **Outbound direction** (Spellzee → external system): the triggering business change writes an
   `outbox_event` row in the SAME transaction. A BullMQ worker drains the outbox and makes the actual
   API call, writing the resulting external ID into `external_id_map` on success.
3. **Inbound direction** (external system → Spellzee, e.g. a webhook): the inbound handler resolves the
   external ID to a Spellzee entity via `external_id_map`, then applies the change through the SAME
   service-layer path an internal change would use (e.g. a Merithub-triggered reschedule still goes
   through the allocation/schedule service, not a direct UPDATE) — so audit trail and business-rule
   checks apply uniformly regardless of origin.
4. **Failure handling**: a failed outbound call must retry (BullMQ backoff) and surface as visibly
   failed — never leave Spellzee's own row half-updated or silently drop the external side. Log enough
   to reconcile later per rule 27.
5. Do not assume undocumented API behavior. If the actual Merithub API contract (or WhatsApp BSP
   template approval mechanics) isn't confirmed yet, say so and stub the integration point rather than
   guessing at request/response shapes — see CLAUDE.md §4's "Still outstanding" list, items 1-2.
6. Write a test proving a failed external call does not leave a misleading Spellzee record (e.g. the
   `class_schedule` stays in a state that reflects "pending Merithub sync," not silently "active" as if
   sync succeeded).

## Always

- TDD: write the failure-visibility test first (a failed external call must not leave a misleading
  Spellzee record) before the integration code that's supposed to satisfy it.
- Route identifiers through `external_id_map`, never a new column on a core table.
- Write outbound side effects to `outbox_event` in the same transaction as the business change.
- Make failure states visible and retryable, never silent.
- Flag any assumed API contract that isn't actually confirmed yet.
