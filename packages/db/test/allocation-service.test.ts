/**
 * Service-layer tests for the allocation workflow (DD §13, Master §14.3) and
 * coordinator ownership transfers (DD §14), against a real PostgreSQL instance.
 *
 * These exercise createAllocation/changeTeacher/transferOwnership directly —
 * proving the WORKFLOW (availability/capacity pre-checks, history
 * preservation, capacity bookkeeping), not just the underlying DB constraints
 * (covered separately in workforce-invariants.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from '../src/migrate.js';
import * as schema from '../src/schema/index.js';
import {
  createAllocation,
  changeTeacher,
  transferOwnership,
  getOwnershipHistory,
  AllocationBlockedError,
  TeacherNotEligibleError,
  OwnershipError,
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
  studentId: string;
  employeeId: string;
  teacherId: string;
  teacherPublicId: string;
  courseId: string;
  subjectId: string;
  levelId: string;
  enrollmentId: string;
}

/** Fresh student/employee/teacher/course/enrollment per call — no cross-test collisions. */
async function seedFixtures(opts: { teacherEligible?: boolean } = {}): Promise<Fixtures> {
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
    const employee = await c.query(
      `INSERT INTO employee (full_name, department, role_title, joining_date, created_by, updated_by)
       VALUES ($1, 'Operations', 'Coordinator', current_date, $2, $2) RETURNING id`,
      [`Employee ${suffix}`, SYSTEM_ACTOR],
    );
    const teacher = await c.query(
      `INSERT INTO teacher (full_name, is_allocation_eligible, allocation_eligibility_reason, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $4) RETURNING id, public_id`,
      [
        `Teacher ${suffix}`,
        opts.teacherEligible ?? true,
        opts.teacherEligible === false ? null : 'verified',
        SYSTEM_ACTOR,
      ],
    );
    const enrollment = await c.query(
      `INSERT INTO enrollment (student_id, course_id, subject_id, level_id, start_date, created_by, updated_by)
       VALUES ($1, $2, $3, $4, current_date, $5, $5) RETURNING id`,
      [student.rows[0].id, crs.rows[0].id, subj.rows[0].id, lvl.rows[0].id, SYSTEM_ACTOR],
    );
    return {
      studentId: student.rows[0].id as string,
      employeeId: employee.rows[0].id as string,
      teacherId: teacher.rows[0].id as string,
      teacherPublicId: teacher.rows[0].public_id as string,
      courseId: crs.rows[0].id as string,
      subjectId: subj.rows[0].id as string,
      levelId: lvl.rows[0].id as string,
      enrollmentId: enrollment.rows[0].id as string,
    };
  });
}

/** Grants a teacher a Mon/Wed 09:00-10:00 regular availability + matching capacity. */
async function grantAvailabilityAndCapacity(
  teacherId: string,
  opts: { days?: number[]; startTime?: string; endTime?: string; plannedMinutes?: number } = {},
): Promise<void> {
  const days = opts.days ?? [1, 3];
  const startTime = opts.startTime ?? '09:00';
  const endTime = opts.endTime ?? '10:00';
  const plannedMinutes = opts.plannedMinutes ?? 60;

  await asActor(async (c) => {
    for (const day of days) {
      await c.query(
        `INSERT INTO teacher_availability (teacher_id, availability_type, day_of_week, start_time, end_time, timezone, created_by, updated_by)
         VALUES ($1, 'regular', $2, $3, $4, 'Asia/Kolkata', $5, $5)`,
        [teacherId, day, startTime, endTime, SYSTEM_ACTOR],
      );
      await c.query(
        `INSERT INTO teacher_capacity (teacher_id, day_of_week, start_time, end_time, planned_capacity_minutes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [teacherId, day, startTime, endTime, plannedMinutes, SYSTEM_ACTOR],
      );
    }
  });
}

async function currentCapacity(teacherId: string, dayOfWeek: number): Promise<{ allocated: number; planned: number }> {
  const { rows } = await pool.query(
    `SELECT allocated_capacity_minutes, planned_capacity_minutes FROM teacher_capacity
     WHERE teacher_id = $1 AND day_of_week = $2 AND is_current`,
    [teacherId, dayOfWeek],
  );
  return { allocated: rows[0].allocated_capacity_minutes, planned: rows[0].planned_capacity_minutes };
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

describe('createAllocation — happy path', () => {
  it('creates a class_schedule and teacher_allocation, both active and current', async () => {
    const f = await seedFixtures();
    await grantAvailabilityAndCapacity(f.teacherId);

    const result = await createAllocation(
      ctx,
      {
        enrollmentId: f.enrollmentId,
        teacherId: f.teacherId,
        allocationType: 'new_admission',
        reason: 'First allocation after admission handover',
        requestedBy: SYSTEM_ACTOR,
        schedule: {
          sessionType: 'one_to_one',
          courseId: f.courseId,
          subjectId: f.subjectId,
          daysOfWeek: [1, 3],
          startTime: '09:00',
          endTime: '10:00',
          timezone: 'Asia/Kolkata',
          startDate: '2026-09-07',
        },
      },
      db,
    );

    expect(result.schedule.status).toBe('active');
    expect(result.schedule.isCurrent).toBe(true);
    expect(result.allocation.status).toBe('active');
    expect(result.allocation.isCurrent).toBe(true);
    expect(result.allocation.classScheduleId).toBe(result.schedule.id);
    expect(result.allocation.previousTeacherId).toBeNull();
  });

  it('consumes capacity for every requested day', async () => {
    const f = await seedFixtures();
    await grantAvailabilityAndCapacity(f.teacherId, { days: [2, 4] });

    await createAllocation(
      ctx,
      {
        enrollmentId: f.enrollmentId,
        teacherId: f.teacherId,
        allocationType: 'new_admission',
        reason: 'consumes capacity',
        requestedBy: SYSTEM_ACTOR,
        schedule: {
          sessionType: 'one_to_one',
          courseId: f.courseId,
          subjectId: f.subjectId,
          daysOfWeek: [2, 4],
          startTime: '09:00',
          endTime: '10:00',
          timezone: 'Asia/Kolkata',
          startDate: '2026-09-08',
        },
      },
      db,
    );

    const tue = await currentCapacity(f.teacherId, 2);
    const thu = await currentCapacity(f.teacherId, 4);
    expect(tue.allocated).toBe(60);
    expect(thu.allocated).toBe(60);
  });

  it('writes audit_event rows for the schedule and allocation inserts', async () => {
    const f = await seedFixtures();
    await grantAvailabilityAndCapacity(f.teacherId, { days: [5] });

    const result = await createAllocation(
      ctx,
      {
        enrollmentId: f.enrollmentId,
        teacherId: f.teacherId,
        allocationType: 'new_admission',
        reason: 'audited',
        requestedBy: SYSTEM_ACTOR,
        schedule: {
          sessionType: 'one_to_one',
          courseId: f.courseId,
          subjectId: f.subjectId,
          daysOfWeek: [5],
          startTime: '09:00',
          endTime: '10:00',
          timezone: 'Asia/Kolkata',
          startDate: '2026-09-11',
        },
      },
      db,
    );

    const scheduleAudit = await pool.query(
      `SELECT action FROM audit.audit_event WHERE entity_type='class_schedule' AND record_id=$1`,
      [result.schedule.id],
    );
    const allocationAudit = await pool.query(
      `SELECT action FROM audit.audit_event WHERE entity_type='teacher_allocation' AND record_id=$1`,
      [result.allocation.id],
    );
    expect(scheduleAudit.rows.map((r) => r.action)).toContain('INSERT');
    expect(allocationAudit.rows.map((r) => r.action)).toContain('INSERT');
  });
});

describe('createAllocation — pre-checks (the prompt\'s core requirement)', () => {
  it('throws TeacherNotEligibleError and writes NOTHING for an ineligible teacher', async () => {
    const f = await seedFixtures({ teacherEligible: false });
    await grantAvailabilityAndCapacity(f.teacherId);

    await expect(
      createAllocation(
        ctx,
        {
          enrollmentId: f.enrollmentId,
          teacherId: f.teacherId,
          allocationType: 'new_admission',
          reason: 'should be blocked',
          requestedBy: SYSTEM_ACTOR,
          schedule: {
            sessionType: 'one_to_one',
            courseId: f.courseId,
            subjectId: f.subjectId,
            daysOfWeek: [1],
            startTime: '09:00',
            endTime: '10:00',
            timezone: 'Asia/Kolkata',
            startDate: '2026-09-07',
          },
        },
        db,
      ),
    ).rejects.toBeInstanceOf(TeacherNotEligibleError);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM class_schedule WHERE enrollment_id = $1', [
      f.enrollmentId,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it('throws AllocationBlockedError when the teacher has no availability rule for the day', async () => {
    const f = await seedFixtures();
    // No availability granted at all.

    await expect(
      createAllocation(
        ctx,
        {
          enrollmentId: f.enrollmentId,
          teacherId: f.teacherId,
          allocationType: 'new_admission',
          reason: 'no availability',
          requestedBy: SYSTEM_ACTOR,
          schedule: {
            sessionType: 'one_to_one',
            courseId: f.courseId,
            subjectId: f.subjectId,
            daysOfWeek: [1],
            startTime: '09:00',
            endTime: '10:00',
            timezone: 'Asia/Kolkata',
            startDate: '2026-09-07',
          },
        },
        db,
      ),
    ).rejects.toBeInstanceOf(AllocationBlockedError);
  });

  it('throws AllocationBlockedError when capacity is already exhausted', async () => {
    const f = await seedFixtures();
    await grantAvailabilityAndCapacity(f.teacherId, { days: [1], plannedMinutes: 60 });
    // Consume the only capacity with a first allocation.
    await createAllocation(
      ctx,
      {
        enrollmentId: f.enrollmentId,
        teacherId: f.teacherId,
        allocationType: 'new_admission',
        reason: 'first, consumes all capacity',
        requestedBy: SYSTEM_ACTOR,
        schedule: {
          sessionType: 'one_to_one',
          courseId: f.courseId,
          subjectId: f.subjectId,
          daysOfWeek: [1],
          startTime: '09:00',
          endTime: '10:00',
          timezone: 'Asia/Kolkata',
          startDate: '2026-09-07',
        },
      },
      db,
    );

    const second = await seedFixtures();
    await expect(
      createAllocation(
        ctx,
        {
          enrollmentId: second.enrollmentId,
          teacherId: f.teacherId, // same, now-exhausted teacher/slot
          allocationType: 'new_admission',
          reason: 'second, should be blocked',
          requestedBy: SYSTEM_ACTOR,
          schedule: {
            sessionType: 'one_to_one',
            courseId: second.courseId,
            subjectId: second.subjectId,
            daysOfWeek: [1],
            startTime: '09:00',
            endTime: '10:00',
            timezone: 'Asia/Kolkata',
            startDate: '2026-09-07',
          },
        },
        db,
      ),
    ).rejects.toBeInstanceOf(AllocationBlockedError);
  });

  it('reports every failing day, not just the first, in a multi-day request', async () => {
    const f = await seedFixtures();
    await grantAvailabilityAndCapacity(f.teacherId, { days: [1] }); // only Monday granted

    try {
      await createAllocation(
        ctx,
        {
          enrollmentId: f.enrollmentId,
          teacherId: f.teacherId,
          allocationType: 'new_admission',
          reason: 'Mon ok, Wed/Fri missing',
          requestedBy: SYSTEM_ACTOR,
          schedule: {
            sessionType: 'one_to_one',
            courseId: f.courseId,
            subjectId: f.subjectId,
            daysOfWeek: [1, 3, 5],
            startTime: '09:00',
            endTime: '10:00',
            timezone: 'Asia/Kolkata',
            startDate: '2026-09-07',
          },
        },
        db,
      );
      expect.fail('expected AllocationBlockedError');
    } catch (err) {
      expect(err).toBeInstanceOf(AllocationBlockedError);
      const blocked = err as AllocationBlockedError;
      expect(blocked.failures).toHaveLength(2);
      expect(blocked.failures.map((f2) => f2.slot.dayOfWeek).sort()).toEqual([3, 5]);
    }
  });
});

describe('createAllocation / changeTeacher — history preservation (Master §14.3, rule 12)', () => {
  it('supersedes the previous allocation and schedule rather than overwriting them', async () => {
    const f = await seedFixtures();
    const teacherB = await seedFixtures();
    await grantAvailabilityAndCapacity(f.teacherId, { days: [1] });
    await grantAvailabilityAndCapacity(teacherB.teacherId, { days: [1] });

    const first = await createAllocation(
      ctx,
      {
        enrollmentId: f.enrollmentId,
        teacherId: f.teacherId,
        allocationType: 'new_admission',
        reason: 'initial allocation',
        requestedBy: SYSTEM_ACTOR,
        schedule: {
          sessionType: 'one_to_one',
          courseId: f.courseId,
          subjectId: f.subjectId,
          daysOfWeek: [1],
          startTime: '09:00',
          endTime: '10:00',
          timezone: 'Asia/Kolkata',
          startDate: '2026-09-07',
        },
      },
      db,
    );

    const second = await createAllocation(
      ctx,
      {
        enrollmentId: f.enrollmentId,
        teacherId: teacherB.teacherId,
        allocationType: 'teacher_change',
        reason: 'original teacher went on leave',
        requestedBy: SYSTEM_ACTOR,
        schedule: {
          sessionType: 'one_to_one',
          courseId: f.courseId,
          subjectId: f.subjectId,
          daysOfWeek: [1],
          startTime: '09:00',
          endTime: '10:00',
          timezone: 'Asia/Kolkata',
          startDate: '2026-09-07',
        },
      },
      db,
    );

    // The NEW row carries the OLD reference (Master §14.3).
    expect(second.allocation.previousTeacherId).toBe(f.teacherId);
    expect(second.allocation.previousClassScheduleId).toBe(first.schedule.id);
    expect(second.allocation.isCurrent).toBe(true);

    // The OLD row is retained, not deleted, and correctly marked superseded.
    const oldAllocation = await pool.query('SELECT * FROM teacher_allocation WHERE id = $1', [first.allocation.id]);
    expect(oldAllocation.rows[0].is_current).toBe(false);
    expect(oldAllocation.rows[0].superseded_by_id).toBe(second.allocation.id);
    expect(oldAllocation.rows[0].valid_to).not.toBeNull();

    const oldSchedule = await pool.query('SELECT * FROM class_schedule WHERE id = $1', [first.schedule.id]);
    expect(oldSchedule.rows[0].is_current).toBe(false);
    expect(oldSchedule.rows[0].superseded_by_id).toBe(second.schedule.id);

    // Both rows are still queryable — history is reconstructable (rule 12).
    const history = await pool.query(
      'SELECT teacher_id, is_current FROM teacher_allocation WHERE enrollment_id = $1 ORDER BY valid_from',
      [f.enrollmentId],
    );
    expect(history.rows).toHaveLength(2);
    expect(history.rows[0].teacher_id).toBe(f.teacherId);
    expect(history.rows[1].teacher_id).toBe(teacherB.teacherId);
  });

  it('releases the old teacher\'s capacity and consumes the new teacher\'s, via changeTeacher', async () => {
    const f = await seedFixtures();
    const teacherB = await seedFixtures();
    await grantAvailabilityAndCapacity(f.teacherId, { days: [3] });
    await grantAvailabilityAndCapacity(teacherB.teacherId, { days: [3] });

    await createAllocation(
      ctx,
      {
        enrollmentId: f.enrollmentId,
        teacherId: f.teacherId,
        allocationType: 'new_admission',
        reason: 'initial',
        requestedBy: SYSTEM_ACTOR,
        schedule: {
          sessionType: 'one_to_one',
          courseId: f.courseId,
          subjectId: f.subjectId,
          daysOfWeek: [3],
          startTime: '09:00',
          endTime: '10:00',
          timezone: 'Asia/Kolkata',
          startDate: '2026-09-09',
        },
      },
      db,
    );

    expect((await currentCapacity(f.teacherId, 3)).allocated).toBe(60);

    await changeTeacher(
      ctx,
      {
        enrollmentId: f.enrollmentId,
        newTeacherId: teacherB.teacherId,
        reason: 'parent requested change',
        requestedBy: SYSTEM_ACTOR,
      },
      db,
    );

    expect((await currentCapacity(f.teacherId, 3)).allocated).toBe(0);
    expect((await currentCapacity(teacherB.teacherId, 3)).allocated).toBe(60);
  });

  it('changeTeacher preserves the schedule\'s days/time/course/subject unchanged', async () => {
    const f = await seedFixtures();
    const teacherB = await seedFixtures();
    await grantAvailabilityAndCapacity(f.teacherId, { days: [2, 4], startTime: '14:00', endTime: '15:00' });
    await grantAvailabilityAndCapacity(teacherB.teacherId, { days: [2, 4], startTime: '14:00', endTime: '15:00' });

    const first = await createAllocation(
      ctx,
      {
        enrollmentId: f.enrollmentId,
        teacherId: f.teacherId,
        allocationType: 'new_admission',
        reason: 'initial',
        requestedBy: SYSTEM_ACTOR,
        schedule: {
          sessionType: 'one_to_one',
          courseId: f.courseId,
          subjectId: f.subjectId,
          daysOfWeek: [2, 4],
          startTime: '14:00',
          endTime: '15:00',
          timezone: 'Asia/Kolkata',
          startDate: '2026-09-08',
        },
      },
      db,
    );

    const changed = await changeTeacher(
      ctx,
      { enrollmentId: f.enrollmentId, newTeacherId: teacherB.teacherId, reason: 'reassign', requestedBy: SYSTEM_ACTOR },
      db,
    );

    expect(changed.schedule.daysOfWeek).toEqual(first.schedule.daysOfWeek);
    expect(changed.schedule.startTime).toBe(first.schedule.startTime);
    expect(changed.schedule.endTime).toBe(first.schedule.endTime);
    expect(changed.schedule.courseId).toBe(first.schedule.courseId);
    expect(changed.schedule.teacherId).toBe(teacherB.teacherId);
  });
});

describe('transferOwnership — DD §14', () => {
  it('creates a fresh assignment with no previous owner and no change reason on the new row', async () => {
    const f = await seedFixtures();
    const result = await transferOwnership(
      ctx,
      {
        studentId: f.studentId,
        employeeId: f.employeeId,
        ownershipRole: 'onboarding',
        reason: 'initial assignment at admission handover',
        requestedBy: SYSTEM_ACTOR,
      },
      db,
    );

    expect(result.previous).toBeNull();
    expect(result.current.isCurrent).toBe(true);
    expect(result.current.employeeId).toBe(f.employeeId);
    expect(result.current.changeReason).toBeNull();
  });

  it('supersedes the previous owner and logs the reason + effective date — never overwrites', async () => {
    const f = await seedFixtures();
    const employeeB = await seedFixtures();

    const first = await transferOwnership(
      ctx,
      {
        studentId: f.studentId,
        employeeId: f.employeeId,
        ownershipRole: 'student_success',
        reason: 'initial',
        requestedBy: SYSTEM_ACTOR,
      },
      db,
    );

    const second = await transferOwnership(
      ctx,
      {
        studentId: f.studentId,
        employeeId: employeeB.employeeId,
        ownershipRole: 'student_success',
        reason: 'handover to specialised retention coordinator',
        requestedBy: SYSTEM_ACTOR,
      },
      db,
    );

    expect(second.previous?.id).toBe(first.current.id);
    expect(second.current.employeeId).toBe(employeeB.employeeId);
    expect(second.current.isCurrent).toBe(true);

    const oldRow = await pool.query('SELECT * FROM coordinator_ownership WHERE id = $1', [first.current.id]);
    expect(oldRow.rows[0].is_current).toBe(false);
    expect(oldRow.rows[0].change_reason).toBe('handover to specialised retention coordinator');
    expect(oldRow.rows[0].valid_to).not.toBeNull();
    expect(oldRow.rows[0].superseded_by_id).toBe(second.current.id);

    // Full history is reconstructable, in order (rule 12 applied to ownership).
    const history = await getOwnershipHistory(f.studentId, db);
    const forRole = history.filter((h) => h.ownershipRole === 'student_success');
    expect(forRole).toHaveLength(2);
    expect(forRole[0]?.employeeId).toBe(f.employeeId);
    expect(forRole[1]?.employeeId).toBe(employeeB.employeeId);
  });

  it('rejects a "transfer" to the employee who already holds it', async () => {
    const f = await seedFixtures();
    await transferOwnership(
      ctx,
      { studentId: f.studentId, employeeId: f.employeeId, ownershipRole: 'operations', reason: 'initial', requestedBy: SYSTEM_ACTOR },
      db,
    );

    await expect(
      transferOwnership(
        ctx,
        {
          studentId: f.studentId,
          employeeId: f.employeeId,
          ownershipRole: 'operations',
          reason: 'redundant',
          requestedBy: SYSTEM_ACTOR,
        },
        db,
      ),
    ).rejects.toBeInstanceOf(OwnershipError);
  });

  it('rejects a transfer with no reason', async () => {
    const f = await seedFixtures();
    await expect(
      transferOwnership(
        ctx,
        { studentId: f.studentId, employeeId: f.employeeId, ownershipRole: 'academic', reason: '', requestedBy: SYSTEM_ACTOR },
        db,
      ),
    ).rejects.toBeInstanceOf(OwnershipError);
  });

  it('allows one student to hold simultaneous current owners across different roles', async () => {
    const f = await seedFixtures();
    const employeeB = await seedFixtures();

    await transferOwnership(
      ctx,
      { studentId: f.studentId, employeeId: f.employeeId, ownershipRole: 'onboarding', reason: 'r1', requestedBy: SYSTEM_ACTOR },
      db,
    );
    await transferOwnership(
      ctx,
      { studentId: f.studentId, employeeId: employeeB.employeeId, ownershipRole: 'ticket', reason: 'r2', requestedBy: SYSTEM_ACTOR },
      db,
    );

    const history = await getOwnershipHistory(f.studentId, db);
    expect(history.filter((h) => h.isCurrent)).toHaveLength(2);
  });
});
