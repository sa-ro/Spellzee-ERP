/**
 * Ticket / SLA workflow. createTicket() spins up an sla_instance from a
 * NAMED sla_policy row (not policy_parameter — SLA definitions are their own
 * dedicated entity per DD, distinct from the general configurable-policy
 * table). resolveTicket() closes both together. checkSlaBreaches() is the
 * batch-job side that transitions active -> warned -> breached as their
 * clocks run out — intended to be called on a schedule (BullMQ), not
 * per-request.
 */

import { and, eq, lte } from 'drizzle-orm';
import type { ActorContext, Database, Transaction } from '../client.js';
import { getDb, withActor } from '../client.js';
import {
  ticket,
  slaPolicy,
  slaInstance,
  type Ticket,
  type SlaInstance,
  type TicketPriority,
} from '../schema/support.js';

export class SupportError extends Error {}

export class SlaPolicyNotFoundError extends SupportError {
  constructor(public readonly policyCode: string) {
    super(`No active sla_policy found with policy_code "${policyCode}".`);
  }
}

export class TicketNotOpenError extends SupportError {
  constructor(public readonly ticketId: string, public readonly status: string) {
    super(`Ticket ${ticketId} has status "${status}" — cannot resolve it.`);
  }
}

async function loadActiveSlaPolicy(tx: Transaction, policyCode: string) {
  const [policy] = await tx
    .select()
    .from(slaPolicy)
    .where(and(eq(slaPolicy.policyCode, policyCode), eq(slaPolicy.isActive, true)));
  if (!policy) {
    throw new SlaPolicyNotFoundError(policyCode);
  }
  return policy;
}

/* -------------------------------------------------------------------------- */
/* createTicket                                                               */
/* -------------------------------------------------------------------------- */

export interface CreateTicketInput {
  entityType: string;
  entityId: string;
  category: string;
  subject: string;
  description: string;
  priority?: TicketPriority;
  slaPolicyCode: string;
}

export interface CreateTicketResult {
  ticket: Ticket;
  slaInstance: SlaInstance;
}

export async function createTicket(
  ctx: ActorContext,
  input: CreateTicketInput,
  db: Database = getDb(),
): Promise<CreateTicketResult> {
  return withActor(
    ctx,
    async (tx) => {
      const policy = await loadActiveSlaPolicy(tx, input.slaPolicyCode);

      const [newTicket] = await tx
        .insert(ticket)
        .values({
          entityType: input.entityType,
          entityId: input.entityId,
          category: input.category,
          subject: input.subject,
          description: input.description,
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          raisedBy: ctx.actorId,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();
      if (!newTicket) {
        throw new SupportError('Failed to insert the ticket.');
      }

      const startedAt = new Date();
      const warnAt = new Date(startedAt.getTime() + policy.warnHours * 60 * 60 * 1000);
      const breachAt = new Date(startedAt.getTime() + policy.breachHours * 60 * 60 * 1000);

      const [newInstance] = await tx
        .insert(slaInstance)
        .values({
          slaPolicyId: policy.id,
          entityType: 'ticket',
          entityId: newTicket.id,
          startedAt,
          warnAt,
          breachAt,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();
      if (!newInstance) {
        throw new SupportError('Failed to insert the sla_instance.');
      }

      return { ticket: newTicket, slaInstance: newInstance };
    },
    db,
  );
}

/* -------------------------------------------------------------------------- */
/* resolveTicket                                                              */
/* -------------------------------------------------------------------------- */

export interface ResolveTicketInput {
  ticketId: string;
  resolutionNotes?: string;
}

export interface ResolveTicketResult {
  ticket: Ticket;
  slaInstance: SlaInstance | null;
}

export async function resolveTicket(
  ctx: ActorContext,
  input: ResolveTicketInput,
  db: Database = getDb(),
): Promise<ResolveTicketResult> {
  return withActor(
    ctx,
    async (tx) => {
      const [record] = await tx.select().from(ticket).where(eq(ticket.id, input.ticketId));
      if (!record) {
        throw new SupportError(`Ticket ${input.ticketId} not found.`);
      }
      if (!['open', 'in_progress', 'reopened'].includes(record.status)) {
        throw new TicketNotOpenError(record.id, record.status);
      }

      const [updatedTicket] = await tx
        .update(ticket)
        .set({
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNotes: input.resolutionNotes ?? null,
          updatedBy: ctx.actorId,
        })
        .where(eq(ticket.id, record.id))
        .returning();
      if (!updatedTicket) {
        throw new SupportError('Failed to update the ticket.');
      }

      const [activeInstance] = await tx
        .select()
        .from(slaInstance)
        .where(
          and(
            eq(slaInstance.entityType, 'ticket'),
            eq(slaInstance.entityId, record.id),
          ),
        );

      let updatedInstance: SlaInstance | null = null;
      if (activeInstance && ['active', 'warned'].includes(activeInstance.status)) {
        const [resolved] = await tx
          .update(slaInstance)
          .set({ status: 'resolved', resolvedAt: new Date(), updatedBy: ctx.actorId })
          .where(eq(slaInstance.id, activeInstance.id))
          .returning();
        updatedInstance = resolved ?? null;
      }

      return { ticket: updatedTicket, slaInstance: updatedInstance };
    },
    db,
  );
}

/* -------------------------------------------------------------------------- */
/* checkSlaBreaches — batch job                                               */
/* -------------------------------------------------------------------------- */

export interface CheckSlaBreachesResult {
  warned: SlaInstance[];
  breached: SlaInstance[];
}

export async function checkSlaBreaches(
  ctx: ActorContext,
  db: Database = getDb(),
): Promise<CheckSlaBreachesResult> {
  return withActor(
    { ...ctx, reason: 'SLA clock check', source: ctx.source ?? 'job' },
    async (tx) => {
      const now = new Date();

      const toBreach = await tx
        .select()
        .from(slaInstance)
        .where(
          and(
            eq(slaInstance.status, 'warned'),
            lte(slaInstance.breachAt, now),
          ),
        );
      const breached: SlaInstance[] = [];
      for (const row of toBreach) {
        const [updated] = await tx
          .update(slaInstance)
          .set({ status: 'breached', updatedBy: ctx.actorId })
          .where(eq(slaInstance.id, row.id))
          .returning();
        if (updated) breached.push(updated);
      }

      const toWarn = await tx
        .select()
        .from(slaInstance)
        .where(
          and(
            eq(slaInstance.status, 'active'),
            lte(slaInstance.warnAt, now),
          ),
        );
      const warned: SlaInstance[] = [];
      for (const row of toWarn) {
        const [updated] = await tx
          .update(slaInstance)
          .set({ status: 'warned', updatedBy: ctx.actorId })
          .where(eq(slaInstance.id, row.id))
          .returning();
        if (updated) warned.push(updated);
      }

      return { warned, breached };
    },
    db,
  );
}
