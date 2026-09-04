/**
 * reschedule_request. Mirrors migrations/0023_reschedule_request.sql +
 * 0024_reschedule_request_audit_guards.sql.
 */

import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userAccount } from './reference.js';
import { session } from './operations.js';
import { subscription } from './commercial.js';

export const CUTOFF_STATUS = ['outside_cutoff', 'inside_cutoff'] as const;
export type CutoffStatus = (typeof CUTOFF_STATUS)[number];

export const RESCHEDULE_STATUS = ['pending', 'approved', 'fulfilled', 'rejected', 'cancelled'] as const;
export type RescheduleStatus = (typeof RESCHEDULE_STATUS)[number];

export const rescheduleRequest = pgTable(
  'reschedule_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    sessionId: uuid('session_id').notNull().references(() => session.id),
    newSessionId: uuid('new_session_id').references(() => session.id),
    subscriptionId: uuid('subscription_id').notNull().references(() => subscription.id),

    requestedNewStartAt: timestamp('requested_new_start_at', { withTimezone: true }).notNull(),
    requestedNewEndAt: timestamp('requested_new_end_at', { withTimezone: true }).notNull(),

    cutoffStatus: text('cutoff_status').$type<CutoffStatus>().notNull(),
    status: text('status').$type<RescheduleStatus>().notNull().default('pending'),
    reason: text('reason').notNull(),

    requestedBy: uuid('requested_by').notNull().references(() => userAccount.id),
    approvedBy: uuid('approved_by').references(() => userAccount.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
    source: text('source').notNull().default('ui'),
  },
  (t) => ({
    bySession: index('reschedule_request_session_idx').on(t.sessionId),
    bySubscription: index('reschedule_request_subscription_idx').on(t.subscriptionId),
    pending: index('reschedule_request_pending_idx').on(t.status).where(sql`status = 'pending'`),
  }),
);

export type RescheduleRequest = typeof rescheduleRequest.$inferSelect;
