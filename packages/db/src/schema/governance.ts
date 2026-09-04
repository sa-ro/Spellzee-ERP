/**
 * Governance & RBAC — role, permission, role_permission, user_role, user_session,
 * approval_request. Mirrors migrations/0015_governance_rbac.sql +
 * 0016_governance_audit_guards.sql. DD §38-41, §39 (approval_request), Master §22.
 */

import { pgTable, uuid, text, boolean, timestamp, jsonb, index, uniqueIndex, inet } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { userAccount } from './reference.js';

export const USER_ROLE_SCOPE = ['own', 'all'] as const;
export type UserRoleScope = (typeof USER_ROLE_SCOPE)[number];

export const APPROVAL_STATUS = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number];

/* -------------------------------------------------------------------------- */
/* role / permission / role_permission — DD §40                              */
/* -------------------------------------------------------------------------- */

export const role = pgTable('role', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const permission = pgTable('permission', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  resource: text('resource').notNull(),
  action: text('action').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermission = pgTable(
  'role_permission',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roleId: uuid('role_id').notNull().references(() => role.id),
    permissionId: uuid('permission_id').notNull().references(() => permission.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
  },
  (t) => ({
    uq: uniqueIndex('role_permission_uq').on(t.roleId, t.permissionId),
    byPermission: index('role_permission_permission_idx').on(t.permissionId),
  }),
);

/* -------------------------------------------------------------------------- */
/* user_role — effective-dated (layer 2 history), DD §40, rule 12, rule 24    */
/* -------------------------------------------------------------------------- */

export const userRole = pgTable(
  'user_role',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userAccountId: uuid('user_account_id').notNull().references(() => userAccount.id),
    roleId: uuid('role_id').notNull().references(() => role.id),
    scope: text('scope').$type<UserRoleScope>().notNull().default('own'),

    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    isCurrent: boolean('is_current').notNull().default(true),
    supersededById: uuid('superseded_by_id'),
    changeReason: text('change_reason'),
    grantedBy: uuid('granted_by').notNull().references(() => userAccount.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
  },
  (t) => ({
    currentUq: uniqueIndex('user_role_current_uq')
      .on(t.userAccountId, t.roleId)
      .where(sql`is_current`),
    byUser: index('user_role_user_idx').on(t.userAccountId).where(sql`is_current`),
    history: index('user_role_history_idx').on(t.userAccountId, t.roleId, t.validFrom),
  }),
);

/* -------------------------------------------------------------------------- */
/* user_session — DD §41 session metadata for audit_event                     */
/* -------------------------------------------------------------------------- */

export const userSession = pgTable(
  'user_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userAccountId: uuid('user_account_id').notNull().references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
  },
  (t) => ({
    byUser: index('user_session_user_idx').on(t.userAccountId),
    active: index('user_session_active_idx')
      .on(t.userAccountId, t.expiresAt)
      .where(sql`revoked_at IS NULL`),
  }),
);

/* -------------------------------------------------------------------------- */
/* approval_request — DD §39, the maker-checker infrastructure table          */
/* -------------------------------------------------------------------------- */

export const approvalRequest = pgTable(
  'approval_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id').notNull().unique(),

    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    reason: text('reason').notNull(),

    status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
    requestedBy: uuid('requested_by').notNull().references(() => userAccount.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid('approved_by').references(() => userAccount.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => userAccount.id),
    updatedBy: uuid('updated_by').notNull().references(() => userAccount.id),
  },
  (t) => ({
    pending: index('approval_request_pending_idx').on(t.status).where(sql`status = 'pending'`),
    entity: index('approval_request_entity_idx').on(t.entityType, t.entityId),
    requester: index('approval_request_requester_idx').on(t.requestedBy),
  }),
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const rolePermissionRelations = relations(rolePermission, ({ one }) => ({
  role: one(role, { fields: [rolePermission.roleId], references: [role.id] }),
  permission: one(permission, { fields: [rolePermission.permissionId], references: [permission.id] }),
}));

export const userRoleRelations = relations(userRole, ({ one }) => ({
  role: one(role, { fields: [userRole.roleId], references: [role.id] }),
  user: one(userAccount, { fields: [userRole.userAccountId], references: [userAccount.id] }),
}));

export type Role = typeof role.$inferSelect;
export type Permission = typeof permission.$inferSelect;
export type RolePermission = typeof rolePermission.$inferSelect;
export type UserRole = typeof userRole.$inferSelect;
export type UserSession = typeof userSession.$inferSelect;
export type ApprovalRequest = typeof approvalRequest.$inferSelect;
