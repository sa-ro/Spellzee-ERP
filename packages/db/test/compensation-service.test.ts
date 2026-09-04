/**
 * Service-layer tests for the compensation workflow (rule 18, rule 19),
 * against a real PostgreSQL instance. These exercise createCompensation()
 * directly -- proving the WORKFLOW (qualifying-outcome check, no
 * class_schedule mutation, ledger entry, policy-driven validity deadline),
 * not just the underlying DB constraints (covered separately in
 * compensation-invariants.test.ts).
 *
 * Written FIRST per CLAUDE.md's TDD mandate -- createCompensation() does not
 * exist yet, so every test here fails on import before it fails on behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from '../src/migrate.js';
import * as schema from '../src/schema/index.js';
import {
  createCompensation,
  completeCompensation,
  expireCompensations,
  SessionNotQualifiedError,
  DuplicateCompensationError,
  MissingPolicyParameterError,
  CompensationNotScheduledError,
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
  scheduleUpdatedAt: string;
  sessionId: string;
  enrollmentId: string;
  studentId: string;
  teacherId: string;
  subscriptionId: string;
}

/** Enrollment + class_schedule + one session, unique per call. `outcome` defaults to 'teacher_absent'. */
async function seedAffectedSession(outcome: string | null = 'teacher_absent'): Promise<Fixtures> {
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
       VALUES ($1, $2, $3, $4, now() - interval '1 day', now() - interval '1 day' + interval '1 hour', 'completed', $5, $6, $6)
       RETURNING id`,
      [schedule.rows[0].id, enrollment.rows[0].id, student.rows[0].id, teacher.rows[0].id, outcome, SYSTEM_ACTOR],
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

/**
 * All tests in this file share one Testcontainers database (one beforeAll for
 * the whole file), so policy_parameter's "one current row per key" partial
 * unique index means a second call for the same key must supersede the first,
 * not insert a second current row -- exactly the effective-dated pattern the
 * table itself enforces (rule 12-style supersession, done here by the test
 * since no supersession helper exists yet at the service layer for policy
 * changes -- that's the policy-parameter-change skill's job, out of scope for
 * this batch).
 */
async function setCompensationValidityPolicy(days: number) {
  await asActor(async (c) => {
    await c.query(
      `UPDATE policy_parameter SET is_current = false, valid_to = now()
       WHERE key = 'compensation_validity_days' AND is_current`,
    );
    await c.query(
      `INSERT INTO policy_parameter (key, value, description, created_by, updated_by)
       VALUES ('compensation_validity_days', $1::jsonb, 'test', $2, $2)`,
      [String(days), SYSTEM_ACTOR],
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

describe('createCompensation (rule 18, rule 19)', () => {
  // Runs first, deliberately, before any test below seeds
  // compensation_validity_days -- proves the "missing policy" path against a
  // genuinely policy-free state rather than a superseded/old one.
  it('REJECTS when no compensation_validity_days policy row exists', async () => {
    const f = await seedAffectedSession('teacher_absent');

    await expect(
      createCompensation(
        ctx,
        {
          originalSessionId: f.sessionId,
          subscriptionId: f.subscriptionId,
          scheduledStartAt: new Date(Date.now() + 2 * 86_400_000),
          scheduledEndAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
          reason: 'x',
        },
        db,
      ),
    ).rejects.toThrow(MissingPolicyParameterError);
  });

  it('creates a compensation session and record without touching class_schedule', async () => {
    await setCompensationValidityPolicy(30);
    const f = await seedAffectedSession('teacher_absent');

    const result = await createCompensation(
      ctx,
      {
        originalSessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        scheduledStartAt: new Date(Date.now() + 2 * 86_400_000),
        scheduledEndAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
        reason: 'Teacher was absent, compensating',
      },
      db,
    );

    expect(result.compensationSession.sessionPurpose).toBe('compensation');
    expect(result.compensationSession.id).not.toBe(f.sessionId);
    expect(result.compensation.originalSessionId).toBe(f.sessionId);
    expect(result.compensation.compensationSessionId).toBe(result.compensationSession.id);

    const { rows } = await pool.query(`SELECT updated_at FROM class_schedule WHERE id = $1`, [f.scheduleId]);
    expect(new Date(rows[0].updated_at).getTime()).toBe(new Date(f.scheduleUpdatedAt).getTime());
  });

  it('records a protected ledger entry for the original session', async () => {
    await setCompensationValidityPolicy(30);
    const f = await seedAffectedSession('teacher_technical_failure');

    const result = await createCompensation(
      ctx,
      {
        originalSessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        scheduledStartAt: new Date(Date.now() + 2 * 86_400_000),
        scheduledEndAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
        reason: 'Technical failure on teacher side',
      },
      db,
    );

    expect(result.ledgerEntry.entryType).toBe('protected');
    expect(result.ledgerEntry.amount).toBe(1);
    expect(result.ledgerEntry.sessionId).toBe(f.sessionId);
    expect(result.compensation.protectedLedgerEntryId).toBe(result.ledgerEntry.id);
  });

  it('REJECTS a session whose outcome does not qualify for compensation', async () => {
    await setCompensationValidityPolicy(30);
    const f = await seedAffectedSession('student_absent');

    await expect(
      createCompensation(
        ctx,
        {
          originalSessionId: f.sessionId,
          subscriptionId: f.subscriptionId,
          scheduledStartAt: new Date(Date.now() + 2 * 86_400_000),
          scheduledEndAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
          reason: 'x',
        },
        db,
      ),
    ).rejects.toThrow(SessionNotQualifiedError);
  });

  it('REJECTS a second compensation for the same original session', async () => {
    await setCompensationValidityPolicy(30);
    const f = await seedAffectedSession('teacher_absent');

    await createCompensation(
      ctx,
      {
        originalSessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        scheduledStartAt: new Date(Date.now() + 2 * 86_400_000),
        scheduledEndAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
        reason: 'first attempt',
      },
      db,
    );

    await expect(
      createCompensation(
        ctx,
        {
          originalSessionId: f.sessionId,
          subscriptionId: f.subscriptionId,
          scheduledStartAt: new Date(Date.now() + 5 * 86_400_000),
          scheduledEndAt: new Date(Date.now() + 5 * 86_400_000 + 3_600_000),
          reason: 'second attempt should be rejected',
        },
        db,
      ),
    ).rejects.toThrow(DuplicateCompensationError);
  });

  it('sets validity_deadline from the policy value, not a hard-coded number', async () => {
    await setCompensationValidityPolicy(45);
    const f = await seedAffectedSession('teacher_absent');

    const result = await createCompensation(
      ctx,
      {
        originalSessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        scheduledStartAt: new Date(Date.now() + 2 * 86_400_000),
        scheduledEndAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
        reason: 'x',
      },
      db,
    );

    const expected = new Date();
    expected.setDate(expected.getDate() + 45);
    const deadline = new Date(result.compensation.validityDeadline);
    const diffDays = Math.round((deadline.getTime() - new Date().getTime()) / 86_400_000);
    expect(diffDays).toBeGreaterThanOrEqual(44);
    expect(diffDays).toBeLessThanOrEqual(45);
  });
});

describe('completeCompensation', () => {
  it('marks the compensation session and record completed, and debits a compensated ledger entry', async () => {
    await setCompensationValidityPolicy(30);
    const f = await seedAffectedSession('teacher_absent');
    const created = await createCompensation(
      ctx,
      {
        originalSessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        scheduledStartAt: new Date(Date.now() + 2 * 86_400_000),
        scheduledEndAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
        reason: 'x',
      },
      db,
    );

    const result = await completeCompensation(ctx, { compensationId: created.compensation.id }, db);

    expect(result.compensation.status).toBe('completed');
    expect(result.compensationSession.status).toBe('completed');
    expect(result.ledgerEntry.entryType).toBe('compensated');
    expect(result.ledgerEntry.amount).toBe(-1);
    expect(result.ledgerEntry.sessionId).toBe(created.compensationSession.id);
  });

  it('REJECTS completing a compensation that is not in scheduled status', async () => {
    await setCompensationValidityPolicy(30);
    const f = await seedAffectedSession('teacher_absent');
    const created = await createCompensation(
      ctx,
      {
        originalSessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        scheduledStartAt: new Date(Date.now() + 2 * 86_400_000),
        scheduledEndAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
        reason: 'x',
      },
      db,
    );
    await completeCompensation(ctx, { compensationId: created.compensation.id }, db);

    await expect(
      completeCompensation(ctx, { compensationId: created.compensation.id }, db),
    ).rejects.toThrow(CompensationNotScheduledError);
  });
});

describe('expireCompensations', () => {
  it('marks overdue scheduled compensations as expired WITHOUT touching the ledger (rule 17: never silently forgiven)', async () => {
    await setCompensationValidityPolicy(30);
    const f = await seedAffectedSession('teacher_absent');
    const created = await createCompensation(
      ctx,
      {
        originalSessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        scheduledStartAt: new Date(Date.now() + 2 * 86_400_000),
        scheduledEndAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
        reason: 'x',
      },
      db,
    );
    // Force it overdue -- validity_deadline in the past.
    await asActor((c) =>
      c.query(`UPDATE compensation SET validity_deadline = current_date - interval '1 day' WHERE id = $1`, [
        created.compensation.id,
      ]),
    );

    const ledgerCountBefore = await pool.query(
      `SELECT count(*)::int AS n FROM session_credit_ledger WHERE subscription_id = $1`,
      [f.subscriptionId],
    );

    const expired = await expireCompensations(ctx, db);

    expect(expired.map((c) => c.id)).toContain(created.compensation.id);
    const { rows } = await pool.query(`SELECT status FROM compensation WHERE id = $1`, [created.compensation.id]);
    expect(rows[0].status).toBe('expired');

    const ledgerCountAfter = await pool.query(
      `SELECT count(*)::int AS n FROM session_credit_ledger WHERE subscription_id = $1`,
      [f.subscriptionId],
    );
    // Only the original 'protected' entry from createCompensation -- expiry
    // itself writes no ledger row. The credit stays visible/available; it is
    // not silently consumed just because the compensation slot lapsed.
    expect(ledgerCountAfter.rows[0].n).toBe(ledgerCountBefore.rows[0].n);
  });

  it('does not touch a scheduled compensation that is not yet overdue', async () => {
    await setCompensationValidityPolicy(30);
    const f = await seedAffectedSession('teacher_absent');
    const created = await createCompensation(
      ctx,
      {
        originalSessionId: f.sessionId,
        subscriptionId: f.subscriptionId,
        scheduledStartAt: new Date(Date.now() + 2 * 86_400_000),
        scheduledEndAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000),
        reason: 'x',
      },
      db,
    );

    const expired = await expireCompensations(ctx, db);

    expect(expired.map((c) => c.id)).not.toContain(created.compensation.id);
    const { rows } = await pool.query(`SELECT status FROM compensation WHERE id = $1`, [created.compensation.id]);
    expect(rows[0].status).toBe('scheduled');
  });
});
