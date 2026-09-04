/**
 * Compensation workflow — rule 18, rule 19.
 *
 * "A compensation session is a separate, additional session linked to the
 * original affected session. It MUST NOT modify or reschedule the original
 * recurring schedule." (rule 18) "Teacher absence or verified teacher/
 * Spellzee-side failure generally protects the student's entitlement and
 * triggers compensation." (rule 19)
 *
 * createCompensation() is the WORKFLOW, not CRUD, inside one transaction:
 *   1. The original session must exist and carry a compensation-qualifying
 *      outcome (COMPENSATION_QUALIFYING_OUTCOMES) — checked here so the
 *      caller gets a clean domain error rather than a raw FK/constraint
 *      failure.
 *   2. At most one compensation record per original session — checked here
 *      (also backstopped by compensation_original_session_uq).
 *   3. compensation_validity_days is read LIVE from policy_parameter (rule
 *      28 — never hard-coded); a missing policy row is a visible error, not
 *      a silently-assumed default.
 *   4. A NEW session row is inserted — session_purpose='compensation',
 *      reusing the ORIGINAL session's class_schedule_id as a plain FK
 *      reference. class_schedule itself is never UPDATEd (rule 18's core
 *      guarantee — proven by a test asserting class_schedule.updated_at is
 *      unchanged).
 *   5. A 'protected' session_credit_ledger entry (+1) is recorded against the
 *      original session, restoring the entitlement the missed session would
 *      otherwise have consumed.
 *   6. The `compensation` row links original ↔ new session ↔ ledger entry.
 *
 * completeCompensation() closes the loop when the compensation session is
 * actually delivered: marks the compensation session and record 'completed',
 * and records a 'compensated' (-1) ledger entry — the debit that, together
 * with createCompensation()'s earlier 'protected' (+1) entry, nets to zero
 * over a fully-delivered compensation cycle (the student never actually lost
 * a session).
 *
 * expireCompensations() is the batch-job side: scheduled compensations past
 * their validity_deadline are marked 'expired'. Deliberately does NOT touch
 * the ledger — the 'protected' credit stays exactly as it was, visible and
 * available, rather than being silently consumed just because the
 * compensation slot lapsed (rule 17: "a missed session is never silently
 * forgiven" — that applies here too: the credit's fate on expiry is a
 * decision for a coordinator, not something this function decides silently).
 *
 * Explicitly NOT built here (out of scope for this batch):
 *   - Student-side technical failure / goodwill-exception handling (rule 19's
 *     other half) and cancellation-cutoff-driven protection — both use
 *     different session.outcome values that do not qualify for compensation
 *     under this function (see reschedule.service.ts for the cutoff path).
 */

import { and, eq, lt } from 'drizzle-orm';
import type { ActorContext, Database, Transaction } from '../client.js';
import { getDb, withActor } from '../client.js';
import {
  session,
  classSchedule,
  COMPENSATION_QUALIFYING_OUTCOMES,
  type Session,
} from '../schema/operations.js';
import { compensation, type Compensation } from '../schema/compensation.js';
import { sessionCreditLedger, type SessionCreditLedgerEntry } from '../schema/entitlement.js';
import { policyParameter } from '../schema/platform.js';

export class CompensationError extends Error {}

/** Thrown when the original session's outcome does not qualify for compensation (rule 19). */
export class SessionNotQualifiedError extends CompensationError {
  constructor(public readonly sessionId: string, public readonly outcome: string | null) {
    super(
      `Session ${sessionId} has outcome "${outcome ?? 'null'}", which does not qualify for ` +
        `compensation (rule 19). Qualifying outcomes: ${COMPENSATION_QUALIFYING_OUTCOMES.join(', ')}.`,
    );
  }
}

/** Thrown when a compensation record already exists for this original session. */
export class DuplicateCompensationError extends CompensationError {
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} already has a compensation record — at most one is allowed.`);
  }
}

/** Thrown when completeCompensation() is called on a record not in 'scheduled' status. */
export class CompensationNotScheduledError extends CompensationError {
  constructor(public readonly compensationId: string, public readonly status: string) {
    super(`Compensation ${compensationId} has status "${status}", not "scheduled" — cannot complete it.`);
  }
}

/** Thrown when compensation_validity_days has no current policy_parameter row (rule 28). */
export class MissingPolicyParameterError extends CompensationError {
  constructor(public readonly key: string) {
    super(
      `No current policy_parameter row for key "${key}". Compensation cannot proceed with a ` +
        'hard-coded fallback (rule 28) — seed the policy row first.',
    );
  }
}

const COMPENSATION_VALIDITY_POLICY_KEY = 'compensation_validity_days';

export interface CreateCompensationInput {
  originalSessionId: string;
  subscriptionId: string;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  reason: string;
}

export interface CompensationResult {
  compensation: Compensation;
  compensationSession: Session;
  ledgerEntry: SessionCreditLedgerEntry;
}

async function loadCompensationValidityDays(tx: Transaction): Promise<number> {
  const [current] = await tx
    .select()
    .from(policyParameter)
    .where(
      and(
        eq(policyParameter.key, COMPENSATION_VALIDITY_POLICY_KEY),
        eq(policyParameter.isCurrent, true),
      ),
    );

  if (!current) {
    throw new MissingPolicyParameterError(COMPENSATION_VALIDITY_POLICY_KEY);
  }
  const liveRow = current;

  const days = Number(liveRow.value);
  if (!Number.isFinite(days) || days <= 0) {
    throw new CompensationError(
      `policy_parameter "${COMPENSATION_VALIDITY_POLICY_KEY}" has a non-numeric or non-positive value.`,
    );
  }
  return days;
}

/**
 * Creates a compensation session for a session whose outcome qualifies under
 * rule 19, linking it to the original via a `compensation` row and recording
 * a 'protected' ledger entry — all inside one transaction, and without ever
 * touching class_schedule (rule 18).
 */
export async function createCompensation(
  ctx: ActorContext,
  input: CreateCompensationInput,
  db: Database = getDb(),
): Promise<CompensationResult> {
  return withActor(
    { ...ctx, reason: input.reason },
    async (tx) => {
      const [original] = await tx.select().from(session).where(eq(session.id, input.originalSessionId));
      if (!original) {
        throw new CompensationError(`Session ${input.originalSessionId} not found.`);
      }

      if (
        !original.outcome ||
        !COMPENSATION_QUALIFYING_OUTCOMES.includes(original.outcome)
      ) {
        throw new SessionNotQualifiedError(original.id, original.outcome);
      }

      const [existing] = await tx
        .select()
        .from(compensation)
        .where(eq(compensation.originalSessionId, input.originalSessionId));
      if (existing) {
        throw new DuplicateCompensationError(input.originalSessionId);
      }

      const validityDays = await loadCompensationValidityDays(tx);

      // --- New, additional session. class_schedule is referenced, never written. ---
      const [compensationSession] = await tx
        .insert(session)
        .values({
          classScheduleId: original.classScheduleId,
          enrollmentId: original.enrollmentId,
          studentId: original.studentId,
          teacherId: original.teacherId,
          scheduledStartAt: input.scheduledStartAt,
          scheduledEndAt: input.scheduledEndAt,
          sessionPurpose: 'compensation',
          status: 'scheduled',
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();

      if (!compensationSession) {
        throw new CompensationError('Failed to insert the compensation session.');
      }

      // --- Restore the entitlement the missed session would have consumed. ---
      const [ledgerEntry] = await tx
        .insert(sessionCreditLedger)
        .values({
          subscriptionId: input.subscriptionId,
          entryType: 'protected',
          amount: 1,
          reasonCode: original.outcome,
          sessionId: original.id,
          createdBy: ctx.actorId,
        })
        .returning();

      if (!ledgerEntry) {
        throw new CompensationError('Failed to insert the session_credit_ledger entry.');
      }

      const validityDeadline = new Date();
      validityDeadline.setDate(validityDeadline.getDate() + validityDays);
      const validityDeadlineStr = validityDeadline.toISOString().slice(0, 10);

      const [compensationRecord] = await tx
        .insert(compensation)
        .values({
          originalSessionId: original.id,
          compensationSessionId: compensationSession.id,
          subscriptionId: input.subscriptionId,
          reasonCode: original.outcome,
          validityDeadline: validityDeadlineStr,
          protectedLedgerEntryId: ledgerEntry.id,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();

      if (!compensationRecord) {
        throw new CompensationError('Failed to insert the compensation record.');
      }

      return {
        compensation: compensationRecord,
        compensationSession,
        ledgerEntry,
      };
    },
    db,
  );
}

/* -------------------------------------------------------------------------- */
/* completeCompensation — closes the loop on a delivered compensation session */
/* -------------------------------------------------------------------------- */

export interface CompleteCompensationInput {
  compensationId: string;
}

export interface CompleteCompensationResult {
  compensation: Compensation;
  compensationSession: Session;
  ledgerEntry: SessionCreditLedgerEntry;
}

export async function completeCompensation(
  ctx: ActorContext,
  input: CompleteCompensationInput,
  db: Database = getDb(),
): Promise<CompleteCompensationResult> {
  return withActor(
    { ...ctx, reason: 'Compensation session delivered' },
    async (tx) => {
      const [record] = await tx.select().from(compensation).where(eq(compensation.id, input.compensationId));
      if (!record) {
        throw new CompensationError(`Compensation ${input.compensationId} not found.`);
      }
      if (record.status !== 'scheduled') {
        throw new CompensationNotScheduledError(record.id, record.status);
      }

      const [updatedSession] = await tx
        .update(session)
        .set({ status: 'completed', outcome: 'completed', updatedBy: ctx.actorId })
        .where(eq(session.id, record.compensationSessionId))
        .returning();
      if (!updatedSession) {
        throw new CompensationError('Failed to update the compensation session.');
      }

      const [ledgerEntry] = await tx
        .insert(sessionCreditLedger)
        .values({
          subscriptionId: record.subscriptionId,
          entryType: 'compensated',
          amount: -1,
          reasonCode: 'compensation_delivered',
          sessionId: record.compensationSessionId,
          createdBy: ctx.actorId,
        })
        .returning();
      if (!ledgerEntry) {
        throw new CompensationError('Failed to insert the compensated ledger entry.');
      }

      const [updatedRecord] = await tx
        .update(compensation)
        .set({ status: 'completed', updatedBy: ctx.actorId })
        .where(eq(compensation.id, record.id))
        .returning();
      if (!updatedRecord) {
        throw new CompensationError('Failed to update the compensation record.');
      }

      return { compensation: updatedRecord, compensationSession: updatedSession, ledgerEntry };
    },
    db,
  );
}

/* -------------------------------------------------------------------------- */
/* expireCompensations — batch job: flag overdue, unfulfilled compensations   */
/* -------------------------------------------------------------------------- */

/**
 * Marks every 'scheduled' compensation past its validity_deadline as
 * 'expired'. Ledger-neutral by design (see module header) — the protected
 * credit is left exactly as it was; a coordinator decides what happens next,
 * this function only makes the lapse visible.
 */
export async function expireCompensations(
  ctx: ActorContext,
  db: Database = getDb(),
): Promise<Compensation[]> {
  return withActor(
    { ...ctx, reason: 'Compensation validity deadline passed', source: ctx.source ?? 'job' },
    async (tx) => {
      const todayStr = new Date().toISOString().slice(0, 10);
      const overdue = await tx
        .select()
        .from(compensation)
        .where(and(eq(compensation.status, 'scheduled'), lt(compensation.validityDeadline, todayStr)));

      const expired: Compensation[] = [];
      for (const row of overdue) {
        const [updated] = await tx
          .update(compensation)
          .set({ status: 'expired', updatedBy: ctx.actorId })
          .where(eq(compensation.id, row.id))
          .returning();
        if (updated) expired.push(updated);
      }
      return expired;
    },
    db,
  );
}
