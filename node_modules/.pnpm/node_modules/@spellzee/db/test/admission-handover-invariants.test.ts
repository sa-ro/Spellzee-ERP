/**
 * Integration tests for admission_handover -- Master §"admission-allocation
 * SLA 24h (start: handover receipt; stop: allocation confirmed)". Written
 * FIRST per the TDD mandate.
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
    return {
      studentId: student.rows[0].id as string,
      enrollmentId: enrollment.rows[0].id as string,
      employeeId: employee.rows[0].id as string,
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

describe('admission_handover', () => {
  it('creates a pending handover with an SLA deadline', async () => {
    const f = await seedEnrollment();
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO admission_handover
           (student_id, enrollment_id, handed_over_by, sla_deadline_at, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '24 hours', $4, $4)
         RETURNING status`,
        [f.studentId, f.enrollmentId, f.employeeId, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].status).toBe('pending');
  });

  it('REJECTS an invalid status', async () => {
    const f = await seedEnrollment();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO admission_handover
             (student_id, enrollment_id, handed_over_by, status, sla_deadline_at, created_by, updated_by)
           VALUES ($1, $2, $3, 'vibes', now() + interval '24 hours', $4, $4)`,
          [f.studentId, f.enrollmentId, f.employeeId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS an acknowledged handover with no received_by/acknowledged_at', async () => {
    const f = await seedEnrollment();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO admission_handover
             (student_id, enrollment_id, handed_over_by, status, sla_deadline_at, created_by, updated_by)
           VALUES ($1, $2, $3, 'acknowledged', now() + interval '24 hours', $4, $4)`,
          [f.studentId, f.enrollmentId, f.employeeId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a second handover for the same enrollment (one active handover per enrollment)', async () => {
    const f = await seedEnrollment();
    await asActor((c) =>
      c.query(
        `INSERT INTO admission_handover
           (student_id, enrollment_id, handed_over_by, sla_deadline_at, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '24 hours', $4, $4)`,
        [f.studentId, f.enrollmentId, f.employeeId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO admission_handover
             (student_id, enrollment_id, handed_over_by, sla_deadline_at, created_by, updated_by)
           VALUES ($1, $2, $3, now() + interval '24 hours', $4, $4)`,
          [f.studentId, f.enrollmentId, f.employeeId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete an admission_handover', async () => {
    const f = await seedEnrollment();
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO admission_handover
           (student_id, enrollment_id, handed_over_by, sla_deadline_at, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '24 hours', $4, $4) RETURNING id`,
        [f.studentId, f.enrollmentId, f.employeeId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM admission_handover WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });
});
