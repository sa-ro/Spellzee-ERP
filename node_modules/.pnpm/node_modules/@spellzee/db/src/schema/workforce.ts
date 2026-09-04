/**
 * Workforce domain — Employee (DD §29 Phase 1 subset), Teacher master profile
 * (DD §11), Teacher Availability + Capacity (DD §12).
 *
 * Mirrors migrations/0009_employee_teacher.sql and
 * migrations/0010_teacher_availability_capacity.sql. SQL is the source of
 * truth for constraints, triggers and the exclusion constraints below —
 * Drizzle only reflects the shape.
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
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { userAccount, subject, level, language } from './reference.js';

export const EMPLOYMENT_STATUS = ['onboarding', 'active', 'inactive', 'exited', 'archived'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUS)[number];

export const AVAILABILITY_TYPE = ['regular', 'specific_date', 'temporary', 'unavailable'] as const;
export type AvailabilityType = (typeof AVAILABILITY_TYPE)[number];

export const PROFICIENCY = ['native', 'fluent', 'conversational', 'basic'] as const;
export type Proficiency = (typeof PROFICIENCY)[number];

/* -------------------------------------------------------------------------- */
/* employee — DD §29 (Phase 1 subset)                                         */
/* -------------------------------------------------------------------------- */

export const employee = pgTable(
  'employee',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id')
      .notNull()
      .unique()
      .default(sql`next_public_id('EMP')`),

    fullName: text('full_name').notNull(),
    department: text('department').notNull(),
    roleTitle: text('role_title').notNull(),
    joiningDate: date('joining_date').notNull(),
    employmentStatus: text('employment_status').$type<EmploymentStatus>().notNull().default('active'),
    managerEmployeeId: uuid('manager_employee_id'),

    /** Nullable, unique: not every employee has ERP access. */
    userAccountId: uuid('user_account_id').references(() => userAccount.id),

    exitDate: date('exit_date'),
    exitReason: text('exit_reason'),

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
    userAccountUq: uniqueIndex('employee_user_account_uq').on(t.userAccountId),
    managerIdx: index('employee_manager_idx').on(t.managerEmployeeId),
    statusIdx: index('employee_status_idx').on(t.employmentStatus),
  }),
);

/* -------------------------------------------------------------------------- */
/* teacher — DD §11 (Phase 1 subset: master profile only)                     */
/* -------------------------------------------------------------------------- */

export const teacher = pgTable(
  'teacher',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id')
      .notNull()
      .unique()
      .default(sql`next_public_id('TCH')`),

    /** Nullable — contractors are teachers without an HR employee record. */
    employeeId: uuid('employee_id').references(() => employee.id),

    fullName: text('full_name').notNull(),

    qualifications: jsonb('qualifications'),
    experience: jsonb('experience'),
    specializations: jsonb('specializations'),

    employmentStatus: text('employment_status').$type<EmploymentStatus>().notNull().default('onboarding'),

    /** Rule 25: manually set in Phase 1, requires an explicit reason. */
    isAllocationEligible: boolean('is_allocation_eligible').notNull().default(false),
    allocationEligibilityReason: text('allocation_eligibility_reason'),

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
    employeeIdx: index('teacher_employee_idx').on(t.employeeId),
    statusIdx: index('teacher_status_idx').on(t.employmentStatus),
    eligibleIdx: index('teacher_eligible_idx').on(t.isAllocationEligible),
  }),
);

/* -------------------------------------------------------------------------- */
/* Capability tables — deliberate exception: ordinary delete is allowed        */
/* (current tags, not transactional history — see 0009's header comment).      */
/* -------------------------------------------------------------------------- */

export const teacherSubject = pgTable(
  'teacher_subject',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teacher.id),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subject.id),
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
    uq: uniqueIndex('teacher_subject_uq').on(t.teacherId, t.subjectId),
    lookup: index('teacher_subject_lookup_idx').on(t.subjectId, t.teacherId),
  }),
);

export const teacherLevel = pgTable(
  'teacher_level',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teacher.id),
    levelId: uuid('level_id')
      .notNull()
      .references(() => level.id),
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
    uq: uniqueIndex('teacher_level_uq').on(t.teacherId, t.levelId),
    lookup: index('teacher_level_lookup_idx').on(t.levelId, t.teacherId),
  }),
);

export const teacherLanguage = pgTable(
  'teacher_language',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teacher.id),
    languageId: uuid('language_id')
      .notNull()
      .references(() => language.id),
    proficiency: text('proficiency').$type<Proficiency>().notNull().default('fluent'),
    /** Tamil-English, Hindi-English etc. (Master §13.1). */
    isBilingualPair: boolean('is_bilingual_pair').notNull().default(false),
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
    uq: uniqueIndex('teacher_language_uq').on(t.teacherId, t.languageId),
    lookup: index('teacher_language_lookup_idx').on(t.languageId, t.teacherId),
  }),
);

/* -------------------------------------------------------------------------- */
/* teacher_availability — DD §12.1                                            */
/*                                                                            */
/* NOT effective-dated with is_current/superseded_by: a teacher legitimately   */
/* holds multiple simultaneous rules (rule 8 — availability ≠ capacity).       */
/* -------------------------------------------------------------------------- */

export const teacherAvailability = pgTable(
  'teacher_availability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teacher.id),

    availabilityType: text('availability_type').$type<AvailabilityType>().notNull(),

    /** 0 = Sunday .. 6 = Saturday. Exactly one of dayOfWeek/specificDateOn is set. */
    dayOfWeek: smallint('day_of_week'),
    specificDateOn: date('specific_date_on'),

    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    timezone: text('timezone').notNull(),

    effectiveFrom: date('effective_from').notNull().defaultNow(),
    effectiveTo: date('effective_to'),

    reason: text('reason'),
    approvalId: uuid('approval_id'),

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
    teacherIdx: index('teacher_availability_teacher_idx').on(t.teacherId),
    regularIdx: index('teacher_availability_regular_idx').on(t.teacherId, t.dayOfWeek),
    datedIdx: index('teacher_availability_dated_idx').on(t.teacherId, t.specificDateOn),
  }),
);

/* -------------------------------------------------------------------------- */
/* teacher_capacity — DD §12.2 (Phase 1: current capacity only)               */
/*                                                                            */
/* freeCapacityMinutes is a Postgres GENERATED column — never write to it.     */
/* allocatedCapacityMinutes is bookkeeping maintained by the allocation        */
/* service inside the same transaction as each allocation change.             */
/* -------------------------------------------------------------------------- */

export const teacherCapacity = pgTable(
  'teacher_capacity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => teacher.id),

    dayOfWeek: smallint('day_of_week').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),

    plannedCapacityMinutes: integer('planned_capacity_minutes').notNull(),
    allocatedCapacityMinutes: integer('allocated_capacity_minutes').notNull().default(0),
    reservedMinutes: integer('reserved_minutes').notNull().default(0),
    /** Generated column: plannedCapacityMinutes - allocatedCapacityMinutes - reservedMinutes. */
    freeCapacityMinutes: integer('free_capacity_minutes').generatedAlwaysAs(
      sql`planned_capacity_minutes - allocated_capacity_minutes - reserved_minutes`,
    ),

    effectiveFrom: date('effective_from').notNull().defaultNow(),
    effectiveTo: date('effective_to'),
    isCurrent: boolean('is_current').notNull().default(true),

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
    teacherIdx: index('teacher_capacity_teacher_idx').on(t.teacherId),
    slotIdx: index('teacher_capacity_slot_idx').on(t.teacherId, t.dayOfWeek, t.startTime, t.endTime),
  }),
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const employeeRelations = relations(employee, ({ one, many }) => ({
  manager: one(employee, {
    fields: [employee.managerEmployeeId],
    references: [employee.id],
    relationName: 'employee_manager',
  }),
  userAccount: one(userAccount, {
    fields: [employee.userAccountId],
    references: [userAccount.id],
  }),
  teachers: many(teacher),
}));

export const teacherRelations = relations(teacher, ({ one, many }) => ({
  employee: one(employee, { fields: [teacher.employeeId], references: [employee.id] }),
  subjects: many(teacherSubject),
  levels: many(teacherLevel),
  languages: many(teacherLanguage),
  availability: many(teacherAvailability),
  capacity: many(teacherCapacity),
}));

export const teacherSubjectRelations = relations(teacherSubject, ({ one }) => ({
  teacher: one(teacher, { fields: [teacherSubject.teacherId], references: [teacher.id] }),
  subject: one(subject, { fields: [teacherSubject.subjectId], references: [subject.id] }),
}));

export const teacherLevelRelations = relations(teacherLevel, ({ one }) => ({
  teacher: one(teacher, { fields: [teacherLevel.teacherId], references: [teacher.id] }),
  level: one(level, { fields: [teacherLevel.levelId], references: [level.id] }),
}));

export const teacherLanguageRelations = relations(teacherLanguage, ({ one }) => ({
  teacher: one(teacher, { fields: [teacherLanguage.teacherId], references: [teacher.id] }),
  language: one(language, { fields: [teacherLanguage.languageId], references: [language.id] }),
}));

export const teacherAvailabilityRelations = relations(teacherAvailability, ({ one }) => ({
  teacher: one(teacher, { fields: [teacherAvailability.teacherId], references: [teacher.id] }),
}));

export const teacherCapacityRelations = relations(teacherCapacity, ({ one }) => ({
  teacher: one(teacher, { fields: [teacherCapacity.teacherId], references: [teacher.id] }),
}));

export type Employee = typeof employee.$inferSelect;
export type NewEmployee = typeof employee.$inferInsert;
export type Teacher = typeof teacher.$inferSelect;
export type NewTeacher = typeof teacher.$inferInsert;
export type TeacherAvailability = typeof teacherAvailability.$inferSelect;
export type NewTeacherAvailability = typeof teacherAvailability.$inferInsert;
export type TeacherCapacity = typeof teacherCapacity.$inferSelect;
export type NewTeacherCapacity = typeof teacherCapacity.$inferInsert;
