/**
 * Operations & Delivery domain — Coordinator Ownership (DD §14), Class Schedule
 * (DD §15), Teacher Allocation (DD §13), Session (DD §16).
 *
 * Mirrors migrations/0011_coordinator_ownership.sql,
 * migrations/0012_class_schedule_session.sql and
 * migrations/0013_teacher_allocation.sql. SQL is the source of truth.
 *
 * `session.outcome` is constrained as of migration 0020 (SESSION_OUTCOME below).
 * The `compensation` table and its service-layer workflow live in
 * schema/compensation.ts and services/compensation.service.ts.
 */

import {
  pgTable,
  uuid,
  text,
  date,
  time,
  smallint,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { userAccount, course, subject } from './reference.js';
import { student, parentGuardian } from './identity.js';
import { enrollment } from './commercial.js';
import { employee, teacher } from './workforce.js';

export const OWNERSHIP_ROLE = [
  'onboarding',
  'student_success',
  'retention',
  'operations',
  'academic',
  'ticket',
  'escalation',
] as const;
export type OwnershipRole = (typeof OWNERSHIP_ROLE)[number];

export const ALLOCATION_TYPE = [
  'new_admission',
  'teacher_change',
  'schedule_change',
  'day_change',
  'session_type_change',
  'course_change',
  'student_requested',
  'teacher_unavailability',
  'academic',
  'break',
  'resume',
] as const;
export type AllocationType = (typeof ALLOCATION_TYPE)[number];

export const ALLOCATION_STATUS = [
  'proposed',
  'pending_approval',
  'active',
  'rejected',
  'superseded',
  'ended',
] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUS)[number];

export const CLASS_SCHEDULE_STATUS = [
  'draft',
  'active',
  'superseded',
  'paused',
  'ended',
  'cancelled',
  'discarded',
] as const;
export type ClassScheduleStatus = (typeof CLASS_SCHEDULE_STATUS)[number];

export const SESSION_TYPE = ['one_to_one', 'group'] as const;
export type SessionType = (typeof SESSION_TYPE)[number];

export const SESSION_PURPOSE = ['regular', 'compensation', 'replacement', 'extra'] as const;
export type SessionPurpose = (typeof SESSION_PURPOSE)[number];

export const SESSION_STATUS = [
  'scheduled',
  'reminder_sent',
  'confirmed',
  'live',
  'completed',
  'cancelled',
  'rescheduled',
  'abandoned',
] as const;
export type SessionStatus = (typeof SESSION_STATUS)[number];

export const SESSION_OUTCOME = [
  'completed',
  'teacher_absent',
  'teacher_technical_failure',
  'student_absent',
  'student_technical_failure',
  'cancelled_outside_cutoff',
  'cancelled_inside_cutoff',
] as const;
export type SessionOutcome = (typeof SESSION_OUTCOME)[number];

/** Outcomes that qualify a session for compensation (rule 19). */
export const COMPENSATION_QUALIFYING_OUTCOMES: readonly SessionOutcome[] = [
  'teacher_absent',
  'teacher_technical_failure',
];

/* -------------------------------------------------------------------------- */
/* coordinator_ownership — DD §14 (effective-dated)                           */
/* -------------------------------------------------------------------------- */

export const coordinatorOwnership = pgTable(
  'coordinator_ownership',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    studentId: uuid('student_id')
      .notNull()
      .references(() => student.id),
    parentGuardianId: uuid('parent_guardian_id').references(() => parentGuardian.id),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),

    ownershipRole: text('ownership_role').$type<OwnershipRole>().notNull(),
    escalationLevel: integer('escalation_level'),

    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    isCurrent: boolean('is_current').notNull().default(true),
    supersededById: uuid('superseded_by_id'),
    /** Mandatory on the OLD row when superseded (DD §14 "transfer reason"). */
    changeReason: text('change_reason'),

    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => userAccount.id),
    approvedBy: uuid('approved_by').references(() => userAccount.id),

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
    currentUq: uniqueIndex('coordinator_ownership_current_uq').on(t.studentId, t.ownershipRole),
    studentIdx: index('coordinator_ownership_student_idx').on(t.studentId),
    employeeIdx: index('coordinator_ownership_employee_idx').on(t.employeeId),
    historyIdx: index('coordinator_ownership_history_idx').on(t.studentId, t.ownershipRole, t.validFrom),
  }),
);

/* -------------------------------------------------------------------------- */
/* class_schedule — DD §15 (versioned)                                        */
/* -------------------------------------------------------------------------- */

export const classSchedule = pgTable(
  'class_schedule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id')
      .notNull()
      .unique()
      .default(sql`next_public_id('CLS')`),

    enrollmentId: uuid('enrollment_id')
      .notNull()
      .references(() => enrollment.id),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teacher.id),

    sessionType: text('session_type').$type<SessionType>().notNull().default('one_to_one'),
    courseId: uuid('course_id')
      .notNull()
      .references(() => course.id),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subject.id),

    /** 0 = Sunday .. 6 = Saturday. */
    daysOfWeek: smallint('days_of_week').array().notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    /** IANA zone name. Recurrence is wall-clock in this zone (CLAUDE.md §6). */
    timezone: text('timezone').notNull(),

    startDate: date('start_date').notNull(),
    plannedEndDate: date('planned_end_date'),
    isRecurring: boolean('is_recurring').notNull().default(true),

    status: text('status').$type<ClassScheduleStatus>().notNull().default('draft'),

    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    isCurrent: boolean('is_current').notNull().default(true),
    supersededById: uuid('superseded_by_id'),
    changeReason: text('change_reason'),
    requestedBy: uuid('requested_by').references(() => userAccount.id),
    approvedBy: uuid('approved_by').references(() => userAccount.id),

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
    currentUq: uniqueIndex('class_schedule_current_uq').on(t.enrollmentId),
    enrollmentIdx: index('class_schedule_enrollment_idx').on(t.enrollmentId),
    teacherIdx: index('class_schedule_teacher_idx').on(t.teacherId),
    historyIdx: index('class_schedule_history_idx').on(t.enrollmentId, t.validFrom),
  }),
);

/* -------------------------------------------------------------------------- */
/* teacher_allocation — DD §13 (effective-dated)                              */
/* -------------------------------------------------------------------------- */

export const teacherAllocation = pgTable(
  'teacher_allocation',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    enrollmentId: uuid('enrollment_id')
      .notNull()
      .references(() => enrollment.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => student.id),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teacher.id),
    classScheduleId: uuid('class_schedule_id')
      .notNull()
      .references(() => classSchedule.id),

    allocationType: text('allocation_type').$type<AllocationType>().notNull(),

    previousTeacherId: uuid('previous_teacher_id').references(() => teacher.id),
    previousClassScheduleId: uuid('previous_class_schedule_id').references(() => classSchedule.id),

    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => userAccount.id),
    approvedBy: uuid('approved_by').references(() => userAccount.id),

    status: text('status').$type<AllocationStatus>().notNull().default('proposed'),

    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    isCurrent: boolean('is_current').notNull().default(true),
    supersededById: uuid('superseded_by_id'),

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
    currentUq: uniqueIndex('teacher_allocation_current_uq').on(t.enrollmentId),
    teacherIdx: index('teacher_allocation_teacher_idx').on(t.teacherId),
    studentIdx: index('teacher_allocation_student_idx').on(t.studentId),
    historyIdx: index('teacher_allocation_history_idx').on(t.enrollmentId, t.validFrom),
  }),
);

/* -------------------------------------------------------------------------- */
/* session — DD §16                                                           */
/* -------------------------------------------------------------------------- */

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id')
      .notNull()
      .unique()
      .default(sql`next_public_id('SES')`),

    classScheduleId: uuid('class_schedule_id')
      .notNull()
      .references(() => classSchedule.id),
    enrollmentId: uuid('enrollment_id')
      .notNull()
      .references(() => enrollment.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => student.id),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teacher.id),

    scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }).notNull(),
    scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }).notNull(),
    actualStartAt: timestamp('actual_start_at', { withTimezone: true }),
    actualEndAt: timestamp('actual_end_at', { withTimezone: true }),

    sessionPurpose: text('session_purpose').$type<SessionPurpose>().notNull().default('regular'),
    status: text('status').$type<SessionStatus>().notNull().default('scheduled'),
    outcome: text('outcome').$type<SessionOutcome>(),

    cancellationReason: text('cancellation_reason'),
    rescheduledToSessionId: uuid('rescheduled_to_session_id'),
    /** Flag only — no logic sets or consumes this yet. */
    compensationRequired: boolean('compensation_required').notNull().default(false),

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
    scheduleIdx: index('session_schedule_idx').on(t.classScheduleId),
    enrollmentIdx: index('session_enrollment_idx').on(t.enrollmentId),
    studentIdx: index('session_student_idx').on(t.studentId),
    teacherUpcomingIdx: index('session_teacher_upcoming_idx').on(t.teacherId, t.scheduledStartAt),
    statusIdx: index('session_status_idx').on(t.status),
  }),
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const coordinatorOwnershipRelations = relations(coordinatorOwnership, ({ one }) => ({
  student: one(student, { fields: [coordinatorOwnership.studentId], references: [student.id] }),
  parentGuardian: one(parentGuardian, {
    fields: [coordinatorOwnership.parentGuardianId],
    references: [parentGuardian.id],
  }),
  employee: one(employee, { fields: [coordinatorOwnership.employeeId], references: [employee.id] }),
  supersededBy: one(coordinatorOwnership, {
    fields: [coordinatorOwnership.supersededById],
    references: [coordinatorOwnership.id],
    relationName: 'coordinator_ownership_supersession',
  }),
}));

export const classScheduleRelations = relations(classSchedule, ({ one, many }) => ({
  enrollment: one(enrollment, { fields: [classSchedule.enrollmentId], references: [enrollment.id] }),
  teacher: one(teacher, { fields: [classSchedule.teacherId], references: [teacher.id] }),
  course: one(course, { fields: [classSchedule.courseId], references: [course.id] }),
  subject: one(subject, { fields: [classSchedule.subjectId], references: [subject.id] }),
  supersededBy: one(classSchedule, {
    fields: [classSchedule.supersededById],
    references: [classSchedule.id],
    relationName: 'class_schedule_supersession',
  }),
  sessions: many(session),
}));

export const teacherAllocationRelations = relations(teacherAllocation, ({ one }) => ({
  enrollment: one(enrollment, { fields: [teacherAllocation.enrollmentId], references: [enrollment.id] }),
  student: one(student, { fields: [teacherAllocation.studentId], references: [student.id] }),
  teacher: one(teacher, { fields: [teacherAllocation.teacherId], references: [teacher.id] }),
  classSchedule: one(classSchedule, {
    fields: [teacherAllocation.classScheduleId],
    references: [classSchedule.id],
  }),
  previousTeacher: one(teacher, {
    fields: [teacherAllocation.previousTeacherId],
    references: [teacher.id],
    relationName: 'allocation_previous_teacher',
  }),
  previousClassSchedule: one(classSchedule, {
    fields: [teacherAllocation.previousClassScheduleId],
    references: [classSchedule.id],
    relationName: 'allocation_previous_schedule',
  }),
  supersededBy: one(teacherAllocation, {
    fields: [teacherAllocation.supersededById],
    references: [teacherAllocation.id],
    relationName: 'teacher_allocation_supersession',
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  classSchedule: one(classSchedule, { fields: [session.classScheduleId], references: [classSchedule.id] }),
  enrollment: one(enrollment, { fields: [session.enrollmentId], references: [enrollment.id] }),
  student: one(student, { fields: [session.studentId], references: [student.id] }),
  teacher: one(teacher, { fields: [session.teacherId], references: [teacher.id] }),
  rescheduledTo: one(session, {
    fields: [session.rescheduledToSessionId],
    references: [session.id],
    relationName: 'session_reschedule',
  }),
}));

export type CoordinatorOwnership = typeof coordinatorOwnership.$inferSelect;
export type NewCoordinatorOwnership = typeof coordinatorOwnership.$inferInsert;
export type ClassSchedule = typeof classSchedule.$inferSelect;
export type NewClassSchedule = typeof classSchedule.$inferInsert;
export type TeacherAllocation = typeof teacherAllocation.$inferSelect;
export type NewTeacherAllocation = typeof teacherAllocation.$inferInsert;
export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;
