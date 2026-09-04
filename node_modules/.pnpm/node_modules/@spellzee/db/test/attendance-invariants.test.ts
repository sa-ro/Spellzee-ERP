/**
 * Integration tests for the attendance table -- CLAUDE.md §4 accepted
 * defaults (>=90% Present, 50-89% Partial, <50% Absent, >10 min late = Late).
 * Written FIRST per the TDD mandate.
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
    const schedule = await c.query(
      `INSERT INTO class_schedule
         (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, '{1}', '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
       RETURNING id`,
      [enrollment.rows[0].id, teacher.rows[0].id, crs.rows[0].id, subj.rows[0].id, SYSTEM_ACTOR],
    );
    const session = await c.query(
      `INSERT INTO session
         (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour', now(), 'completed', $5, $5)
       RETURNING id`,
      [schedule.rows[0].id, enrollment.rows[0].id, student.rows[0].id, teacher.rows[0].id, SYSTEM_ACTOR],
    );
    return {
      sessionId: session.rows[0].id as string,
      studentId: student.rows[0].id as string,
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

describe('attendance', () => {
  it('records attendance for a session', async () => {
    const f = await seedSession();
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO attendance
           (session_id, student_id, attendance_status, present_minutes, total_minutes, late_by_minutes, recorded_by, created_by, updated_by)
         VALUES ($1, $2, 'present', 60, 60, 0, $3, $3, $3)
         RETURNING attendance_status`,
        [f.sessionId, f.studentId, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].attendance_status).toBe('present');
  });

  it('REJECTS an invalid attendance_status', async () => {
    const f = await seedSession();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO attendance
             (session_id, student_id, attendance_status, present_minutes, total_minutes, late_by_minutes, recorded_by, created_by, updated_by)
           VALUES ($1, $2, 'vibes', 60, 60, 0, $3, $3, $3)`,
          [f.sessionId, f.studentId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS present_minutes greater than total_minutes', async () => {
    const f = await seedSession();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO attendance
             (session_id, student_id, attendance_status, present_minutes, total_minutes, late_by_minutes, recorded_by, created_by, updated_by)
           VALUES ($1, $2, 'present', 90, 60, 0, $3, $3, $3)`,
          [f.sessionId, f.studentId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS negative minutes', async () => {
    const f = await seedSession();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO attendance
             (session_id, student_id, attendance_status, present_minutes, total_minutes, late_by_minutes, recorded_by, created_by, updated_by)
           VALUES ($1, $2, 'absent', -5, 60, 0, $3, $3, $3)`,
          [f.sessionId, f.studentId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a second attendance row for the same session (one-per-session)', async () => {
    const f = await seedSession();
    await asActor((c) =>
      c.query(
        `INSERT INTO attendance
           (session_id, student_id, attendance_status, present_minutes, total_minutes, late_by_minutes, recorded_by, created_by, updated_by)
         VALUES ($1, $2, 'present', 60, 60, 0, $3, $3, $3)`,
        [f.sessionId, f.studentId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO attendance
             (session_id, student_id, attendance_status, present_minutes, total_minutes, late_by_minutes, recorded_by, created_by, updated_by)
           VALUES ($1, $2, 'absent', 0, 60, 0, $3, $3, $3)`,
          [f.sessionId, f.studentId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete an attendance record', async () => {
    const f = await seedSession();
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO attendance
           (session_id, student_id, attendance_status, present_minutes, total_minutes, late_by_minutes, recorded_by, created_by, updated_by)
         VALUES ($1, $2, 'present', 60, 60, 0, $3, $3, $3) RETURNING id`,
        [f.sessionId, f.studentId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM attendance WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });
});
