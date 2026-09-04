/**
 * Supporting master data and the minimal actor identity.
 *
 * Mirrors migrations/0003_supporting_master_data.sql. These exist because the
 * in-scope entities reference them (created_by, language, course/subject/level);
 * their full specifications are in docs/data-model/02-entity-specifications.md.
 */

import { pgTable, uuid, text, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const userAccount = pgTable('user_account', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash'),
  isServiceAccount: boolean('is_service_account').notNull().default(false),
  status: text('status').$type<'active' | 'suspended' | 'disabled'>().notNull().default('active'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  totpSecretEncrypted: text('totp_secret_encrypted'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The built-in actor used by migrations, seeds and system jobs. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

export const language = pgTable('language', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subject = pgTable('subject', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const level = pgTable('level', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const course = pgTable(
  'course',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subject.id),
    defaultDurationMinutes: integer('default_duration_minutes').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySubject: index('course_subject_idx').on(t.subjectId),
  }),
);

export const courseRelations = relations(course, ({ one }) => ({
  subject: one(subject, {
    fields: [course.subjectId],
    references: [subject.id],
  }),
}));

export type UserAccount = typeof userAccount.$inferSelect;
export type Language = typeof language.$inferSelect;
export type Subject = typeof subject.$inferSelect;
export type Level = typeof level.$inferSelect;
export type Course = typeof course.$inferSelect;
