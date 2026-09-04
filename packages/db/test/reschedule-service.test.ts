/**
 * Service-layer tests for the reschedule workflow -- rule 17, the
 * cancellation-cutoff policy, and the max-reschedules-per-subscription policy
 * (rule 20-adjacent). Written FIRST per CLAUDE.md's TDD mandate --
 * createReschedule() does not exist yet.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from '../src/migrate.js';
import * as schema from '../src/schema/index.js';
import {
  createReschedule,
  MaxReschedulesExceededError,
  MissingPolicyParameterError,
  SessionNotReschedulableError,
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

interface Fixtures {
  scheduleId: string;
  sessionId: string;
  enrollmentId: string;
  studentId: string;
  teacherId: string;
  subscriptionId: string;
}

/** `hoursFromNow` controls whether the session falls inside/outside a 24h cutoff. */
async function seedSession(hoursFromNow: number): Promise<Fixtures> {
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
       VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval, now() + ($5 || ' hours')::interval + interval '1 hour', 'scheduled', $6, $6)
       RETURNING id`,
      [scheduleRes.rows[0].id, enrollment.rows[0].id, student.rows[0].id, teacher.rows[0].id, hoursFromNow, SYSTEM_ACTOR],
    );
    return {
      scheduleId: scheduleRes.rows[0].id as string,
      sessionId: sessionRes.rows[0].id as string,
      enrollmentId: enrollment.rows[0].id as string,
      studentId: student.rows[0].id as string,
      teacherId: teacher.rows[0].id as string,
      subscriptionId: subscription.rows[0].id as string,
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

describe('createReschedule', () => {
  it('REJECTS when no cancellation_cutoff_hours policy row exists', async () => {
    const f = await seedSession(72);
    await expect(
      createReschedule(
        ctx,
        {
          sessionId: f.sessionId,
          subscriptionId: f.subscriptionId,
          newScheduledStartAt: new Date(Date.now() + 8 * 86_400_000),
          newScheduledEndAt: new Date(Date.now() + 8 * 86_400_000 + 3_600_000),
          reason: 'x',
        },
        db,
      ),
    ).rejects.toThrow(MissingPolicyParameterError);
  });

  it('marks outside_cutoff as protected (+1 ledger entry) when well before the cutoff', async () => {
    await setPolicy('cancellation_cutoff_hours', 24);
    await setPolicy('max_reschedules_per_subscription', 3);
    const f = await seedSession(72); // 72h out, 24h cutoff -> outside

    const result = await createReschedule(
      ctx,
      {
        sessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        newScheduledStartAt: new Date(Date.now() + 8 * 86_400_000),
        newScheduledEndAt: new Date(Date.now() + 8 * 86_400_000 + 3_600_000),
        reason: 'plans changed',
      },
      db,
    );

    expect(result.request.cutoffStatus).toBe('outside_cutoff');
    expect(result.ledgerEntry.entryType).toBe('protected');
    expect(result.ledgerEntry.amount).toBe(1);
    expect(result.newSession.sessionPurpose).toBe('replacement');

    const { rows } = await pool.query(`SELECT status, rescheduled_to_session_id FROM session WHERE id = $1`, [f.sessionId]);
    expect(rows[0].status).toBe('rescheduled');
    expect(rows[0].rescheduled_to_session_id).toBe(result.newSession.id);
  });

  it('marks inside_cutoff as consumed (-1 ledger entry) when close to the session time', async () => {
    await setPolicy('cancellation_cutoff_hours', 24);
    const f = await seedSession(2); // 2h out, 24h cutoff -> inside

    const result = await createReschedule(
      ctx,
      {
        sessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        newScheduledStartAt: new Date(Date.now() + 8 * 86_400_000),
        newScheduledEndAt: new Date(Date.now() + 8 * 86_400_000 + 3_600_000),
        reason: 'late change',
      },
      db,
    );

    expect(result.request.cutoffStatus).toBe('inside_cutoff');
    expect(result.ledgerEntry.entryType).toBe('consumed');
    expect(result.ledgerEntry.amount).toBe(-1);
  });

  it('REJECTS a session that is not in a reschedulable status', async () => {
    await setPolicy('cancellation_cutoff_hours', 24);
    const f = await seedSession(72);
    await asActor((c) => c.query(`UPDATE session SET status = 'completed' WHERE id = $1`, [f.sessionId]));

    await expect(
      createReschedule(
        ctx,
        {
          sessionId: f.sessionId,
          subscriptionId: f.subscriptionId,
          newScheduledStartAt: new Date(Date.now() + 8 * 86_400_000),
          newScheduledEndAt: new Date(Date.now() + 8 * 86_400_000 + 3_600_000),
          reason: 'x',
        },
        db,
      ),
    ).rejects.toThrow(SessionNotReschedulableError);
  });

  it('REJECTS once max_reschedules_per_subscription fulfilled requests already exist', async () => {
    await setPolicy('cancellation_cutoff_hours', 24);
    await setPolicy('max_reschedules_per_subscription', 1);
    const f = await seedSession(72);

    await createReschedule(
      ctx,
      {
        sessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        newScheduledStartAt: new Date(Date.now() + 8 * 86_400_000),
        newScheduledEndAt: new Date(Date.now() + 8 * 86_400_000 + 3_600_000),
        reason: 'first reschedule',
      },
      db,
    );

    const f2 = await seedSession(72);
    // Same subscription's second session -- the LIMIT is per subscription, not per session.
    await asActor((c) =>
      c.query(`UPDATE session SET class_schedule_id = class_schedule_id WHERE id = $1`, [f2.sessionId]),
    );

    await expect(
      createReschedule(
        ctx,
        {
          sessionId: f2.sessionId,
          subscriptionId: f.subscriptionId, // deliberately the SAME subscription as the first
          newScheduledStartAt: new Date(Date.now() + 9 * 86_400_000),
          newScheduledEndAt: new Date(Date.now() + 9 * 86_400_000 + 3_600_000),
          reason: 'second reschedule should be blocked',
        },
        db,
      ),
    ).rejects.toThrow(MaxReschedulesExceededError);
  });
});
