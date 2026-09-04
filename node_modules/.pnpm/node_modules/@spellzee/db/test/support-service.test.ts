/**
 * Service-layer tests for the ticket/SLA workflow -- createTicket() spins up
 * an sla_instance from a named sla_policy, resolveTicket() closes both,
 * checkSlaBreaches() is the batch-job side (warn/breach transitions).
 * Written FIRST per the TDD mandate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from '../src/migrate.js';
import * as schema from '../src/schema/index.js';
import {
  createTicket,
  resolveTicket,
  checkSlaBreaches,
  SlaPolicyNotFoundError,
  TicketNotOpenError,
  type ActorContext,
} from '../src/index.js';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';
const ctx: ActorContext = { actorId: SYSTEM_ACTOR, source: 'api' };

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let fixtureCounter = 0;

async function asActor<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.actor_id', $1, true)`, [SYSTEM_ACTOR]);
    await client.query(`SELECT set_config('app.source', 'api', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedStudent() {
  const suffix = `${Date.now()}-${++fixtureCounter}`;
  const { rows } = await asActor((c) =>
    c.query(`INSERT INTO student (full_name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`, [
      `Student ${suffix}`,
      SYSTEM_ACTOR,
    ]),
  );
  return rows[0].id as string;
}

async function seedSlaPolicy(policyCode: string, warnHours = 36, breachHours = 48) {
  await asActor((c) =>
    c.query(
      `INSERT INTO sla_policy (entity_type, policy_code, warn_hours, breach_hours, created_by, updated_by)
       VALUES ('ticket', $1, $2, $3, $4, $4)`,
      [policyCode, warnHours, breachHours, SYSTEM_ACTOR],
    ),
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env['DATABASE_URL'] = container.getConnectionUri();
  await migrate(container.getConnectionUri());
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/* -------------------------------------------------------------------------- */

describe('createTicket', () => {
  it('REJECTS when the named sla_policy does not exist', async () => {
    const studentId = await seedStudent();
    await expect(
      createTicket(
        ctx,
        {
          entityType: 'student',
          entityId: studentId,
          category: 'technical',
          subject: 'x',
          description: 'x',
          slaPolicyCode: 'does_not_exist',
        },
        db,
      ),
    ).rejects.toThrow(SlaPolicyNotFoundError);
  });

  it('creates a ticket and an active sla_instance from the named policy', async () => {
    await seedSlaPolicy('ticket_default_sla_1');
    const studentId = await seedStudent();
    const result = await createTicket(
      ctx,
      {
        entityType: 'student',
        entityId: studentId,
        category: 'technical',
        subject: 'Cannot join class',
        description: 'x',
        slaPolicyCode: 'ticket_default_sla_1',
      },
      db,
    );
    expect(result.ticket.status).toBe('open');
    expect(result.slaInstance.status).toBe('active');
    const warnHoursFromStart =
      (result.slaInstance.warnAt.getTime() - result.slaInstance.startedAt.getTime()) / (1000 * 60 * 60);
    expect(warnHoursFromStart).toBeCloseTo(36, 1);
  });
});

describe('resolveTicket', () => {
  it('resolves the ticket and its sla_instance together', async () => {
    await seedSlaPolicy('ticket_default_sla_2');
    const studentId = await seedStudent();
    const created = await createTicket(
      ctx,
      {
        entityType: 'student',
        entityId: studentId,
        category: 'technical',
        subject: 'x',
        description: 'x',
        slaPolicyCode: 'ticket_default_sla_2',
      },
      db,
    );

    const result = await resolveTicket(ctx, { ticketId: created.ticket.id, resolutionNotes: 'fixed' }, db);
    expect(result.ticket.status).toBe('resolved');
    expect(result.ticket.resolvedAt).toBeTruthy();
    expect(result.slaInstance?.status).toBe('resolved');
  });

  it('REJECTS resolving an already-resolved ticket', async () => {
    await seedSlaPolicy('ticket_default_sla_3');
    const studentId = await seedStudent();
    const created = await createTicket(
      ctx,
      {
        entityType: 'student',
        entityId: studentId,
        category: 'technical',
        subject: 'x',
        description: 'x',
        slaPolicyCode: 'ticket_default_sla_3',
      },
      db,
    );
    await resolveTicket(ctx, { ticketId: created.ticket.id }, db);

    await expect(resolveTicket(ctx, { ticketId: created.ticket.id }, db)).rejects.toThrow(TicketNotOpenError);
  });
});

describe('checkSlaBreaches', () => {
  it('marks an overdue active instance as warned, and a further-overdue one as breached', async () => {
    await seedSlaPolicy('ticket_default_sla_4');
    const studentId = await seedStudent();
    const created = await createTicket(
      ctx,
      {
        entityType: 'student',
        entityId: studentId,
        category: 'technical',
        subject: 'x',
        description: 'x',
        slaPolicyCode: 'ticket_default_sla_4',
      },
      db,
    );
    // Force the warn threshold into the past -- started_at must move back
    // with it, or sla_instance_warn_after_start rejects the row.
    await asActor((c) =>
      c.query(
        `UPDATE sla_instance SET started_at = now() - interval '2 hours', warn_at = now() - interval '1 hour'
         WHERE id = $1`,
        [created.slaInstance.id],
      ),
    );

    const result = await checkSlaBreaches(ctx, db);
    expect(result.warned.map((i) => i.id)).toContain(created.slaInstance.id);

    // Now force breach threshold into the past too.
    await asActor((c) =>
      c.query(`UPDATE sla_instance SET breach_at = now() - interval '30 minutes' WHERE id = $1`, [
        created.slaInstance.id,
      ]),
    );
    const result2 = await checkSlaBreaches(ctx, db);
    expect(result2.breached.map((i) => i.id)).toContain(created.slaInstance.id);

    const { rows } = await pool.query(`SELECT status FROM sla_instance WHERE id = $1`, [created.slaInstance.id]);
    expect(rows[0].status).toBe('breached');
  });

  it('does not touch an instance that is not yet due', async () => {
    await seedSlaPolicy('ticket_default_sla_5');
    const studentId = await seedStudent();
    const created = await createTicket(
      ctx,
      {
        entityType: 'student',
        entityId: studentId,
        category: 'technical',
        subject: 'x',
        description: 'x',
        slaPolicyCode: 'ticket_default_sla_5',
      },
      db,
    );

    const result = await checkSlaBreaches(ctx, db);
    expect(result.warned.map((i) => i.id)).not.toContain(created.slaInstance.id);
    expect(result.breached.map((i) => i.id)).not.toContain(created.slaInstance.id);
  });
});
