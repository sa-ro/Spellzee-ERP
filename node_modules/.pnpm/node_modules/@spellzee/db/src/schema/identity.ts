/**
 * Identity domain — Parent/Guardian (DD §5), Student (DD §6),
 * Contact & Identity History (DD §7).
 *
 * These mirror the SQL in migrations/0004_identity.sql and 0005_identity_match.sql.
 * The SQL is the source of truth; Drizzle gives us types and query building.
 * Constraints, triggers and grants live in SQL only — see CLAUDE.md §6.
 */

import {
  pgTable,
  uuid,
  text,
  date,
  boolean,
  timestamp,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { userAccount, language } from './reference.js';

/* -------------------------------------------------------------------------- */
/* Controlled vocabularies — mirrored from the SQL CHECK constraints.          */
/* Kept as const unions rather than pg enums so values can change without a    */
/* table rewrite (CLAUDE.md §6).                                              */
/* -------------------------------------------------------------------------- */

export const STUDENT_STATUS = [
  'active',
  'break',
  'completed',
  'cancelled',
  'inactive',
  'merged',
  'archived',
] as const;
export type StudentStatus = (typeof STUDENT_STATUS)[number];

export const PARENT_STATUS = ['active', 'inactive', 'archived'] as const;
export type ParentStatus = (typeof PARENT_STATUS)[number];

export const CONTACT_TYPE = ['phone', 'alternate_phone', 'email', 'name', 'address'] as const;
export type ContactType = (typeof CONTACT_TYPE)[number];

export const RELATIONSHIP_TYPE = [
  'parent',
  'guardian',
  'grandparent',
  'sibling',
  'other',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPE)[number];

export const MATCH_BAND = ['clear', 'review', 'block'] as const;
export type MatchBand = (typeof MATCH_BAND)[number];

export const MATCH_DECISION = ['created_new', 'used_existing', 'abandoned', 'blocked'] as const;
export type MatchDecision = (typeof MATCH_DECISION)[number];

/* -------------------------------------------------------------------------- */
/* parent_guardian — DD §5                                                    */
/* -------------------------------------------------------------------------- */

export const parentGuardian = pgTable(
  'parent_guardian',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id')
      .notNull()
      .unique()
      .default(sql`next_public_id('PAR')`),

    fullName: text('full_name').notNull(),
    /** Generated column — never write to this. */
    fullNameNormalized: text('full_name_normalized').generatedAlwaysAs(
      sql`normalize_name(full_name)`,
    ),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    addressCity: text('address_city'),
    addressState: text('address_state'),
    addressPostalCode: text('address_postal_code'),
    addressCountry: text('address_country'),

    preferredLanguageId: uuid('preferred_language_id').references(() => language.id),
    communicationPreference: text('communication_preference').$type<
      'whatsapp' | 'in_app' | 'email' | 'phone' | null
    >(),
    notes: text('notes'),

    status: text('status').$type<ParentStatus>().notNull().default('active'),

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
    nameTrgm: index('parent_guardian_name_trgm_idx').using(
      'gin',
      sql`${t.fullNameNormalized} gin_trgm_ops`,
    ),
    active: index('parent_guardian_active_idx').on(t.status),
  }),
);

/* -------------------------------------------------------------------------- */
/* student — DD §6                                                            */
/*                                                                            */
/* Note what is NOT here: phone, email, address, current teacher, current      */
/* schedule, attendance summary. DD §6.2 lists those as links, not columns —   */
/* they are views. Denormalising them here guarantees silent drift.            */
/* -------------------------------------------------------------------------- */

export const student = pgTable(
  'student',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Permanent identity. Immutable — enforced by trigger (rule 1, DD §6.3). */
    publicId: text('public_id')
      .notNull()
      .unique()
      .default(sql`next_public_id('STU')`),

    fullName: text('full_name').notNull(),
    fullNameNormalized: text('full_name_normalized').generatedAlwaysAs(
      sql`normalize_name(full_name)`,
    ),
    preferredName: text('preferred_name'),

    dateOfBirth: date('date_of_birth'),
    gender: text('gender').$type<'male' | 'female' | 'other' | 'undisclosed' | null>(),

    preferredLanguageId: uuid('preferred_language_id').references(() => language.id),
    learningLanguageId: uuid('learning_language_id').references(() => language.id),

    status: text('status').$type<StudentStatus>().notNull().default('active'),
    sourceChannel: text('source_channel').notNull().default('manual'),

    /** Set on merge. The row is retained, never deleted (rule 4). */
    mergedIntoStudentId: uuid('merged_into_student_id'),
    mergedAt: timestamp('merged_at', { withTimezone: true }),

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
    nameTrgm: index('student_name_trgm_idx').using(
      'gin',
      sql`${t.fullNameNormalized} gin_trgm_ops`,
    ),
    status: index('student_status_idx').on(t.status),
    merged: index('student_merged_idx').on(t.mergedIntoStudentId),
    dob: index('student_dob_idx').on(t.dateOfBirth),
  }),
);

/* -------------------------------------------------------------------------- */
/* student_parent_link — DD §5                                                */
/* -------------------------------------------------------------------------- */

export const studentParentLink = pgTable(
  'student_parent_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => student.id),
    parentGuardianId: uuid('parent_guardian_id')
      .notNull()
      .references(() => parentGuardian.id),

    relationshipType: text('relationship_type').$type<RelationshipType>().notNull(),
    isPrimaryContact: boolean('is_primary_contact').notNull().default(false),
    mayReceiveReports: boolean('may_receive_reports').notNull().default(true),
    mayRequestChanges: boolean('may_request_changes').notNull().default(false),

    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    isCurrent: boolean('is_current').notNull().default(true),
    changeReason: text('change_reason'),

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
    currentPair: uniqueIndex('student_parent_link_current_uq').on(t.studentId, t.parentGuardianId),
    onePrimary: uniqueIndex('student_parent_link_one_primary_uq').on(t.studentId),
    byParent: index('student_parent_link_parent_idx').on(t.parentGuardianId),
  }),
);

/* -------------------------------------------------------------------------- */
/* contact_history — DD §7                                                    */
/*                                                                            */
/* Exactly one owner: student_id XOR parent_guardian_id. Two nullable FKs      */
/* rather than a polymorphic pair, so referential integrity survives.          */
/* -------------------------------------------------------------------------- */

export const contactHistory = pgTable(
  'contact_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    studentId: uuid('student_id').references(() => student.id),
    parentGuardianId: uuid('parent_guardian_id').references(() => parentGuardian.id),

    contactType: text('contact_type').$type<ContactType>().notNull(),
    value: text('value').notNull(),
    /** Generated. Phones collapse to trailing 10 digits; emails lowercased. */
    valueNormalized: text('value_normalized').generatedAlwaysAs(
      sql`CASE contact_type
            WHEN 'phone'           THEN normalize_phone(value)
            WHEN 'alternate_phone' THEN normalize_phone(value)
            WHEN 'email'           THEN normalize_email(value)
            ELSE normalize_name(value)
          END`,
    ),

    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    isPrimary: boolean('is_primary').notNull().default(false),
    isVerified: boolean('is_verified').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),

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
    normalized: index('contact_history_normalized_idx').on(t.contactType, t.valueNormalized),
    normalizedAll: index('contact_history_normalized_all_idx').on(t.valueNormalized),
    byStudent: index('contact_history_student_idx').on(t.studentId),
    byParent: index('contact_history_parent_idx').on(t.parentGuardianId),
  }),
);

/* -------------------------------------------------------------------------- */
/* identity_match — DD §7                                                     */
/* -------------------------------------------------------------------------- */

/** One scored duplicate candidate, as stored in identity_match.candidates. */
export interface MatchCandidate {
  studentId: string;
  publicId: string;
  fullName: string;
  score: number;
  signals: MatchSignal[];
}

export interface MatchSignal {
  kind:
    | 'exact_phone'
    | 'exact_alternate_phone'
    | 'exact_email'
    | 'name_similarity'
    | 'parent_name_similarity'
    | 'date_of_birth';
  weight: number;
  detail: string;
}

export const identityMatch = pgTable(
  'identity_match',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    attemptedRecord: jsonb('attempted_record').notNull(),
    searchName: text('search_name'),
    searchPhones: text('search_phones').array().notNull().default(sql`'{}'`),
    searchEmails: text('search_emails').array().notNull().default(sql`'{}'`),

    candidateCount: integer('candidate_count').notNull().default(0),
    candidates: jsonb('candidates').$type<MatchCandidate[]>().notNull().default([]),

    topCandidateStudentId: uuid('top_candidate_student_id').references(() => student.id),
    topScore: numeric('top_score', { precision: 5, scale: 4 }),
    band: text('band').$type<MatchBand>().notNull(),

    decision: text('decision').$type<MatchDecision>(),
    decisionReason: text('decision_reason'),
    decidedStudentId: uuid('decided_student_id').references(() => student.id),
    decidedBy: uuid('decided_by').references(() => userAccount.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),

    /** rule 28 — thresholds in force when this decision was made. */
    matchingRulesetVersion: text('matching_ruleset_version').notNull(),

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
    topCandidate: index('identity_match_top_candidate_idx').on(t.topCandidateStudentId),
    band: index('identity_match_band_idx').on(t.band, t.createdAt),
  }),
);

/* -------------------------------------------------------------------------- */
/* merge_event — DD §7                                                        */
/* -------------------------------------------------------------------------- */

export const mergeEvent = pgTable(
  'merge_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    sourceStudentId: uuid('source_student_id')
      .notNull()
      .references(() => student.id),
    targetStudentId: uuid('target_student_id')
      .notNull()
      .references(() => student.id),

    reason: text('reason').notNull(),
    identityMatchId: uuid('identity_match_id').references(() => identityMatch.id),

    /** Maker-checker — DB CHECK enforces requestedBy <> approvedBy (rule 22). */
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => userAccount.id),
    approvedBy: uuid('approved_by')
      .notNull()
      .references(() => userAccount.id),
    approvalId: uuid('approval_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),

    relationshipsMoved: jsonb('relationships_moved')
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),

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
    bySource: index('merge_event_source_idx').on(t.sourceStudentId),
    byTarget: index('merge_event_target_idx').on(t.targetStudentId),
  }),
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const studentRelations = relations(student, ({ one, many }) => ({
  mergedInto: one(student, {
    fields: [student.mergedIntoStudentId],
    references: [student.id],
    relationName: 'student_merge',
  }),
  preferredLanguage: one(language, {
    fields: [student.preferredLanguageId],
    references: [language.id],
    relationName: 'student_preferred_language',
  }),
  learningLanguage: one(language, {
    fields: [student.learningLanguageId],
    references: [language.id],
    relationName: 'student_learning_language',
  }),
  guardianLinks: many(studentParentLink),
  contacts: many(contactHistory),
}));

export const parentGuardianRelations = relations(parentGuardian, ({ one, many }) => ({
  preferredLanguage: one(language, {
    fields: [parentGuardian.preferredLanguageId],
    references: [language.id],
  }),
  studentLinks: many(studentParentLink),
  contacts: many(contactHistory),
}));

export const studentParentLinkRelations = relations(studentParentLink, ({ one }) => ({
  student: one(student, {
    fields: [studentParentLink.studentId],
    references: [student.id],
  }),
  parentGuardian: one(parentGuardian, {
    fields: [studentParentLink.parentGuardianId],
    references: [parentGuardian.id],
  }),
}));

export const contactHistoryRelations = relations(contactHistory, ({ one }) => ({
  student: one(student, {
    fields: [contactHistory.studentId],
    references: [student.id],
  }),
  parentGuardian: one(parentGuardian, {
    fields: [contactHistory.parentGuardianId],
    references: [parentGuardian.id],
  }),
}));

export const mergeEventRelations = relations(mergeEvent, ({ one }) => ({
  sourceStudent: one(student, {
    fields: [mergeEvent.sourceStudentId],
    references: [student.id],
    relationName: 'merge_source',
  }),
  targetStudent: one(student, {
    fields: [mergeEvent.targetStudentId],
    references: [student.id],
    relationName: 'merge_target',
  }),
  identityMatch: one(identityMatch, {
    fields: [mergeEvent.identityMatchId],
    references: [identityMatch.id],
  }),
}));

export type Student = typeof student.$inferSelect;
export type NewStudent = typeof student.$inferInsert;
export type ParentGuardian = typeof parentGuardian.$inferSelect;
export type NewParentGuardian = typeof parentGuardian.$inferInsert;
export type ContactHistory = typeof contactHistory.$inferSelect;
export type NewContactHistory = typeof contactHistory.$inferInsert;
export type StudentParentLink = typeof studentParentLink.$inferSelect;
export type IdentityMatch = typeof identityMatch.$inferSelect;
export type NewIdentityMatch = typeof identityMatch.$inferInsert;
export type MergeEvent = typeof mergeEvent.$inferSelect;
