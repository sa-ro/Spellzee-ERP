/**
 * Integration tests for ticket, sla_policy, sla_instance -- CLAUDE.md §4
 * accepted default: "Ticket SLA 48h, warn 36h, escalate to Team Lead on
 * breach." Written FIRST per the TDD mandate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let fixtureCounter = 0;

async function asActor<T>(fn: (c: pg.PoolClient) => Promise<T>, actor = SYSTEM_ACTOR): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.actor_id', $1, true)`, [actor]);
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

async function seedSlaPolicy() {
  const suffix = `${Date.now()}-${++fixtureCounter}`;
  const { rows } = await asActor((c) =>
    c.query(
      `INSERT INTO sla_policy (entity_type, policy_code, warn_hours, breach_hours, created_by, updated_by)
       VALUES ('ticket', $1, 36, 48, $2, $2) RETURNING id`,
      [`ticket_default_sla-${suffix}`, SYSTEM_ACTOR],
    ),
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env['DATABASE_URL'] = container.getConnectionUri();
  await migrate(container.getConnectionUri());
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/* -------------------------------------------------------------------------- */

describe('ticket', () => {
  it('issues ticket ids in the TKT-YYYY-NNNNNN format', async () => {
    const studentId = await seedStudent();
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO ticket (entity_type, entity_id, category, subject, description, raised_by, created_by, updated_by)
         VALUES ('student', $1, 'technical', 'subject', 'description', $2, $2, $2) RETURNING public_id`,
        [studentId, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].public_id).toMatch(/^TKT-\d{4}-\d{6}$/);
  });

  it('REJECTS an invalid priority', async () => {
    const studentId = await seedStudent();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO ticket (entity_type, entity_id, category, subject, description, priority, raised_by, created_by, updated_by)
           VALUES ('student', $1, 'technical', 'subject', 'description', 'vibes', $2, $2, $2)`,
          [studentId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a resolved ticket with no resolved_at', async () => {
    const studentId = await seedStudent();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO ticket (entity_type, entity_id, category, subject, description, status, raised_by, created_by, updated_by)
           VALUES ('student', $1, 'technical', 'subject', 'description', 'resolved', $2, $2, $2)`,
          [studentId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete a ticket', async () => {
    const studentId = await seedStudent();
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO ticket (entity_type, entity_id, category, subject, description, raised_by, created_by, updated_by)
         VALUES ('student', $1, 'technical', 'subject', 'description', $2, $2, $2) RETURNING id`,
        [studentId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM ticket WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });
});

describe('sla_policy', () => {
  it('REJECTS warn_hours >= breach_hours (warn must come before breach)', async () => {
    const suffix = `${Date.now()}-${++fixtureCounter}`;
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO sla_policy (entity_type, policy_code, warn_hours, breach_hours, created_by, updated_by)
           VALUES ('ticket', $1, 48, 36, $2, $2)`,
          [`bad-${suffix}`, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a duplicate policy_code', async () => {
    const suffix = `${Date.now()}-${++fixtureCounter}`;
    await asActor((c) =>
      c.query(
        `INSERT INTO sla_policy (entity_type, policy_code, warn_hours, breach_hours, created_by, updated_by)
         VALUES ('ticket', $1, 36, 48, $2, $2)`,
        [`dup-${suffix}`, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO sla_policy (entity_type, policy_code, warn_hours, breach_hours, created_by, updated_by)
           VALUES ('ticket', $1, 36, 48, $2, $2)`,
          [`dup-${suffix}`, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('sla_instance', () => {
  it('creates an active instance against a ticket', async () => {
    const studentId = await seedStudent();
    const policyId = await seedSlaPolicy();
    const ticket = await asActor((c) =>
      c.query(
        `INSERT INTO ticket (entity_type, entity_id, category, subject, description, raised_by, created_by, updated_by)
         VALUES ('student', $1, 'technical', 'subject', 'description', $2, $2, $2) RETURNING id`,
        [studentId, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO sla_instance (sla_policy_id, entity_type, entity_id, warn_at, breach_at, created_by, updated_by)
         VALUES ($1, 'ticket', $2, now() + interval '36 hours', now() + interval '48 hours', $3, $3)
         RETURNING status`,
        [policyId, ticket.rows[0].id, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].status).toBe('active');
  });

  it('REJECTS an invalid status', async () => {
    const studentId = await seedStudent();
    const policyId = await seedSlaPolicy();
    const ticket = await asActor((c) =>
      c.query(
        `INSERT INTO ticket (entity_type, entity_id, category, subject, description, raised_by, created_by, updated_by)
         VALUES ('student', $1, 'technical', 'subject', 'description', $2, $2, $2) RETURNING id`,
        [studentId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO sla_instance (sla_policy_id, entity_type, entity_id, status, warn_at, breach_at, created_by, updated_by)
           VALUES ($1, 'ticket', $2, 'vibes', now() + interval '36 hours', now() + interval '48 hours', $3, $3)`,
          [policyId, ticket.rows[0].id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a second active instance for the same entity', async () => {
    const studentId = await seedStudent();
    const policyId = await seedSlaPolicy();
    const ticket = await asActor((c) =>
      c.query(
        `INSERT INTO ticket (entity_type, entity_id, category, subject, description, raised_by, created_by, updated_by)
         VALUES ('student', $1, 'technical', 'subject', 'description', $2, $2, $2) RETURNING id`,
        [studentId, SYSTEM_ACTOR],
      ),
    );
    await asActor((c) =>
      c.query(
        `INSERT INTO sla_instance (sla_policy_id, entity_type, entity_id, warn_at, breach_at, created_by, updated_by)
         VALUES ($1, 'ticket', $2, now() + interval '36 hours', now() + interval '48 hours', $3, $3)`,
        [policyId, ticket.rows[0].id, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO sla_instance (sla_policy_id, entity_type, entity_id, warn_at, breach_at, created_by, updated_by)
           VALUES ($1, 'ticket', $2, now() + interval '36 hours', now() + interval '48 hours', $3, $3)`,
          [policyId, ticket.rows[0].id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete an sla_instance', async () => {
    const studentId = await seedStudent();
    const policyId = await seedSlaPolicy();
    const ticket = await asActor((c) =>
      c.query(
        `INSERT INTO ticket (entity_type, entity_id, category, subject, description, raised_by, created_by, updated_by)
         VALUES ('student', $1, 'technical', 'subject', 'description', $2, $2, $2) RETURNING id`,
        [studentId, SYSTEM_ACTOR],
      ),
    );
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO sla_instance (sla_policy_id, entity_type, entity_id, warn_at, breach_at, created_by, updated_by)
         VALUES ($1, 'ticket', $2, now() + interval '36 hours', now() + interval '48 hours', $3, $3) RETURNING id`,
        [policyId, ticket.rows[0].id, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM sla_instance WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });
});
