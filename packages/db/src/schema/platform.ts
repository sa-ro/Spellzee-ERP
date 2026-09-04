/**
 * Policy parameters, transactional outbox, notifications — the remaining
 * Governance & Platform tables (CLAUDE.md §5). Mirrors
 * migrations/0017_policy_outbox_notification.sql +
 * 0018_policy_outbox_notification_audit_guards.sql.
 *
 * Rule 28 (policy_parameter), CLAUDE.md §5 layer 4 (outbox_event), rule 27.
 */

import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userAccount } from './reference.js';

export const POLICY_SOURCE = ['engineering_default', 'business_ratified'] as const;
export type PolicySource = (typeof POLICY_SOURCE)[number];

export const OUTBOX_STATUS = ['pending', 'processing', 'sent', 'failed', 'dead_letter'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUS)[number];

export const NOTIFICATION_CHANNEL = ['email', 'sms', 'whatsapp', 'in_app', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNEL)[number];

export const NOTIFICATION_STATUS = ['pending', 'sent', 'delivered', 'failed', 'cancelled'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUS)[number];

/* -------------------------------------------------------------------------- */
/* policy_parameter — rule 28, effective-dated                               */
/* -------------------------------------------------------------------------- */

export const policyParameter = pgTable(
  'policy_parameter',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    description: text('description'),

    source: text('source').$type<PolicySource>().notNull().default('engineering_default'),
    ratifiedAt: timestamp('ratified_at', { withTimezone: true }),
    ratifiedBy: uuid('ratified_by').references(() => userAccount.id),

    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    isCurrent: boolean('is_current').notNull().default(true),
    supersededById: uuid('superseded_by_id'),
    changeReason: text('change_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
  },
  (t) => ({
    currentUq: uniqueIndex('policy_parameter_current_uq').on(t.key).where(sql`is_current`),
    history: index('policy_parameter_history_idx').on(t.key, t.validFrom),
  }),
);

/* -------------------------------------------------------------------------- */
/* outbox_event — CLAUDE.md §5 layer 4                                       */
/* -------------------------------------------------------------------------- */

export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    correlationId: uuid('correlation_id'),

    status: text('status').$type<OutboxStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
  },
  (t) => ({
    dispatch: index('outbox_event_dispatch_idx')
      .on(t.nextAttemptAt)
      .where(sql`status IN ('pending','failed')`),
    aggregate: index('outbox_event_aggregate_idx').on(t.aggregateType, t.aggregateId),
  }),
);

/* -------------------------------------------------------------------------- */
/* notification                                                              */
/* -------------------------------------------------------------------------- */

export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    recipientType: text('recipient_type').notNull(),
    recipientId: uuid('recipient_id').notNull(),

    channel: text('channel').$type<NotificationChannel>().notNull(),
    templateCode: text('template_code').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),

    status: text('status').$type<NotificationStatus>().notNull().default('pending'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    failureReason: text('failure_reason'),

    outboxEventId: uuid('outbox_event_id').references(() => outboxEvent.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
  },
  (t) => ({
    recipient: index('notification_recipient_idx').on(t.recipientType, t.recipientId),
    pending: index('notification_pending_idx').on(t.scheduledFor).where(sql`status = 'pending'`),
  }),
);

export type PolicyParameter = typeof policyParameter.$inferSelect;
export type OutboxEvent = typeof outboxEvent.$inferSelect;
export type Notification = typeof notification.$inferSelect;
