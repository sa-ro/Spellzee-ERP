/**
 * admission_handover. Mirrors migrations/0027_admission_handover.sql +
 * 0028_admission_handover_audit_guards.sql.
 */

import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userAccount } from './reference.js';
import { student } from './identity.js';
import { enrollment } from './commercial.js';
import { employee } from './workforce.js';

export const ADMISSION_HANDOVER_STATUS = [
  'pending',
  'acknowledged',
  'allocated',
  'breached',
  'cancelled',
] as const;
export type AdmissionHandoverStatus = (typeof ADMISSION_HANDOVER_STATUS)[number];

export const admissionHandover = pgTable(
  'admission_handover',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    studentId: uuid('student_id').notNull().references(() => student.id),
    enrollmentId: uuid('enrollment_id').notNull().references(() => enrollment.id),

    handedOverBy: uuid('handed_over_by').notNull().references(() => employee.id),
    receivedBy: uuid('received_by').references(() => employee.id),

    status: text('status').$type<AdmissionHandoverStatus>().notNull().default('pending'),
    handoverNotes: text('handover_notes'),

    slaDeadlineAt: timestamp('sla_deadline_at', { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    allocatedAt: timestamp('allocated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
    source: text('source').notNull().default('ui'),
  },
  (t) => ({
    enrollmentUq: uniqueIndex('admission_handover_enrollment_uq').on(t.enrollmentId),
    pending: index('admission_handover_pending_idx').on(t.status).where(sql`status = 'pending'`),
    byStudent: index('admission_handover_student_idx').on(t.studentId),
  }),
);

export type AdmissionHandover = typeof admissionHandover.$inferSelect;
