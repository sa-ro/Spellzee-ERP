/**
 * ticket, sla_policy, sla_instance. Mirrors migrations/0029_support.sql +
 * 0030_support_audit_guards.sql.
 */

import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userAccount } from './reference.js';
import { employee } from './workforce.js';
import { role } from './governance.js';

export const TICKET_PRIORITY = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITY)[number];

export const TICKET_STATUS = ['open', 'in_progress', 'resolved', 'closed', 'reopened'] as const;
export type TicketStatus = (typeof TICKET_STATUS)[number];

export const SLA_INSTANCE_STATUS = ['active', 'warned', 'breached', 'resolved', 'cancelled'] as const;
export type SlaInstanceStatus = (typeof SLA_INSTANCE_STATUS)[number];

export const slaPolicy = pgTable('sla_policy', {
  id: uuid('id').primaryKey().defaultRandom(),

  entityType: text('entity_type').notNull(),
  policyCode: text('policy_code').notNull().unique(),
  warnHours: integer('warn_hours').notNull(),
  breachHours: integer('breach_hours').notNull(),
  escalateToRoleId: uuid('escalate_to_role_id').references(() => role.id),
  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull().references(() => userAccount.id),
  updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
});

export const ticket = pgTable(
  'ticket',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id').notNull().unique().default(sql`next_public_id('TKT')`),

    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),

    category: text('category').notNull(),
    subject: text('subject').notNull(),
    description: text('description').notNull(),
    priority: text('priority').$type<TicketPriority>().notNull().default('normal'),
    status: text('status').$type<TicketStatus>().notNull().default('open'),

    raisedBy: uuid('raised_by').notNull().references(() => userAccount.id),
    assignedTo: uuid('assigned_to').references(() => employee.id),

    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNotes: text('resolution_notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
    source: text('source').notNull().default('ui'),
  },
  (t) => ({
    byEntity: index('ticket_entity_idx').on(t.entityType, t.entityId),
    open: index('ticket_open_idx')
      .on(t.status)
      .where(sql`status IN ('open','in_progress','reopened')`),
    byAssignee: index('ticket_assignee_idx').on(t.assignedTo),
  }),
);

export const slaInstance = pgTable(
  'sla_instance',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    slaPolicyId: uuid('sla_policy_id').notNull().references(() => slaPolicy.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    warnAt: timestamp('warn_at', { withTimezone: true }).notNull(),
    breachAt: timestamp('breach_at', { withTimezone: true }).notNull(),

    status: text('status').$type<SlaInstanceStatus>().notNull().default('active'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
  },
  (t) => ({
    activeUq: uniqueIndex('sla_instance_active_uq')
      .on(t.entityType, t.entityId)
      .where(sql`status IN ('active','warned')`),
    byEntity: index('sla_instance_entity_idx').on(t.entityType, t.entityId),
    breachCheck: index('sla_instance_breach_check_idx')
      .on(t.breachAt)
      .where(sql`status IN ('active','warned')`),
    warnCheck: index('sla_instance_warn_check_idx').on(t.warnAt).where(sql`status = 'active'`),
  }),
);

export type SlaPolicy = typeof slaPolicy.$inferSelect;
export type Ticket = typeof ticket.$inferSelect;
export type SlaInstance = typeof slaInstance.$inferSelect;
