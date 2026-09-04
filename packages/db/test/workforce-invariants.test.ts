/**
 * Integration tests for the workforce/operations constraints added in
 * migrations 0009-0014, against a real PostgreSQL instance.
 *
 * CLAUDE.md §6: every migration that adds a constraint or trigger gets a test
 * proving the constraint REJECTS the bad case.
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

async function withoutActor<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

/** Student + employee + teacher + course/subject/level + enrollment, all unique per call. */
async function seedFixtures(opts: { teacherEligible?: boolean } = {}) {
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
      subjectId: subj.rows[0].id as string,
      levelId: lvl.rows[0].id as string,
      courseId: crs.rows[0].id as string,
      studentId: student.rows[0].id as string,
      employeeId: employee.rows[0].id as string,
      teacherId: teacher.rows[0].id as string,
      teacherPublicId: teacher.rows[0].public_id as string,
      enrollmentId: enrollment.rows[0].id as string,
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

describe('employee / teacher (DD §29, §11)', () => {
  it('issues teacher ids in the TCH-YYYY-NNNNNN format', async () => {
    const f = await seedFixtures();
    const { rows } = await pool.query('SELECT public_id FROM teacher WHERE id = $1', [f.teacherId]);
    expect(rows[0].public_id).toMatch(/^TCH-\d{4}-\d{6}$/);
  });

  it('REJECTS a teacher marked eligible with no reason (rule 25 justification requirement)', async () => {
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO teacher (full_name, is_allocation_eligible, created_by, updated_by)
           VALUES ('No Reason', true, $1, $1)`,
          [SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/teacher_eligibility_reason_required/);
  });

  it('REJECTS hard deletion of a teacher (rule 13)', async () => {
    const f = await seedFixtures();
    await expect(
      asActor((c) => c.query('DELETE FROM teacher WHERE id = $1', [f.teacherId])),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('archives a teacher via archive_record with employment_status, not status', async () => {
    const f = await seedFixtures();
    await asActor((c) => c.query(`SELECT archive_record('teacher', $1::uuid, 'onboarding cancelled')`, [f.teacherId]));
    const { rows } = await pool.query('SELECT employment_status FROM teacher WHERE id = $1', [f.teacherId]);
    expect(rows[0].employment_status).toBe('archived');
  });

  it('allows an ordinary DELETE on a teacher_subject capability tag (deliberate exception)', async () => {
    const f = await seedFixtures();
    await asActor((c) =>
      c.query(
        `INSERT INTO teacher_subject (teacher_id, subject_id, created_by, updated_by) VALUES ($1, $2, $3, $3)`,
        [f.teacherId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await asActor((c) => c.query('DELETE FROM teacher_subject WHERE teacher_id = $1', [f.teacherId]));
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM teacher_subject WHERE teacher_id = $1', [f.teacherId]);
    expect(rows[0].n).toBe(0);
    // Still attributable — the audit trigger runs regardless of the delete-guard exception.
    const audit = await pool.query(
      `SELECT action FROM audit.audit_event WHERE entity_type='teacher_subject' AND record_id IS NOT NULL ORDER BY occurred_at`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['INSERT', 'DELETE']));
  });
});

describe('teacher_capacity (DD §12.2)', () => {
  it('REJECTS allocated+reserved exceeding planned capacity (within-plan backstop)', async () => {
    const f = await seedFixtures();
    await asActor((c) =>
      c.query(
        `INSERT INTO teacher_capacity (teacher_id, day_of_week, start_time, end_time, planned_capacity_minutes, created_by, updated_by)
         VALUES ($1, 1, '09:00', '10:00', 60, $2, $2)`,
        [f.teacherId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `UPDATE teacher_capacity SET allocated_capacity_minutes = 61 WHERE teacher_id = $1`,
          [f.teacherId],
        ),
      ),
    ).rejects.toThrow(/teacher_capacity_within_plan/);
  });

  it('REJECTS two capacity rows for the same teacher/day/time-window with overlapping periods', async () => {
    const f = await seedFixtures();
    await asActor((c) =>
      c.query(
        `INSERT INTO teacher_capacity (teacher_id, day_of_week, start_time, end_time, planned_capacity_minutes, created_by, updated_by)
         VALUES ($1, 2, '11:00', '12:00', 60, $2, $2)`,
        [f.teacherId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO teacher_capacity (teacher_id, day_of_week, start_time, end_time, planned_capacity_minutes, created_by, updated_by)
           VALUES ($1, 2, '11:00', '12:00', 30, $2, $2)`,
          [f.teacherId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/teacher_capacity_no_overlap/);
  });

  it('free_capacity_minutes is a correctly-computed generated column', async () => {
    const f = await seedFixtures();
    await asActor((c) =>
      c.query(
        `INSERT INTO teacher_capacity (teacher_id, day_of_week, start_time, end_time, planned_capacity_minutes, allocated_capacity_minutes, reserved_minutes, created_by, updated_by)
         VALUES ($1, 3, '14:00', '15:00', 60, 20, 10, $2, $2)`,
        [f.teacherId, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await pool.query(
      'SELECT free_capacity_minutes FROM teacher_capacity WHERE teacher_id = $1',
      [f.teacherId],
    );
    expect(rows[0].free_capacity_minutes).toBe(30);
  });
});

describe('teacher_allocation (DD §13, rule 9, rule 25)', () => {
  it('REJECTS an active allocation for an ineligible teacher (rule 25 DB backstop)', async () => {
    const f = await seedFixtures({ teacherEligible: false });
    const schedule = await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[1]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
         RETURNING id`,
        [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO teacher_allocation (enrollment_id, student_id, teacher_id, class_schedule_id, allocation_type, reason, requested_by, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 'new_admission', 'test', $5, 'active', $5, $5)`,
          [f.enrollmentId, f.studentId, f.teacherId, schedule.rows[0].id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/not allocation-eligible/);
  });

  it('REJECTS a second CURRENT allocation for the same enrollment', async () => {
    const f = await seedFixtures();
    const sched1 = await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[1]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
         RETURNING id`,
        [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await asActor((c) =>
      c.query(
        `INSERT INTO teacher_allocation (enrollment_id, student_id, teacher_id, class_schedule_id, allocation_type, reason, requested_by, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'new_admission', 'first', $5, 'active', $5, $5)`,
        [f.enrollmentId, f.studentId, f.teacherId, sched1.rows[0].id, SYSTEM_ACTOR],
      ),
    );
    // A second class_schedule would itself violate class_schedule_current_uq
    // first if is_current weren't set false — supersede it explicitly here so
    // this test isolates the ALLOCATION uniqueness constraint specifically.
    await asActor((c) =>
      c.query(`UPDATE class_schedule SET is_current = false, valid_to = now() WHERE id = $1`, [sched1.rows[0].id]),
    );
    const sched2 = await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[2]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
         RETURNING id`,
        [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO teacher_allocation (enrollment_id, student_id, teacher_id, class_schedule_id, allocation_type, reason, requested_by, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 'schedule_change', 'second, both current', $5, 'active', $5, $5)`,
          [f.enrollmentId, f.studentId, f.teacherId, sched2.rows[0].id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/teacher_allocation_current_uq/);
  });

  it('REJECTS an allocation whose student does not match its enrollment', async () => {
    const f = await seedFixtures();
    const other = await seedFixtures();
    const sched = await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[1]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
         RETURNING id`,
        [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO teacher_allocation (enrollment_id, student_id, teacher_id, class_schedule_id, allocation_type, reason, requested_by, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 'new_admission', 'mismatched student', $5, 'active', $5, $5)`,
          [f.enrollmentId, other.studentId, f.teacherId, sched.rows[0].id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/does not match enrollment/);
  });

  it('REJECTS an allocation whose class_schedule belongs to a different enrollment', async () => {
    const f = await seedFixtures();
    const other = await seedFixtures();
    const otherSched = await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[1]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
         RETURNING id`,
        [other.enrollmentId, other.teacherId, other.courseId, other.subjectId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO teacher_allocation (enrollment_id, student_id, teacher_id, class_schedule_id, allocation_type, reason, requested_by, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 'new_admission', 'mismatched schedule', $5, 'active', $5, $5)`,
          [f.enrollmentId, f.studentId, f.teacherId, otherSched.rows[0].id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/does not match class_schedule/);
  });

  it('a blocked allocation attempt does NOT durably self-log via record_blocked (docs/data-model 04 §1b)', async () => {
    // Documents the real limitation found during verification: the guard
    // trigger's RAISE EXCEPTION rolls back the whole transaction, so nothing
    // written earlier in it (including a record_blocked call) survives. This
    // test would fail if someone "fixed" the trigger by re-adding that call
    // without understanding why it was removed.
    const f = await seedFixtures({ teacherEligible: false });
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE outcome='blocked' AND entity_type='teacher_allocation'`,
    );
    const sched = await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[4]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
         RETURNING id`,
        [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO teacher_allocation (enrollment_id, student_id, teacher_id, class_schedule_id, allocation_type, reason, requested_by, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 'new_admission', 'ineligible', $5, 'active', $5, $5)`,
          [f.enrollmentId, f.studentId, f.teacherId, sched.rows[0].id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE outcome='blocked' AND entity_type='teacher_allocation'`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('class_schedule (DD §15)', () => {
  it('REJECTS a second CURRENT schedule for the same enrollment', async () => {
    const f = await seedFixtures();
    await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[1]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)`,
        [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, ARRAY[2]::smallint[], '11:00', '12:00', 'Asia/Kolkata', current_date, 'active', $5, $5)`,
          [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/class_schedule_current_uq/);
  });

  it('REJECTS a days_of_week value outside 0-6', async () => {
    const f = await seedFixtures();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, ARRAY[7]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)`,
          [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/class_schedule_days_valid/);
  });

  it('REJECTS an empty days_of_week array', async () => {
    const f = await seedFixtures();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, ARRAY[]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)`,
          [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/class_schedule_days_non_empty/);
  });
});

describe('session (DD §16, rule 1)', () => {
  it('REJECTS overlapping sessions for the same teacher (double-booking)', async () => {
    const f = await seedFixtures();
    const sched = await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[1]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
         RETURNING id`,
        [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await asActor((c) =>
      c.query(
        `INSERT INTO session (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '2026-09-07 09:00+05:30', '2026-09-07 10:00+05:30', $5, $5)`,
        [sched.rows[0].id, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO session (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, created_by, updated_by)
           VALUES ($1, $2, $3, $4, '2026-09-07 09:30+05:30', '2026-09-07 10:30+05:30', $5, $5)`,
          [sched.rows[0].id, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/session_no_teacher_double_booking/);
  });

  it('allows back-to-back (non-overlapping) sessions for the same teacher', async () => {
    const f = await seedFixtures();
    const sched = await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[1]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
         RETURNING id`,
        [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await asActor((c) =>
      c.query(
        `INSERT INTO session (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '2026-09-07 09:00+05:30', '2026-09-07 10:00+05:30', $5, $5)`,
        [sched.rows[0].id, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
      ),
    );
    await asActor((c) =>
      c.query(
        `INSERT INTO session (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '2026-09-07 10:00+05:30', '2026-09-07 11:00+05:30', $5, $5)`,
        [sched.rows[0].id, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM session WHERE teacher_id = $1', [f.teacherId]);
    expect(rows[0].n).toBe(2);
  });

  it('a cancelled session does not block a new one at the same time (exclusion WHERE clause)', async () => {
    const f = await seedFixtures();
    const sched = await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[1]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
         RETURNING id`,
        [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await asActor((c) =>
      c.query(
        `INSERT INTO session (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, status, cancellation_reason, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '2026-09-07 09:00+05:30', '2026-09-07 10:00+05:30', 'cancelled', 'teacher sick', $5, $5)`,
        [sched.rows[0].id, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
      ),
    );
    await asActor((c) =>
      c.query(
        `INSERT INTO session (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '2026-09-07 09:00+05:30', '2026-09-07 10:00+05:30', $5, $5)`,
        [sched.rows[0].id, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM session WHERE teacher_id = $1', [f.teacherId]);
    expect(rows[0].n).toBe(2);
  });

  it('REJECTS a cancelled session with no cancellation_reason', async () => {
    const f = await seedFixtures();
    const sched = await asActor((c) =>
      c.query(
        `INSERT INTO class_schedule (enrollment_id, teacher_id, course_id, subject_id, days_of_week, start_time, end_time, timezone, start_date, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, ARRAY[1]::smallint[], '09:00', '10:00', 'Asia/Kolkata', current_date, 'active', $5, $5)
         RETURNING id`,
        [f.enrollmentId, f.teacherId, f.courseId, f.subjectId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO session (class_schedule_id, enrollment_id, student_id, teacher_id, scheduled_start_at, scheduled_end_at, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, '2026-09-07 09:00+05:30', '2026-09-07 10:00+05:30', 'cancelled', $5, $5)`,
          [sched.rows[0].id, f.enrollmentId, f.studentId, f.teacherId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/session_cancellation_reason_required/);
  });
});

describe('coordinator_ownership (DD §14, rule 12)', () => {
  it('REJECTS a second CURRENT owner for the same (student, role)', async () => {
    const f = await seedFixtures();
    const other = await seedFixtures();
    await asActor((c) =>
      c.query(
        `INSERT INTO coordinator_ownership (student_id, employee_id, ownership_role, requested_by, created_by, updated_by)
         VALUES ($1, $2, 'onboarding', $3, $3, $3)`,
        [f.studentId, f.employeeId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO coordinator_ownership (student_id, employee_id, ownership_role, requested_by, created_by, updated_by)
           VALUES ($1, $2, 'onboarding', $3, $3, $3)`,
          [f.studentId, other.employeeId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/coordinator_ownership_current_uq/);
  });

  it('allows the SAME student to have simultaneous current owners under DIFFERENT roles', async () => {
    const f = await seedFixtures();
    const other = await seedFixtures();
    await asActor((c) =>
      c.query(
        `INSERT INTO coordinator_ownership (student_id, employee_id, ownership_role, requested_by, created_by, updated_by)
         VALUES ($1, $2, 'onboarding', $3, $3, $3)`,
        [f.studentId, f.employeeId, SYSTEM_ACTOR],
      ),
    );
    await asActor((c) =>
      c.query(
        `INSERT INTO coordinator_ownership (student_id, employee_id, ownership_role, requested_by, created_by, updated_by)
         VALUES ($1, $2, 'ticket', $3, $3, $3)`,
        [f.studentId, other.employeeId, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await pool.query(
      `SELECT ownership_role FROM coordinator_ownership WHERE student_id = $1 AND is_current ORDER BY ownership_role`,
      [f.studentId],
    );
    expect(rows.map((r) => r.ownership_role)).toEqual(['onboarding', 'ticket']);
  });

  it('REJECTS escalation_level set on a non-escalation role', async () => {
    const f = await seedFixtures();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO coordinator_ownership (student_id, employee_id, ownership_role, escalation_level, requested_by, created_by, updated_by)
           VALUES ($1, $2, 'onboarding', 2, $3, $3, $3)`,
          [f.studentId, f.employeeId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/coordinator_ownership_escalation_only_for_escalation/);
  });

  it('REJECTS hard deletion of an ownership record', async () => {
    const f = await seedFixtures();
    await asActor((c) =>
      c.query(
        `INSERT INTO coordinator_ownership (student_id, employee_id, ownership_role, requested_by, created_by, updated_by)
         VALUES ($1, $2, 'retention', $3, $3, $3)`,
        [f.studentId, f.employeeId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query('DELETE FROM coordinator_ownership WHERE student_id = $1', [f.studentId])),
    ).rejects.toThrow(/cannot be deleted/i);
  });
});
