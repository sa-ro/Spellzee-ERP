/**
 * session_credit_ledger — CLAUDE.md §5 layer 3 (append-only ledger).
 * Mirrors migrations/0019_session_credit_ledger.sql.
 *
 * Rule 16 (defined entitlement), rule 17 (never silently lost/forgiven), rule
 * 18 (compensation is separate/additional, not a reschedule), DD §10/§41.
 */

import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userAccount } from './reference.js';
import { subscription } from './commercial.js';
import { session } from './operations.js';
import { policyParameter } from './platform.js';
import { approvalRequest } from './governance.js';

export const LEDGER_ENTRY_TYPE = ['purchased', 'consumed', 'protected', 'compensated', 'adjusted'] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPE)[number];

export const sessionCreditLedger = pgTable(
  'session_credit_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    subscriptionId: uuid('subscription_id').notNull().references(() => subscription.id),

    entryType: text('entry_type').$type<LedgerEntryType>().notNull(),
    amount: integer('amount').notNull(),
    reasonCode: text('reason_code').notNull(),

    sessionId: uuid('session_id').references(() => session.id),
    policyVersionId: uuid('policy_version_id').references(() => policyParameter.id),
    approvalId: uuid('approval_id').references(() => approvalRequest.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    source: text('source').notNull().default('ui'),
  },
  (t) => ({
    bySubscription: index('session_credit_ledger_subscription_idx').on(t.subscriptionId, t.createdAt),
    bySession: index('session_credit_ledger_session_idx')
      .on(t.sessionId)
      .where(sql`session_id IS NOT NULL`),
  }),
);

export type SessionCreditLedgerEntry = typeof sessionCreditLedger.$inferSelect;
