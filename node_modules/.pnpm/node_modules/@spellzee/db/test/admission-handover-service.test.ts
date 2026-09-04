/**
 * Service-layer tests for the admission handover workflow -- SLA deadline
 * read live from policy_parameter (rule 28). Written FIRST per the TDD
 * mandate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from '../src/migrate.js';
import * as schema from '../src/schema/index.js';
import {
  createAdmissionHandover,
  acknowledgeHandover,
  HandoverNotPendingError,
  MissingPolicyParameterError,
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

async function seedEnrollment() {
  const suffix = `${Date.now()}-${++fixtureCounter}`;
  return asActor(async (c) => {
    const subj = await c.query(`INSERT INTO subject (code, name) VALUES ($1, 'Subject') RETURNING id`, [`SUB-${suffix}`]);
    const lvl = await c.query(`INSERT INTO level (code, name) VALUES ($1, 'Level') RETURNING id`, [`LVL-${suffix}`]);
    const crs = await c.query(
      `INSERT INTO course (code, name, subject_id, default_duration_minutes) VALUES ($1, 'Course', $2, 60) RETURNING id`,
      [`CRS-${suffix}`, subj.rows[0].id],
    );
    const student = await c.query(
      `INSERT INTO student (full_name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
      [`Student ${suffix}`, SYSTEM_ACTOR],
    );
    const enrollment = await c.query(
      `INSERT INTO enrollment (student_id, course_id, subject_id, level_id, start_date, created_by, updated_by)
       VALUES ($1, $2, $3, $4, current_date, $5, $5) RETURNING id`,
      [student.rows[0].id, crs.rows[0].id, subj.rows[0].id, lvl.rows[0].id, SYSTEM_ACTOR],
    );
    const employee = await c.query(
      `INSERT INTO employee (full_name, department, role_title, joining_date, created_by, updated_by)
       VALUES ($1, 'Sales', 'Admissions Rep', current_date, $2, $2) RETURNING id`,
      [`Employee ${suffix}`, SYSTEM_ACTOR],
    );
    const coordinator = await c.query(
      `INSERT INTO employee (full_name, department, role_title, joining_date, created_by, updated_by)
       VALUES ($1, 'Operations', 'Coordinator', current_date, $2, $2) RETURNING id`,
      [`Coordinator ${suffix}`, SYSTEM_ACTOR],
    );
    return {
      studentId: student.rows[0].id as string,
      enrollmentId: enrollment.rows[0].id as string,
      employeeId: employee.rows[0].id as string,
      coordinatorId: coordinator.rows[0].id as string,
    };
  });
}

async function setPolicy(key: string, value: number) {
  await asActor(async (c) => {
    await c.query(`UPDATE policy_parameter SET is_current = false, valid_to = now() WHERE key = $1 AND is_current`, [key]);
    await c.query(
      `INSERT INTO policy_parameter (key, value, description, created_by, updated_by)
       VALUES ($1, $2::jsonb, 'test', $3, $3)`,
      [key, String(value), SYSTEM_ACTOR],
    );
  });
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

describe('createAdmissionHandover', () => {
  it('REJECTS when no admission_allocation_sla_hours policy row exists', async () => {
    const f = await seedEnrollment();
    await expect(
      createAdmissionHandover(
        ctx,
        { studentId: f.studentId, enrollmentId: f.enrollmentId, handedOverBy: f.employeeId },
        db,
      ),
    ).rejects.toThrow(MissingPolicyParameterError);
  });

  it('creates a pending handover with an SLA deadline computed from the live policy value', async () => {
    await setPolicy('admission_allocation_sla_hours', 24);
    const f = await seedEnrollment();
    const before = Date.now();
    const result = await createAdmissionHandover(
      ctx,
      { studentId: f.studentId, enrollmentId: f.enrollmentId, handedOverBy: f.employeeId },
      db,
    );
    expect(result.status).toBe('pending');
    const diffHours = (new Date(result.slaDeadlineAt).getTime() - before) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThan(23.9);
    expect(diffHours).toBeLessThan(24.1);
  });
});

describe('acknowledgeHandover', () => {
  it('acknowledges a pending handover', async () => {
    await setPolicy('admission_allocation_sla_hours', 24);
    const f = await seedEnrollment();
    const created = await createAdmissionHandover(
      ctx,
      { studentId: f.studentId, enrollmentId: f.enrollmentId, handedOverBy: f.employeeId },
      db,
    );
    const result = await acknowledgeHandover(ctx, { handoverId: created.id, receivedBy: f.coordinatorId }, db);
    expect(result.status).toBe('acknowledged');
    expect(result.receivedBy).toBe(f.coordinatorId);
    expect(result.acknowledgedAt).toBeTruthy();
  });

  it('REJECTS acknowledging a handover that is not pending', async () => {
    await setPolicy('admission_allocation_sla_hours', 24);
    const f = await seedEnrollment();
    const created = await createAdmissionHandover(
      ctx,
      { studentId: f.studentId, enrollmentId: f.enrollmentId, handedOverBy: f.employeeId },
      db,
    );
    await acknowledgeHandover(ctx, { handoverId: created.id, receivedBy: f.coordinatorId }, db);

    await expect(
      acknowledgeHandover(ctx, { handoverId: created.id, receivedBy: f.coordinatorId }, db),
    ).rejects.toThrow(HandoverNotPendingError);
  });
});
