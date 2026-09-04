/**
 * attendance. Mirrors migrations/0025_attendance.sql + 0026_attendance_audit_guards.sql.
 */

import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { userAccount } from './reference.js';
import { session } from './operations.js';
import { student } from './identity.js';

export const ATTENDANCE_STATUS = ['present', 'late', 'partial', 'absent'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUS)[number];

export const attendance = pgTable(
  'attendance',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    sessionId: uuid('session_id').notNull().references(() => session.id),
    studentId: uuid('student_id').notNull().references(() => student.id),

    attendanceStatus: text('attendance_status').$type<AttendanceStatus>().notNull(),
    presentMinutes: integer('present_minutes').notNull(),
    totalMinutes: integer('total_minutes').notNull(),
    lateByMinutes: integer('late_by_minutes').notNull().default(0),

    notes: text('notes'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').notNull().references(() => userAccount.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
    source: text('source').notNull().default('ui'),
  },
  (t) => ({
    sessionUq: uniqueIndex('attendance_session_uq').on(t.sessionId),
    byStudent: index('attendance_student_idx').on(t.studentId),
    byStatus: index('attendance_status_idx').on(t.attendanceStatus),
  }),
);

export type Attendance = typeof attendance.$inferSelect;
