/**
 * Coordinator ownership transfers — DD §14, Master §9.
 *
 * "Ownership must be explicit. The system should never rely on employees
 * remembering who is responsible." Every transfer is logged with a reason and
 * effective dates, and never overwrites the previous owner in place — the old
 * row is superseded (valid_to, is_current=false, superseded_by_id), matching
 * the same history-preservation pattern as teacher_allocation (rule 12).
 */

import { and, eq } from 'drizzle-orm';
import type { ActorContext, Database } from '../client.js';
import { getDb, withActor } from '../client.js';
import { coordinatorOwnership, type CoordinatorOwnership, type OwnershipRole } from '../schema/operations.js';

export class OwnershipError extends Error {}

export interface TransferOwnershipInput {
  studentId: string;
  employeeId: string;
  ownershipRole: OwnershipRole;
  reason: string;
  requestedBy: string;
  approvedBy?: string;
  parentGuardianId?: string;
  escalationLevel?: number;
  /** Defaults to now(). Backdating/future-dating a transfer is not supported yet. */
  effectiveFrom?: Date;
}

export interface TransferOwnershipResult {
  previous: CoordinatorOwnership | null;
  current: CoordinatorOwnership;
}

/**
 * Assigns or reassigns the owner for a (student, role) pair.
 *
 * If a current owner already exists for this role, it is superseded with the
 * given reason — never UPDATEd in place (rule 12, DD §14). If none exists,
 * this is a fresh assignment and `change_reason` on the new row stays NULL
 * (there is nothing to explain a transition FROM).
 */
export async function transferOwnership(
  ctx: ActorContext,
  input: TransferOwnershipInput,
  db: Database = getDb(),
): Promise<TransferOwnershipResult> {
  if (!input.reason || input.reason.trim() === '') {
    throw new OwnershipError('A reason is required for every ownership assignment or transfer.');
  }
  if (input.escalationLevel !== undefined && input.ownershipRole !== 'escalation') {
    throw new OwnershipError('escalationLevel may only be set when ownershipRole is "escalation".');
  }

  return withActor(
    { ...ctx, reason: input.reason },
    async (tx) => {
      const [previous] = await tx
        .select()
        .from(coordinatorOwnership)
        .where(
          and(
            eq(coordinatorOwnership.studentId, input.studentId),
            eq(coordinatorOwnership.ownershipRole, input.ownershipRole),
            eq(coordinatorOwnership.isCurrent, true),
          ),
        );

      if (previous && previous.employeeId === input.employeeId) {
        throw new OwnershipError(
          `Employee ${input.employeeId} already holds the current "${input.ownershipRole}" ` +
            `ownership for student ${input.studentId} — nothing to transfer.`,
        );
      }

      const effectiveFrom = input.effectiveFrom ?? new Date();

      if (previous) {
        await tx
          .update(coordinatorOwnership)
          .set({
            isCurrent: false,
            validTo: effectiveFrom,
            changeReason: input.reason,
          })
          .where(eq(coordinatorOwnership.id, previous.id));
      }

      const [next] = await tx
        .insert(coordinatorOwnership)
        .values({
          studentId: input.studentId,
          parentGuardianId: input.parentGuardianId ?? null,
          employeeId: input.employeeId,
          ownershipRole: input.ownershipRole,
          escalationLevel: input.escalationLevel ?? null,
          validFrom: effectiveFrom,
          requestedBy: input.requestedBy,
          approvedBy: input.approvedBy ?? null,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();

      if (!next) {
        throw new OwnershipError('Failed to insert coordinator_ownership.');
      }

      if (previous) {
        await tx
          .update(coordinatorOwnership)
          .set({ supersededById: next.id })
          .where(eq(coordinatorOwnership.id, previous.id));
      }

      return { previous: previous ?? null, current: next };
    },
    db,
  );
}

/** The full ownership history for a student, most recent first, across all roles. */
export async function getOwnershipHistory(
  studentId: string,
  db: Database = getDb(),
): Promise<CoordinatorOwnership[]> {
  return db
    .select()
    .from(coordinatorOwnership)
    .where(eq(coordinatorOwnership.studentId, studentId))
    .orderBy(coordinatorOwnership.validFrom);
}

/** The live owner for a student in a specific role, or null if unassigned. */
export async function getCurrentOwner(
  studentId: string,
  ownershipRole: OwnershipRole,
  db: Database = getDb(),
): Promise<CoordinatorOwnership | null> {
  const [row] = await db
    .select()
    .from(coordinatorOwnership)
    .where(
      and(
        eq(coordinatorOwnership.studentId, studentId),
        eq(coordinatorOwnership.ownershipRole, ownershipRole),
        eq(coordinatorOwnership.isCurrent, true),
      ),
    );
  return row ?? null;
}
