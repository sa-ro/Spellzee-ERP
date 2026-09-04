/**
 * Integration & audit schema — External ID Mapping (DD §42), Audit Event (DD §41).
 *
 * Mirrors migrations/0007_external_id_map.sql and 0002_audit_event.sql.
 *
 * `auditEvent` is declared read-only by convention: the application role holds
 * SELECT only, and all writes arrive via the SECURITY DEFINER trigger. Any insert
 * attempted through Drizzle will be refused by the database (rule 23).
 */

import { pgSchema, pgTable, uuid, text, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { userAccount } from './reference.js';

export const auditSchema = pgSchema('audit');

export const EXTERNAL_SYSTEM = [
  'merithub',
  'telicrm',
  'delicio',
  'freejump',
  'whatsapp',
  'payment_gateway',
] as const;
export type ExternalSystem = (typeof EXTERNAL_SYSTEM)[number];

export const MAPPABLE_ENTITY = [
  'student',
  'parent_guardian',
  'enrollment',
  'subscription',
  'payment',
  'teacher',
  'class_schedule',
  'session',
  'employee',
] as const;
export type MappableEntity = (typeof MAPPABLE_ENTITY)[number];

/* -------------------------------------------------------------------------- */
/* external_id_map — DD §42                                                   */
/* -------------------------------------------------------------------------- */

export const externalIdMap = pgTable(
  'external_id_map',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** No FK: generic across entity types, and must outlive the subject's archival. */
    spellzeeEntityType: text('spellzee_entity_type').$type<MappableEntity>().notNull(),
    spellzeeId: uuid('spellzee_id').notNull(),
    spellzeePublicId: text('spellzee_public_id'),

    externalSystem: text('external_system').$type<ExternalSystem>().notNull(),
    externalEntityType: text('external_entity_type'),
    externalId: text('external_id').notNull(),

    status: text('status').$type<'active' | 'revoked' | 'superseded'>().notNull().default('active'),

    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    syncStatus: text('sync_status')
      .$type<'pending' | 'synced' | 'error' | 'stale'>()
      .notNull()
      .default('pending'),
    syncError: text('sync_error'),
    syncAttempts: integer('sync_attempts').notNull().default(0),

    externalPayload: jsonb('external_payload'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => userAccount.id),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => userAccount.id),
    source: text('source').notNull().default('api'),
  },
  (t) => ({
    lookup: index('external_id_map_lookup_idx').on(t.externalSystem, t.externalId),
    bySpellzee: index('external_id_map_spellzee_idx').on(t.spellzeeEntityType, t.spellzeeId),
    failing: index('external_id_map_failing_idx').on(t.syncStatus, t.lastSyncAt),
  }),
);

/* -------------------------------------------------------------------------- */
/* audit.audit_event — DD §41 (READ ONLY from the application)                */
/* -------------------------------------------------------------------------- */

export const AUDIT_ACTION = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'APPROVE',
  'REJECT',
  'OVERRIDE',
  'EXPORT',
  'LOGIN',
  'MERGE',
  'ARCHIVE',
] as const;
export type AuditAction = (typeof AUDIT_ACTION)[number];

export const auditEvent = auditSchema.table(
  'audit_event',
  {
    id: uuid('id').notNull().defaultRandom(),
    publicId: text('public_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    actorUserId: uuid('actor_user_id').notNull(),
    actorSessionId: uuid('actor_session_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),

    action: text('action').$type<AuditAction>().notNull(),
    entityType: text('entity_type').notNull(),
    /** Deliberately not a foreign key — the audit row outlives its subject. */
    recordId: uuid('record_id').notNull(),
    recordPublicId: text('record_public_id'),

    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    changedFields: text('changed_fields').array().notNull(),

    reason: text('reason'),
    approvalId: uuid('approval_id'),
    correlationId: text('correlation_id'),
    source: text('source').notNull(),
    outcome: text('outcome').$type<'success' | 'blocked' | 'failed'>().notNull(),
  },
  (t) => ({
    byEntity: index('audit_event_entity_idx').on(t.entityType, t.recordId, t.occurredAt),
    byActor: index('audit_event_actor_idx').on(t.actorUserId, t.occurredAt),
    byCorrelation: index('audit_event_correlation_idx').on(t.correlationId),
  }),
);

export type ExternalIdMap = typeof externalIdMap.$inferSelect;
export type NewExternalIdMap = typeof externalIdMap.$inferInsert;
export type AuditEvent = typeof auditEvent.$inferSelect;
