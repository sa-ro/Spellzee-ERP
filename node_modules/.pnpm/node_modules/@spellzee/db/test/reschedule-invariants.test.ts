/**
 * Integration tests for reschedule_request -- rule 17 (a purchased session is
 * never silently lost, a missed one never silently forgiven), the
 * cancellation-cutoff policy (outside cutoff = protected, inside = consumed),
 * and rule 20 (multiple enrollments/subscriptions over time is out of scope
 * here; this is about session-level reschedule history).
 *
 * Written FIRST per CLAUDE.md's TDD mandate.
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
       RETURNING id`,
      [enrollment.rows[0].id, teacher.rows[0].id, crs.rows[0].id, subj.rows[0].id, SYSTEM_ACTOR],
    );
    const session = await c.query(
      `INSERT INTO session
         (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, now() + interval '3 day', now() + interval '3 day' + interval '1 hour', 'scheduled', $5, $5)
       RETURNING id`,
      [schedule.rows[0].id, enrollment.rows[0].id, student.rows[0].id, teacher.rows[0].id, SYSTEM_ACTOR],
    );
    return {
      scheduleId: schedule.rows[0].id as string,
      sessionId: session.rows[0].id as string,
      enrollmentId: enrollment.rows[0].id as string,
      studentId: student.rows[0].id as string,
      teacherId: teacher.rows[0].id as string,
      subscriptionId: subscription.rows[0].id as string,
    };
  });
}

async function seedReplacementSession(f: Awaited<ReturnType<typeof seedSession>>, dayOffset = 5) {
  const { rows } = await asActor((c) =>
    c.query(
      `INSERT INTO session
         (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, session_purpose, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' day')::interval, now() + ($5 || ' day')::interval + interval '1 hour', 'replacement', 'scheduled', $6, $6)
       RETURNING id`,
      [f.scheduleId, f.enrollmentId, f.studentId, f.teacherId, dayOffset, SYSTEM_ACTOR],
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

describe('reschedule_request', () => {
  it('creates a fulfilled reschedule_request linking the original session to its replacement', async () => {
    const f = await seedSession();
    const replacementId = await seedReplacementSession(f);
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO reschedule_request
           (session_id, new_session_id, subscription_id, requested_new_start_at, requested_new_end_at,
            cutoff_status, status, reason, requested_by, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '5 day', now() + interval '5 day' + interval '1 hour',
                 'outside_cutoff', 'fulfilled', 'plans changed', $4, $4, $4)
         RETURNING status, cutoff_status`,
        [f.sessionId, replacementId, f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].status).toBe('fulfilled');
    expect(rows[0].cutoff_status).toBe('outside_cutoff');
  });

  it('REJECTS an invalid cutoff_status', async () => {
    const f = await seedSession();
    const replacementId = await seedReplacementSession(f);
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO reschedule_request
             (session_id, new_session_id, subscription_id, requested_new_start_at, requested_new_end_at,
              cutoff_status, reason, requested_by, created_by, updated_by)
           VALUES ($1, $2, $3, now() + interval '5 day', now() + interval '5 day' + interval '1 hour',
                   'vibes', 'x', $4, $4, $4)`,
          [f.sessionId, replacementId, f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS an invalid status', async () => {
    const f = await seedSession();
    const replacementId = await seedReplacementSession(f);
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO reschedule_request
             (session_id, new_session_id, subscription_id, requested_new_start_at, requested_new_end_at,
              cutoff_status, status, reason, requested_by, created_by, updated_by)
           VALUES ($1, $2, $3, now() + interval '5 day', now() + interval '5 day' + interval '1 hour',
                   'outside_cutoff', 'vibes', 'x', $4, $4, $4)`,
          [f.sessionId, replacementId, f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS an empty reason', async () => {
    const f = await seedSession();
    const replacementId = await seedReplacementSession(f);
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO reschedule_request
             (session_id, new_session_id, subscription_id, requested_new_start_at, requested_new_end_at,
              cutoff_status, reason, requested_by, created_by, updated_by)
           VALUES ($1, $2, $3, now() + interval '5 day', now() + interval '5 day' + interval '1 hour',
                   'outside_cutoff', '  ', $4, $4, $4)`,
          [f.sessionId, replacementId, f.subscriptionId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete a reschedule_request', async () => {
    const f = await seedSession();
    const replacementId = await seedReplacementSession(f);
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO reschedule_request
           (session_id, new_session_id, subscription_id, requested_new_start_at, requested_new_end_at,
            cutoff_status, reason, requested_by, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '5 day', now() + interval '5 day' + interval '1 hour',
                 'outside_cutoff', 'x', $4, $4, $4) RETURNING id`,
        [f.sessionId, replacementId, f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM reschedule_request WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });

  it('allows multiple reschedule_request rows per session (a session can be rescheduled more than once historically)', async () => {
    const f = await seedSession();
    const r1 = await seedReplacementSession(f, 5);
    const r2 = await seedReplacementSession(f, 6);
    await asActor((c) =>
      c.query(
        `INSERT INTO reschedule_request
           (session_id, new_session_id, subscription_id, requested_new_start_at, requested_new_end_at,
            cutoff_status, reason, requested_by, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '5 day', now() + interval '5 day' + interval '1 hour',
                 'outside_cutoff', 'first', $4, $4, $4)`,
        [f.sessionId, r1, f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO reschedule_request
           (session_id, new_session_id, subscription_id, requested_new_start_at, requested_new_end_at,
            cutoff_status, reason, requested_by, created_by, updated_by)
         VALUES ($1, $2, $3, now() + interval '6 day', now() + interval '6 day' + interval '1 hour',
                 'inside_cutoff', 'second', $4, $4, $4) RETURNING id`,
        [f.sessionId, r2, f.subscriptionId, SYSTEM_ACTOR],
      ),
    );
    expect(rows[0].id).toBeTruthy();
  });
});
