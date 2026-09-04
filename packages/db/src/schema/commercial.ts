/**
 * Commercial domain — Enrollment (DD §8), Subscription (DD §9), Payment (DD §10).
 *
 * Mirrors migrations/0006_commercial.sql.
 *
 * Note the deliberate absence of session-count columns on `subscription`.
 * DD §9 lists scheduled/completed/consumed/protected/remaining as concepts; they
 * are derived from session_credit_ledger (delivery module) so that rule 16 and
 * rule 17 remain enforceable. A writable balance column would break both.
 */

import {
  pgTable,
  uuid,
  text,
  date,
  char,
  bigint,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { userAccount, course, subject, level } from './reference.js';
import { student, parentGuardian } from './identity.js';

export const ENROLLMENT_STATUS = [
  'pending',
  'active',
  'paused',
  'completed',
  'cancelled',
  'archived',
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUS)[number];

export const SUBSCRIPTION_STATUS = [
  'active',
  'exhausted',
  'expired',
  'cancelled',
  'renewed',
  'archived',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[number];

export const PAYMENT_STATUS = [
  'pending',
  'settled',
  'failed',
  'refunded',
  'partially_refunded',
  'cancelled',
  'archived',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const PAYMENT_METHOD = [
  'upi',
  'card',
  'netbanking',
  'bank_transfer',
  'cash',
  'wallet',
  'gateway',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

export const ADJUSTMENT_TYPE = [
  'refund',
  'partial_refund',
  'correction',
  'chargeback',
  'credit_note',
] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPE)[number];

/* -------------------------------------------------------------------------- */
/* enrollment — DD §8                                                         */
/* -------------------------------------------------------------------------- */

export const enrollment = pgTable(
  'enrollment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id')
      .notNull()
      .unique()
      .default(sql`next_public_id('ENR')`),

    studentId: uuid('student_id')
      .notNull()
      .references(() => student.id),

    courseId: uuid('course_id')
      .notNull()
      .references(() => course.id),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subject.id),
    levelId: uuid('level_id')
      .notNull()
      .references(() => level.id),
    sessionType: text('session_type').$type<'one_to_one' | 'group'>().notNull().default('one_to_one'),

    startDate: date('start_date').notNull(),
    expectedEndDate: date('expected_end_date'),
    actualEndDate: date('actual_end_date'),

    status: text('status').$type<EnrollmentStatus>().notNull().default('pending'),
    /** Mandatory when completing, cancelling or pausing — DD §8. */
    endReason: text('end_reason'),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: uuid('archived_by').references(() => userAccount.id),
    archiveReason: text('archive_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => userAccount.id),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => userAccount.id),
    source: text('source').notNull().default('ui'),
  },
  (t) => ({
    byStudent: index('enrollment_student_idx').on(t.studentId),
    byStatus: index('enrollment_status_idx').on(t.status),
    byCourse: index('enrollment_course_idx').on(t.courseId),
  }),
);

/* -------------------------------------------------------------------------- */
/* subscription — DD §9                                                       */
/* -------------------------------------------------------------------------- */

export const subscription = pgTable(
  'subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id')
      .notNull()
      .unique()
      .default(sql`next_public_id('SUB')`),

    studentId: uuid('student_id')
      .notNull()
      .references(() => student.id),
    /** Nullable per DD §9 "where applicable". */
    enrollmentId: uuid('enrollment_id').references(() => enrollment.id),

    planName: text('plan_name').notNull(),
    purchasedSessionCount: integer('purchased_session_count').notNull(),

    /** Integer minor units. Never a float (CLAUDE.md §6). */
    priceMinorUnits: bigint('price_minor_units', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),

    purchaseDate: date('purchase_date').notNull(),
    startDate: date('start_date').notNull(),
    validUntil: date('valid_until').notNull(),

    status: text('status').$type<SubscriptionStatus>().notNull().default('active'),

    renewedFromSubscriptionId: uuid('renewed_from_subscription_id'),
    renewedToSubscriptionId: uuid('renewed_to_subscription_id'),

    /** For imported records and gateway-mapped transactions (DD §42). */
    externalPaymentRef: text('external_payment_ref'),
    cancellationReason: text('cancellation_reason'),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: uuid('archived_by').references(() => userAccount.id),
    archiveReason: text('archive_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => userAccount.id),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => userAccount.id),
    source: text('source').notNull().default('ui'),
  },
  (t) => ({
    byStudent: index('subscription_student_idx').on(t.studentId),
    byEnrollment: index('subscription_enrollment_idx').on(t.enrollmentId),
    byStatus: index('subscription_status_idx').on(t.status),
    byExpiry: index('subscription_expiry_idx').on(t.validUntil),
  }),
);

/* -------------------------------------------------------------------------- */
/* payment — DD §10                                                           */
/*                                                                            */
/* Append-oriented. Once settled, amount/currency/paid_at/student/subscription  */
/* are frozen by trigger; a correction is a NEW row with adjustsPaymentId set.  */
/* -------------------------------------------------------------------------- */

export const payment = pgTable(
  'payment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id')
      .notNull()
      .unique()
      .default(sql`next_public_id('PAY')`),

    studentId: uuid('student_id')
      .notNull()
      .references(() => student.id),
    parentGuardianId: uuid('parent_guardian_id').references(() => parentGuardian.id),
    subscriptionId: uuid('subscription_id').references(() => subscription.id),
    enrollmentId: uuid('enrollment_id').references(() => enrollment.id),

    amountMinorUnits: bigint('amount_minor_units', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),

    paymentMethod: text('payment_method').$type<PaymentMethod>().notNull(),
    gatewayName: text('gateway_name'),
    gatewayReferenceId: text('gateway_reference_id'),

    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    status: text('status').$type<PaymentStatus>().notNull().default('pending'),

    invoiceReference: text('invoice_reference'),
    receiptReference: text('receipt_reference'),

    /** Refund/correction chain — DD §10. */
    adjustsPaymentId: uuid('adjusts_payment_id'),
    adjustmentType: text('adjustment_type').$type<AdjustmentType>(),
    adjustmentReason: text('adjustment_reason'),

    requiresApproval: boolean('requires_approval').notNull().default(false),
    approvalStatus: text('approval_status').$type<'pending' | 'approved' | 'rejected' | null>(),
    approvalId: uuid('approval_id'),
    requestedBy: uuid('requested_by').references(() => userAccount.id),
    approvedBy: uuid('approved_by').references(() => userAccount.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: uuid('archived_by').references(() => userAccount.id),
    archiveReason: text('archive_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => userAccount.id),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => userAccount.id),
    source: text('source').notNull().default('ui'),
  },
  (t) => ({
    byStudent: index('payment_student_idx').on(t.studentId),
    bySubscription: index('payment_subscription_idx').on(t.subscriptionId),
    byParent: index('payment_parent_idx').on(t.parentGuardianId),
    byStatus: index('payment_status_idx').on(t.status),
    byPaidAt: index('payment_paid_at_idx').on(t.paidAt),
    byAdjusts: index('payment_adjusts_idx').on(t.adjustsPaymentId),
    gatewayRef: uniqueIndex('payment_gateway_reference_uq').on(t.gatewayName, t.gatewayReferenceId),
  }),
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const enrollmentRelations = relations(enrollment, ({ one, many }) => ({
  student: one(student, { fields: [enrollment.studentId], references: [student.id] }),
  course: one(course, { fields: [enrollment.courseId], references: [course.id] }),
  subject: one(subject, { fields: [enrollment.subjectId], references: [subject.id] }),
  level: one(level, { fields: [enrollment.levelId], references: [level.id] }),
  subscriptions: many(subscription),
  payments: many(payment),
}));

export const subscriptionRelations = relations(subscription, ({ one, many }) => ({
  student: one(student, { fields: [subscription.studentId], references: [student.id] }),
  enrollment: one(enrollment, {
    fields: [subscription.enrollmentId],
    references: [enrollment.id],
  }),
  renewedFrom: one(subscription, {
    fields: [subscription.renewedFromSubscriptionId],
    references: [subscription.id],
    relationName: 'subscription_renewal',
  }),
  payments: many(payment),
}));

export const paymentRelations = relations(payment, ({ one }) => ({
  student: one(student, { fields: [payment.studentId], references: [student.id] }),
  parentGuardian: one(parentGuardian, {
    fields: [payment.parentGuardianId],
    references: [parentGuardian.id],
  }),
  subscription: one(subscription, {
    fields: [payment.subscriptionId],
    references: [subscription.id],
  }),
  enrollment: one(enrollment, {
    fields: [payment.enrollmentId],
    references: [enrollment.id],
  }),
  adjusts: one(payment, {
    fields: [payment.adjustsPaymentId],
    references: [payment.id],
    relationName: 'payment_adjustment',
  }),
}));

export type Enrollment = typeof enrollment.$inferSelect;
export type NewEnrollment = typeof enrollment.$inferInsert;
export type Subscription = typeof subscription.$inferSelect;
export type NewSubscription = typeof subscription.$inferInsert;
export type Payment = typeof payment.$inferSelect;
export type NewPayment = typeof payment.$inferInsert;
