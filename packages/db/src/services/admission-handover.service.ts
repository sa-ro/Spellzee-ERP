/**
 * Admission handover workflow — Master §"admission-allocation SLA 24h (start:
 * handover receipt; stop: allocation confirmed)". The SLA hours value is read
 * LIVE from policy_parameter (rule 28), never hard-coded.
 */

import { and, eq } from 'drizzle-orm';
import type { ActorContext, Database, Transaction } from '../client.js';
import { getDb, withActor } from '../client.js';
import { admissionHandover, type AdmissionHandover } from '../schema/admission.js';
import { policyParameter } from '../schema/platform.js';
import { MissingPolicyParameterError } from './compensation.service.js';

export class AdmissionHandoverError extends Error {}

export class HandoverNotPendingError extends AdmissionHandoverError {
  constructor(public readonly handoverId: string, public readonly status: string) {
    super(`Handover ${handoverId} has status "${status}", not "pending".`);
  }
}

export { MissingPolicyParameterError };

const SLA_HOURS_KEY = 'admission_allocation_sla_hours';

async function loadSlaHours(tx: Transaction): Promise<number> {
  const [row] = await tx
    .select()
    .from(policyParameter)
    .where(and(eq(policyParameter.key, SLA_HOURS_KEY), eq(policyParameter.isCurrent, true)));
  if (!row) {
    throw new MissingPolicyParameterError(SLA_HOURS_KEY);
  }
  const value = Number(row.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AdmissionHandoverError(`policy_parameter "${SLA_HOURS_KEY}" has a non-positive value.`);
  }
  return value;
}

export interface CreateAdmissionHandoverInput {
  studentId: string;
  enrollmentId: string;
  handedOverBy: string;
  handoverNotes?: string;
}

export async function createAdmissionHandover(
  ctx: ActorContext,
  input: CreateAdmissionHandoverInput,
  db: Database = getDb(),
): Promise<AdmissionHandover> {
  return withActor(
    ctx,
    async (tx) => {
      const slaHours = await loadSlaHours(tx);
      const slaDeadlineAt = new Date(Date.now() + slaHours * 60 * 60 * 1000);

      const [record] = await tx
        .insert(admissionHandover)
        .values({
          studentId: input.studentId,
          enrollmentId: input.enrollmentId,
          handedOverBy: input.handedOverBy,
          handoverNotes: input.handoverNotes ?? null,
          slaDeadlineAt,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();
      if (!record) {
        throw new AdmissionHandoverError('Failed to insert the admission_handover record.');
      }
      return record;
    },
    db,
  );
}

export interface AcknowledgeHandoverInput {
  handoverId: string;
  receivedBy: string;
}

export async function acknowledgeHandover(
  ctx: ActorContext,
  input: AcknowledgeHandoverInput,
  db: Database = getDb(),
): Promise<AdmissionHandover> {
  return withActor(
    ctx,
    async (tx) => {
      const [record] = await tx
        .select()
        .from(admissionHandover)
        .where(eq(admissionHandover.id, input.handoverId));
      if (!record) {
        throw new AdmissionHandoverError(`Handover ${input.handoverId} not found.`);
      }
      if (record.status !== 'pending') {
        throw new HandoverNotPendingError(record.id, record.status);
      }

      const [updated] = await tx
        .update(admissionHandover)
        .set({
          status: 'acknowledged',
          receivedBy: input.receivedBy,
          acknowledgedAt: new Date(),
          updatedBy: ctx.actorId,
        })
        .where(eq(admissionHandover.id, record.id))
        .returning();
      if (!updated) {
        throw new AdmissionHandoverError('Failed to update the admission_handover record.');
      }
      return updated;
    },
    db,
  );
}
