/**
 * Integration tests for policy_parameter, outbox_event, notification -- the
 * layer-4 history mechanism (transactional outbox) plus the two tables that
 * depend on it, and the configurable-policy infrastructure rule 28 requires.
 *
 * Written FIRST per CLAUDE.md's TDD mandate: these must fail against the
 * current schema (tables don't exist yet) before the migration that creates
 * them is written.
 *
 * Sources: rule 28 (configurable policy, versioned decisions), CLAUDE.md §5
 * layer 4 (transactional outbox), rule 27 (integration failures visible/
 * retryable), Master §30 (open policy parameters).
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

describe('policy_parameter (rule 28)', () => {
  it('creates an engineering-default policy row', async () => {
    const key = `cancellation_cutoff_hours-${Date.now()}-${++fixtureCounter}`;
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO policy_parameter (key, value, description, created_by, updated_by)
         VALUES ($1, '24'::jsonb, 'test', $2, $2) RETURNING source, is_current`,
        [key, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].source).toBe('engineering_default');
    expect(rows[0].is_current).toBe(true);
  });

  it('REJECTS an invalid source value', async () => {
    const key = `bad-source-${Date.now()}-${++fixtureCounter}`;
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO policy_parameter (key, value, source, created_by, updated_by)
           VALUES ($1, '1'::jsonb, 'manager_said_so', $2, $2)`,
          [key, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS source=business_ratified with no ratified_at/ratified_by', async () => {
    const key = `unratified-${Date.now()}-${++fixtureCounter}`;
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO policy_parameter (key, value, source, created_by, updated_by)
           VALUES ($1, '1'::jsonb, 'business_ratified', $2, $2)`,
          [key, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('accepts source=business_ratified when ratified_at/ratified_by are set', async () => {
    const key = `ratified-${Date.now()}-${++fixtureCounter}`;
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO policy_parameter (key, value, source, ratified_at, ratified_by, created_by, updated_by)
         VALUES ($1, '1'::jsonb, 'business_ratified', now(), $2, $2, $2) RETURNING source`,
        [key, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].source).toBe('business_ratified');
  });

  it('REJECTS two simultaneous current rows for the same key', async () => {
    const key = `dup-current-${Date.now()}-${++fixtureCounter}`;
    await asActor((c) =>
      c.query(
        `INSERT INTO policy_parameter (key, value, created_by, updated_by) VALUES ($1, '1'::jsonb, $2, $2)`,
        [key, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO policy_parameter (key, value, created_by, updated_by) VALUES ($1, '2'::jsonb, $2, $2)`,
          [key, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete a policy_parameter row', async () => {
    const key = `no-delete-${Date.now()}-${++fixtureCounter}`;
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO policy_parameter (key, value, created_by, updated_by) VALUES ($1, '1'::jsonb, $2, $2) RETURNING id`,
        [key, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM policy_parameter WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });
});

describe('outbox_event (CLAUDE.md §5 layer 4, rule 27)', () => {
  it('defaults to pending status with zero attempts', async () => {
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload, created_by)
         VALUES ('class_schedule', gen_random_uuid(), 'merithub.class.create', '{}'::jsonb, $1)
         RETURNING status, attempts`,
        [SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempts).toBe(0);
  });

  it('REJECTS an invalid status value', async () => {
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload, status, created_by)
           VALUES ('class_schedule', gen_random_uuid(), 'merithub.class.create', '{}'::jsonb, 'made_up', $1)`,
          [SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS negative attempts', async () => {
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload, attempts, created_by)
           VALUES ('class_schedule', gen_random_uuid(), 'merithub.class.create', '{}'::jsonb, -1, $1)`,
          [SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a dead_letter/failed row with no last_error recorded', async () => {
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload, status, created_by)
           VALUES ('class_schedule', gen_random_uuid(), 'merithub.class.create', '{}'::jsonb, 'dead_letter', $1)`,
          [SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete an outbox_event', async () => {
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload, created_by)
         VALUES ('class_schedule', gen_random_uuid(), 'merithub.class.create', '{}'::jsonb, $1) RETURNING id`,
        [SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM outbox_event WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });
});

describe('notification', () => {
  it('creates a pending notification for a recipient', async () => {
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO notification (recipient_type, recipient_id, channel, template_code, payload, created_by, updated_by)
         VALUES ('user_account', $1, 'email', 'session_reminder_3h', '{}'::jsonb, $1, $1) RETURNING status`,
        [SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].status).toBe('pending');
  });

  it('REJECTS an invalid channel', async () => {
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO notification (recipient_type, recipient_id, channel, template_code, payload, created_by, updated_by)
           VALUES ('user_account', $1, 'carrier_pigeon', 'session_reminder_3h', '{}'::jsonb, $1, $1)`,
          [SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS an invalid status', async () => {
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO notification (recipient_type, recipient_id, channel, template_code, payload, status, created_by, updated_by)
           VALUES ('user_account', $1, 'email', 'session_reminder_3h', '{}'::jsonb, 'ghosted', $1, $1)`,
          [SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a failed notification with no failure_reason', async () => {
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO notification (recipient_type, recipient_id, channel, template_code, payload, status, created_by, updated_by)
           VALUES ('user_account', $1, 'email', 'session_reminder_3h', '{}'::jsonb, 'failed', $1, $1)`,
          [SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete a notification', async () => {
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO notification (recipient_type, recipient_id, channel, template_code, payload, created_by, updated_by)
         VALUES ('user_account', $1, 'email', 'session_reminder_3h', '{}'::jsonb, $1, $1) RETURNING id`,
        [SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM notification WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });
});
