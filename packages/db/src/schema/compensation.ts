/**
 * compensation — rule 18, rule 19. Mirrors migrations/0021_compensation.sql +
 * 0022_compensation_audit_guards.sql.
 *
 * "A compensation session is a separate, additional session linked to the
 * original affected session. It MUST NOT modify or reschedule the original
 * recurring schedule." (rule 18)
 */

import { pgTable, uuid, text, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { userAccount } from './reference.js';
import { session } from './operations.js';
import { subscription } from './commercial.js';
import { sessionCreditLedger } from './entitlement.js';

export const COMPENSATION_STATUS = ['scheduled', 'completed', 'cancelled', 'expired'] as const;
export type CompensationStatus = (typeof COMPENSATION_STATUS)[number];

export const compensation = pgTable(
  'compensation',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    originalSessionId: uuid('original_session_id').notNull().references(() => session.id),
    compensationSessionId: uuid('compensation_session_id').notNull().references(() => session.id),
    subscriptionId: uuid('subscription_id').notNull().references(() => subscription.id),

    reasonCode: text('reason_code').notNull(),
    status: text('status').$type<CompensationStatus>().notNull().default('scheduled'),
    validityDeadline: date('validity_deadline').notNull(),

    protectedLedgerEntryId: uuid('protected_ledger_entry_id').references(() => sessionCreditLedger.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
    source: text('source').notNull().default('ui'),
  },
  (t) => ({
    originalSessionUq: uniqueIndex('compensation_original_session_uq').on(t.originalSessionId),
    bySubscription: index('compensation_subscription_idx').on(t.subscriptionId),
  }),
);

export type Compensation = typeof compensation.$inferSelect;
