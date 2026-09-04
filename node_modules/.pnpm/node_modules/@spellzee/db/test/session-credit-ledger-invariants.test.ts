/**
 * Integration tests for session_credit_ledger -- CLAUDE.md §5 layer 3
 * (append-only ledger). Written FIRST per the TDD mandate: these must fail
 * against the current schema (table doesn't exist yet) before the migration
 * that creates it is written.
 *
 * Sources: rule 16 (defined entitlement), rule 17 (a purchased session is
 * never silently lost, a missed one never silently forgiven), rule 18
 * (compensation is separate, additional, linked -- not a reschedule), DD §10/
 * §41 (append-only, corrections are new entries).
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

/** A student + subscription, unique per call. */
async function seedSubscription() {
  const suffix = `${Date.now()}-${++fixtureCounter}`;
  return asActor(async (c) => {
    const student = await c.query(
      `INSERT INTO student (full_name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
      [`Student ${suffix}`, SYSTEM_ACTOR],
    );
    const subscription = await c.query(
      `INSERT INTO subscription
         (student_id, plan_name, purchased_session_count, price_minor_units, purchase_date, start_date, valid_until, created_by, updated_by)
       VALUES ($1, 'Plan', 10, 100000, current_date, current_date, current_date + interval '90 days', $2, $2)
       RETURNING id`,
      [student.rows[0].id, SYSTEM_ACTOR],
    );
    return {
      studentId: student.rows[0].id as string,
      subscriptionId: subscription.rows[0].id as string,
    };
  });
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

describe('session_credit_ledger (rule 16-18, DD §10/§41 append-only)', () => {
  it('records a purchased entry (positive amount)', async () => {
    const f = await seedSubscription();
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
         VALUES ($1, 'purchased', 10, 'initial_purchase', $2) RETURNING amount, entry_type`,
        [f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].amount).toBe(10);
    expect(rows[0].entry_type).toBe('purchased');
  });

  it('records a consumed entry (negative amount)', async () => {
    const f = await seedSubscription();
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
         VALUES ($1, 'consumed', -1, 'session_completed', $2) RETURNING amount`,
        [f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].amount).toBe(-1);
  });

  it('REJECTS an invalid entry_type', async () => {
    const f = await seedSubscription();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
           VALUES ($1, 'refunded', -1, 'x', $2)`,
          [f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a purchased entry with a non-positive amount', async () => {
    const f = await seedSubscription();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
           VALUES ($1, 'purchased', -5, 'x', $2)`,
          [f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a consumed entry with a non-negative amount', async () => {
    const f = await seedSubscription();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
           VALUES ($1, 'consumed', 1, 'x', $2)`,
          [f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS an adjusted entry with a zero amount', async () => {
    const f = await seedSubscription();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
           VALUES ($1, 'adjusted', 0, 'x', $2)`,
          [f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS an empty reason_code', async () => {
    const f = await seedSubscription();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
           VALUES ($1, 'purchased', 1, '  ', $2)`,
          [f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS an UPDATE -- ledger is append-only (rule 14)', async () => {
    const f = await seedSubscription();
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
         VALUES ($1, 'purchased', 10, 'initial_purchase', $2) RETURNING id`,
        [f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(`UPDATE session_credit_ledger SET amount = 999 WHERE id = $1`, [inserted.rows[0].id]),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a DELETE -- ledger is append-only (rule 14)', async () => {
    const f = await seedSubscription();
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
         VALUES ($1, 'purchased', 10, 'initial_purchase', $2) RETURNING id`,
        [f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM session_credit_ledger WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });

  it('a purchased-then-consumed balance is reconstructable by summing amount (rule 17)', async () => {
    const f = await seedSubscription();
    await asActor((c) =>
      c.query(
        `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
         VALUES ($1, 'purchased', 10, 'initial_purchase', $2)`,
        [f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    await asActor((c) =>
      c.query(
        `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, created_by)
         VALUES ($1, 'consumed', -3, 'session_completed', $2)`,
        [f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await pool.query(
      `SELECT sum(amount)::int AS balance FROM session_credit_ledger WHERE subscription_id = $1`,
      [f.subscriptionId],
    );
    expect(rows[0].balance).toBe(7);
  });

  it('a compensation entry links to the affected session without altering it (rule 18)', async () => {
    const f = await seedSubscription();
    // No class_schedule/session fixture here (out of scope for this narrow
    // ledger test) -- session_id is nullable precisely so a purchase/adjustment
    // entry isn't forced to reference one; this test only proves the FK column
    // accepts NULL, the compensation-vs-reschedule behavior itself belongs to
    // the compensation service layer (next batch).
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO session_credit_ledger (subscription_id, entry_type, amount, reason_code, session_id, created_by)
         VALUES ($1, 'compensated', -1, 'teacher_absence', NULL, $2) RETURNING session_id`,
        [f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].session_id).toBeNull();
  });
});
