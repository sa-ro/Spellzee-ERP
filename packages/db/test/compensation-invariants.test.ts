/**
 * Integration tests for the session.outcome vocabulary and the `compensation`
 * table -- rule 18 (a compensation session is separate, additional, linked to
 * the original -- it MUST NOT modify or reschedule the original recurring
 * schedule) and rule 19 (teacher/Spellzee-side failure protects entitlement
 * and triggers compensation).
 *
 * Written FIRST per CLAUDE.md's TDD mandate: these must fail against the
 * current schema before the migrations that add them are written.
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

/** Enrollment + class_schedule + one 'teacher_absent' session, unique per call. */
async function seedAffectedSession() {
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
    const subscription = await c.query(
      `INSERT INTO subscription
         (student_id, plan_name, purchased_session_count, price_minor_units, purchase_date, start_date, valid_until, created_by, updated_by)
       VALUES ($1, 'Plan', 10, 100000, current_date, current_date, current_date + interval '90 days', $2, $2)
       RETURNING id`,
      [student.rows[0].id, SYSTEM_ACTOR],
    );
    const schedule = await c.query(
      `INSERT INTO class_schedule
         (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, '{1}', '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
       RETURNING id, updated_at`,
      [enrollment.rows[0].id, teacher.rows[0].id, crs.rows[0].id, subj.rows[0].id, SYSTEM_ACTOR],
    );
    const session = await c.query(
      `INSERT INTO session
         (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, status, outcome, created_by, updated_by)
       VALUES ($1, $2, $3, $4, now() - interval '1 day', now() - interval '1 day' + interval '1 hour', 'completed', 'teacher_absent', $5, $5)
       RETURNING id`,
      [schedule.rows[0].id, enrollment.rows[0].id, student.rows[0].id, teacher.rows[0].id, SYSTEM_ACTOR],
    );
    return {
      scheduleId: schedule.rows[0].id as string,
      scheduleUpdatedAt: schedule.rows[0].updated_at as string,
      sessionId: session.rows[0].id as string,
      enrollmentId: enrollment.rows[0].id as string,
      studentId: student.rows[0].id as string,
      teacherId: teacher.rows[0].id as string,
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

describe('session.outcome vocabulary', () => {
  it('REJECTS an invalid outcome value', async () => {
    const f = await seedAffectedSession();
    await expect(
      asActor((c) => c.query(`UPDATE session SET outcome = 'the_dog_ate_it' WHERE id = $1`, [f.sessionId])),
    ).rejects.toThrow();
  });

  it('accepts every documented outcome value', async () => {
    const values = [
      'completed', 'teacher_absent', 'teacher_technical_failure',
      'student_absent', 'student_technical_failure',
      'cancelled_outside_cutoff', 'cancelled_inside_cutoff',
    ];
    for (const v of values) {
      const f = await seedAffectedSession();
      await asActor((c) => c.query(`UPDATE session SET outcome = $2 WHERE id = $1`, [f.sessionId, v]));
    }
  });
});

describe('compensation table (rule 18, rule 19)', () => {
  it('creates a compensation record linking a distinct new session to the original', async () => {
    const f = await seedAffectedSession();
    const compSession = await asActor((c) =>
      c.query(
        `INSERT INTO session
           (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, session_purpose, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, now() + interval '2 day', now() + interval '2 day' + interval '1 hour', 'compensation', 'scheduled', $5, $5)
         RETURNING id`,
        [f.scheduleId, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO compensation
           (original_session_id, compensation_session_id, subscription_id, reason_code, validity_deadline, created_by, updated_by)
         VALUES ($1, $2, $3, 'teacher_absent', current_date + interval '30 days', $4, $4)
         RETURNING id, status`,
        [f.sessionId, compSession.rows[0].id, f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].status).toBe('scheduled');
  });

  it('REJECTS a compensation row where original_session_id = compensation_session_id', async () => {
    const f = await seedAffectedSession();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO compensation
             (original_session_id, compensation_session_id, subscription_id, reason_code, validity_deadline, created_by, updated_by)
           VALUES ($1, $1, $2, 'teacher_absent', current_date + interval '30 days', $3, $3)`,
          [f.sessionId, f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS a duplicate compensation record for the same original session', async () => {
    const f = await seedAffectedSession();
    const makeCompSession = () =>
      asActor((c) =>
        c.query(
          `INSERT INTO session
             (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, session_purpose, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, now() + interval '2 day', now() + interval '2 day' + interval '1 hour', 'compensation', 'scheduled', $5, $5)
           RETURNING id`,
          [f.scheduleId, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
        ),
      );
    const comp1 = await makeCompSession();
    await asActor((c) =>
      c.query(
        `INSERT INTO compensation
           (original_session_id, compensation_session_id, subscription_id, reason_code, validity_deadline, created_by, updated_by)
         VALUES ($1, $2, $3, 'teacher_absent', current_date + interval '30 days', $4, $4)`,
        [f.sessionId, comp1.rows[0].id, f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    const comp2Session = await asActor((c) =>
      c.query(
        `INSERT INTO session
           (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, session_purpose, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, now() + interval '3 day', now() + interval '3 day' + interval '1 hour', 'compensation', 'scheduled', $5, $5)
         RETURNING id`,
        [f.scheduleId, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO compensation
             (original_session_id, compensation_session_id, subscription_id, reason_code, validity_deadline, created_by, updated_by)
           VALUES ($1, $2, $3, 'teacher_absent', current_date + interval '30 days', $4, $4)`,
          [f.sessionId, comp2Session.rows[0].id, f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS an invalid status', async () => {
    const f = await seedAffectedSession();
    const compSession = await asActor((c) =>
      c.query(
        `INSERT INTO session
           (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, session_purpose, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, now() + interval '2 day', now() + interval '2 day' + interval '1 hour', 'compensation', 'scheduled', $5, $5)
         RETURNING id`,
        [f.scheduleId, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO compensation
             (original_session_id, compensation_session_id, subscription_id, reason_code, status, validity_deadline, created_by, updated_by)
           VALUES ($1, $2, $3, 'teacher_absent', 'vibes', current_date + interval '30 days', $4, $4)`,
          [f.sessionId, compSession.rows[0].id, f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete a compensation record', async () => {
    const f = await seedAffectedSession();
    const compSession = await asActor((c) =>
      c.query(
        `INSERT INTO session
           (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, session_purpose, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, now() + interval '2 day', now() + interval '2 day' + interval '1 hour', 'compensation', 'scheduled', $5, $5)
         RETURNING id`,
        [f.scheduleId, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
      ),
    );
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO compensation
           (original_session_id, compensation_session_id, subscription_id, reason_code, validity_deadline, created_by, updated_by)
         VALUES ($1, $2, $3, 'teacher_absent', current_date + interval '30 days', $4, $4) RETURNING id`,
        [f.sessionId, compSession.rows[0].id, f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM compensation WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });

  it('creating a compensation session does NOT modify the original class_schedule row (rule 18)', async () => {
    const f = await seedAffectedSession();
    await asActor((c) =>
      c.query(
        `INSERT INTO session
           (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, session_purpose, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, now() + interval '2 day', now() + interval '2 day' + interval '1 hour', 'compensation', 'scheduled', $5, $5)`,
        [f.scheduleId, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await pool.query(`SELECT updated_at FROM class_schedule WHERE id = $1`, [f.scheduleId]);
    expect(new Date(rows[0].updated_at).getTime()).toBe(new Date(f.scheduleUpdatedAt).getTime());
  });
});
