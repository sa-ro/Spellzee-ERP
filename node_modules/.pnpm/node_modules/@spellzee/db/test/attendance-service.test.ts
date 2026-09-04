/**
 * Service-layer tests for recordAttendance() -- proves the WORKFLOW (live
 * policy read, classification via the pure domain function, one-per-session
 * enforcement), not just the underlying DB constraints. Written FIRST per the
 * TDD mandate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from '../src/migrate.js';
import * as schema from '../src/schema/index.js';
import {
  recordAttendance,
  DuplicateAttendanceError,
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

async function seedSession() {
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
    const teacher = await c.query(
      `INSERT INTO teacher (full_name, is_allocation_eligible, allocation_eligibility_reason, created_by, updated_by)
       VALUES ($1, true, 'verified', $2, $2) RETURNING id`,
      [`Teacher ${suffix}`, SYSTEM_ACTOR],
    );
    const enrollment = await c.query(
      `INSERT INTO enrollment (student_id, course_id, subject_id, level_id, start_date, created_by, updated_by)
       VALUES ($1, $2, $3, $4, current_date, $5, $5) RETURNING id`,
      [student.rows[0].id, crs.rows[0].id, subj.rows[0].id, lvl.rows[0].id, SYSTEM_ACTOR],
    );
    const scheduleRes = await c.query(
      `INSERT INTO class_schedule
         (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, '{1}', '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
       RETURNING id`,
      [enrollment.rows[0].id, teacher.rows[0].id, crs.rows[0].id, subj.rows[0].id, SYSTEM_ACTOR],
    );
    const sessionRes = await c.query(
      `INSERT INTO session
         (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour', now(), 'completed', $5, $5)
       RETURNING id`,
      [scheduleRes.rows[0].id, enrollment.rows[0].id, student.rows[0].id, teacher.rows[0].id, SYSTEM_ACTOR],
    );
    return {
      sessionId: sessionRes.rows[0].id as string,
      studentId: student.rows[0].id as string,
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

async function setAllAttendancePolicies() {
  await setPolicy('attendance_present_threshold_pct', 90);
  await setPolicy('attendance_partial_threshold_pct', 50);
  await setPolicy('attendance_late_minutes', 10);
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

describe('recordAttendance', () => {
  it('REJECTS when attendance policy rows are missing', async () => {
    const f = await seedSession();
    await expect(
      recordAttendance(
        ctx,
        { sessionId: f.sessionId, studentId: f.studentId, presentMinutes: 60, totalMinutes: 60, lateByMinutes: 0 },
        db,
      ),
    ).rejects.toThrow(MissingPolicyParameterError);
  });

  it('classifies full attendance as present, reading thresholds live from policy_parameter', async () => {
    await setAllAttendancePolicies();
    const f = await seedSession();
    const result = await recordAttendance(
      ctx,
      { sessionId: f.sessionId, studentId: f.studentId, presentMinutes: 60, totalMinutes: 60, lateByMinutes: 0 },
      db,
    );
    expect(result.attendanceStatus).toBe('present');
  });

  it('classifies partial attendance correctly', async () => {
    await setAllAttendancePolicies();
    const f = await seedSession();
    const result = await recordAttendance(
      ctx,
      { sessionId: f.sessionId, studentId: f.studentId, presentMinutes: 35, totalMinutes: 60, lateByMinutes: 0 },
      db,
    );
    expect(result.attendanceStatus).toBe('partial');
  });

  it('REJECTS a duplicate attendance record for the same session', async () => {
    await setAllAttendancePolicies();
    const f = await seedSession();
    await recordAttendance(
      ctx,
      { sessionId: f.sessionId, studentId: f.studentId, presentMinutes: 60, totalMinutes: 60, lateByMinutes: 0 },
      db,
    );
    await expect(
      recordAttendance(
        ctx,
        { sessionId: f.sessionId, studentId: f.studentId, presentMinutes: 0, totalMinutes: 60, lateByMinutes: 0 },
        db,
      ),
    ).rejects.toThrow(DuplicateAttendanceError);
  });
});
