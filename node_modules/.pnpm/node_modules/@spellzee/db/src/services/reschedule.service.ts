/**
 * Reschedule workflow — the cancellation-cutoff policy (CLAUDE.md §4 accepted
 * defaults: 24h, outside cutoff = protected, inside = consumed) and the
 * max-reschedules-per-subscription policy, both read live from
 * policy_parameter (rule 28).
 *
 * createReschedule() is the WORKFLOW, inside one transaction:
 *   1. The session must exist and be in a reschedulable status (not already
 *      completed/cancelled/rescheduled).
 *   2. max_reschedules_per_subscription is read live and enforced by counting
 *      existing 'fulfilled' reschedule_request rows for the subscription —
 *      not a DB CHECK, since it requires an aggregate over other rows.
 *   3. cancellation_cutoff_hours is read live; whether `now()` falls inside
 *      or outside that many hours before the ORIGINAL session's
 *      scheduled_start_at decides the ledger consequence.
 *   4. A NEW session row is inserted (session_purpose='replacement') — the
 *      original session's scheduled_start_at/end_at are never edited in
 *      place (rule 11); instead the original is marked
 *      status='rescheduled' with rescheduled_to_session_id pointing at the
 *      new row.
 *   5. A signed session_credit_ledger entry records the consequence:
 *      'protected' (+1) outside the cutoff, 'consumed' (-1) inside it.
 *   6. The reschedule_request row is inserted with status='fulfilled',
 *      linking the two sessions and recording which side of the cutoff this
 *      fell on.
 *
 * Explicitly NOT built here: an approval workflow before fulfillment (every
 * call to this function fulfills immediately) — Master §22.4 does not list
 * reschedule as requiring maker-checker, so `status` starts and ends at
 * 'fulfilled' rather than passing through 'pending'/'approved'. The
 * pending/approved values remain in the CHECK constraint for a future batch
 * that adds an approval gate, but nothing here writes them.
 */

import { and, count, eq } from 'drizzle-orm';
import type { ActorContext, Database, Transaction } from '../client.js';
import { getDb, withActor } from '../client.js';
import { session, type Session } from '../schema/operations.js';
import { sessionCreditLedger, type SessionCreditLedgerEntry } from '../schema/entitlement.js';
import { policyParameter } from '../schema/platform.js';
import {
  rescheduleRequest,
  type RescheduleRequest,
  type CutoffStatus,
} from '../schema/reschedule.js';
// Reused rather than redefined — both services need the identical "no
// current policy_parameter row for this key" failure mode (rule 28), and two
// classes with the same name would collide when re-exported from index.ts.
import { MissingPolicyParameterError } from './compensation.service.js';

export { MissingPolicyParameterError };

export class RescheduleError extends Error {}

export class SessionNotReschedulableError extends RescheduleError {
  constructor(public readonly sessionId: string, public readonly status: string) {
    super(`Session ${sessionId} has status "${status}" and cannot be rescheduled.`);
  }
}

export class MaxReschedulesExceededError extends RescheduleError {
  constructor(public readonly subscriptionId: string, public readonly max: number) {
    super(`Subscription ${subscriptionId} has already reached the max of ${max} reschedules.`);
  }
}

const CANCELLATION_CUTOFF_KEY = 'cancellation_cutoff_hours';
const MAX_RESCHEDULES_KEY = 'max_reschedules_per_subscription';

const RESCHEDULABLE_STATUSES = ['scheduled', 'reminder_sent', 'confirmed'];

async function loadPolicyNumber(tx: Transaction, key: string): Promise<number> {
  const [row] = await tx
    .select()
    .from(policyParameter)
    .where(and(eq(policyParameter.key, key), eq(policyParameter.isCurrent, true)));

  if (!row) {
    throw new MissingPolicyParameterError(key);
  }
  const value = Number(row.value);
  if (!Number.isFinite(value)) {
    throw new RescheduleError(`policy_parameter "${key}" has a non-numeric value.`);
  }
  return value;
}

export interface CreateRescheduleInput {
  sessionId: string;
  subscriptionId: string;
  newScheduledStartAt: Date;
  newScheduledEndAt: Date;
  reason: string;
}

export interface RescheduleResult {
  request: RescheduleRequest;
  newSession: Session;
  ledgerEntry: SessionCreditLedgerEntry;
}

export async function createReschedule(
  ctx: ActorContext,
  input: CreateRescheduleInput,
  db: Database = getDb(),
): Promise<RescheduleResult> {
  return withActor(
    { ...ctx, reason: input.reason },
    async (tx) => {
      const [original] = await tx.select().from(session).where(eq(session.id, input.sessionId));
      if (!original) {
        throw new RescheduleError(`Session ${input.sessionId} not found.`);
      }
      if (!RESCHEDULABLE_STATUSES.includes(original.status)) {
        throw new SessionNotReschedulableError(original.id, original.status);
      }

      // --- Policy reads, live, before any write (rule 28). Cutoff first: a
      // missing cutoff row must fail before max-reschedules is even
      // attempted (proven by the "no policy row" test, which seeds neither). ---
      const cutoffHours = await loadPolicyNumber(tx, CANCELLATION_CUTOFF_KEY);
      const maxReschedules = await loadPolicyNumber(tx, MAX_RESCHEDULES_KEY);

      const fulfilledCount = await tx
        .select({ value: count() })
        .from(rescheduleRequest)
        .where(
          and(
            eq(rescheduleRequest.subscriptionId, input.subscriptionId),
            eq(rescheduleRequest.status, 'fulfilled'),
          ),
        );
      if ((fulfilledCount[0]?.value ?? 0) >= maxReschedules) {
        throw new MaxReschedulesExceededError(input.subscriptionId, maxReschedules);
      }

      // --- Cutoff determination. ---
      const hoursUntilOriginal =
        (original.scheduledStartAt.getTime() - Date.now()) / (1000 * 60 * 60);
      const cutoffStatus: CutoffStatus =
        hoursUntilOriginal >= cutoffHours ? 'outside_cutoff' : 'inside_cutoff';

      // --- New session (rule 11: original's schedule fields are never edited in place). ---
      const [newSession] = await tx
        .insert(session)
        .values({
          classScheduleId: original.classScheduleId,
          enrollmentId: original.enrollmentId,
          studentId: original.studentId,
          teacherId: original.teacherId,
          scheduledStartAt: input.newScheduledStartAt,
          scheduledEndAt: input.newScheduledEndAt,
          sessionPurpose: 'replacement',
          status: 'scheduled',
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();
      if (!newSession) {
        throw new RescheduleError('Failed to insert the replacement session.');
      }

      await tx
        .update(session)
        .set({ status: 'rescheduled', rescheduledToSessionId: newSession.id })
        .where(eq(session.id, original.id));

      // --- Ledger consequence. ---
      const [ledgerEntry] = await tx
        .insert(sessionCreditLedger)
        .values({
          subscriptionId: input.subscriptionId,
          entryType: cutoffStatus === 'outside_cutoff' ? 'protected' : 'consumed',
          amount: cutoffStatus === 'outside_cutoff' ? 1 : -1,
          reasonCode: cutoffStatus,
          sessionId: original.id,
          createdBy: ctx.actorId,
        })
        .returning();
      if (!ledgerEntry) {
        throw new RescheduleError('Failed to insert the session_credit_ledger entry.');
      }

      const [request] = await tx
        .insert(rescheduleRequest)
        .values({
          sessionId: original.id,
          newSessionId: newSession.id,
          subscriptionId: input.subscriptionId,
          requestedNewStartAt: input.newScheduledStartAt,
          requestedNewEndAt: input.newScheduledEndAt,
          cutoffStatus,
          status: 'fulfilled',
          reason: input.reason,
          requestedBy: ctx.actorId,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();
      if (!request) {
        throw new RescheduleError('Failed to insert the reschedule_request record.');
      }

      return { request, newSession, ledgerEntry };
    },
    db,
  );
}
