/**
 * Integration tests against a real PostgreSQL instance.
 *
 * CLAUDE.md §6: every migration that adds a constraint or trigger gets a test
 * proving the constraint REJECTS the bad case. These constraints are business
 * logic — a mocked database tests none of them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

/** Runs a statement with the actor context set, as the application would. */
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

/** Runs without setting an actor — should be refused on any audited table. */
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

async function seedStudent(name = 'Aarav Sharma'): Promise<{ id: string; publicId: string }> {
  return asActor(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO student (full_name, created_by, updated_by)
       VALUES ($1, $2, $2) RETURNING id, public_id`,
      [name, SYSTEM_ACTOR],
    );
    return { id: rows[0].id, publicId: rows[0].public_id };
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

describe('identifier standard (DD §4)', () => {
  it('issues student ids in the STU-YYYY-NNNNNN format', async () => {
    const s = await seedStudent();
    expect(s.publicId).toMatch(/^STU-\d{4}-\d{6}$/);
  });

  it('increments the sequence per prefix per year', async () => {
    const a = await seedStudent('First Child');
    const b = await seedStudent('Second Child');
    const seqA = Number(a.publicId.split('-')[2]);
    const seqB = Number(b.publicId.split('-')[2]);
    expect(seqB).toBe(seqA + 1);
  });

  it('REJECTS any attempt to change a student public_id (rule 1)', async () => {
    const s = await seedStudent();
    await expect(
      asActor((c) =>
        c.query(`UPDATE student SET public_id = 'STU-2026-999999' WHERE id = $1`, [s.id]),
      ),
    ).rejects.toThrow(/immutable/i);
  });
});

describe('audit capture (DD §41, rule 21)', () => {
  it('writes an audit row automatically on insert', async () => {
    const s = await seedStudent();
    const { rows } = await pool.query(
      `SELECT action, entity_type, new_value, old_value, source, outcome
       FROM audit.audit_event WHERE record_id = $1`,
      [s.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('INSERT');
    expect(rows[0].entity_type).toBe('student');
    expect(rows[0].old_value).toBeNull();
    expect(rows[0].new_value.full_name).toBe('Aarav Sharma');
    expect(rows[0].outcome).toBe('success');
  });

  it('writes an audit row automatically on update, with old and new values', async () => {
    const s = await seedStudent();
    await asActor((c) =>
      c.query(`UPDATE student SET preferred_name = 'Aarav' WHERE id = $1`, [s.id]),
    );

    const { rows } = await pool.query(
      `SELECT action, old_value, new_value, changed_fields
       FROM audit.audit_event WHERE record_id = $1 AND action = 'UPDATE'`,
      [s.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].old_value.preferred_name).toBeNull();
    expect(rows[0].new_value.preferred_name).toBe('Aarav');
    expect(rows[0].changed_fields).toEqual(['preferred_name']);
  });

  it('does not write a noise row when nothing of substance changed', async () => {
    const s = await seedStudent();
    await asActor((c) =>
      c.query(`UPDATE student SET full_name = full_name WHERE id = $1`, [s.id]),
    );
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit.audit_event WHERE record_id = $1 AND action = 'UPDATE'`,
      [s.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('REFUSES a write when no actor is set', async () => {
    await expect(
      withoutActor((c) =>
        c.query(
          `INSERT INTO student (full_name, created_by, updated_by) VALUES ('Anonymous', $1, $1)`,
          [SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/app\.actor_id is not set/i);
  });

  it('REJECTS updating an audit row (rule 23)', async () => {
    const s = await seedStudent();
    await expect(
      pool.query(`UPDATE audit.audit_event SET reason = 'tampered' WHERE record_id = $1`, [s.id]),
    ).rejects.toThrow(/append-only/i);
  });

  it('REJECTS deleting an audit row (rule 23)', async () => {
    const s = await seedStudent();
    await expect(
      pool.query(`DELETE FROM audit.audit_event WHERE record_id = $1`, [s.id]),
    ).rejects.toThrow(/append-only/i);
  });
});

describe('soft delete (rule 13, DD §2)', () => {
  it('REJECTS hard deletion of a student', async () => {
    const s = await seedStudent();
    await expect(asActor((c) => c.query('DELETE FROM student WHERE id = $1', [s.id]))).rejects.toThrow(
      /cannot be deleted/i,
    );
  });

  it('archives with a reason instead', async () => {
    const s = await seedStudent();
    await asActor((c) => c.query(`SELECT archive_record('student', $1::uuid, 'created in error')`, [s.id]));

    const { rows } = await pool.query(
      'SELECT status, archived_at, archived_by, archive_reason FROM student WHERE id = $1',
      [s.id],
    );
    expect(rows[0].status).toBe('archived');
    expect(rows[0].archived_at).not.toBeNull();
    expect(rows[0].archive_reason).toBe('created in error');
  });

  it('REJECTS archiving without a reason (Master §22.5)', async () => {
    const s = await seedStudent();
    await expect(
      asActor((c) => c.query(`SELECT archive_record('student', $1::uuid, '')`, [s.id])),
    ).rejects.toThrow(/reason is required/i);
  });

  it('hides archived students from the active view', async () => {
    const s = await seedStudent();
    await asActor((c) => c.query(`SELECT archive_record('student', $1::uuid, 'duplicate')`, [s.id]));
    const { rows } = await pool.query('SELECT 1 FROM v_active_student WHERE id = $1', [s.id]);
    expect(rows).toHaveLength(0);
  });
});

describe('identity rules (DD §6.3, §7)', () => {
  it('REJECTS a student merged into itself', async () => {
    const s = await seedStudent();
    await expect(
      asActor((c) =>
        c.query(
          `UPDATE student SET status='merged', merged_into_student_id=$1, merged_at=now() WHERE id=$1`,
          [s.id],
        ),
      ),
    ).rejects.toThrow(/student_not_merged_into_self|student_merge_consistent/);
  });

  it('REJECTS a merge where requester and approver are the same person (rule 22)', async () => {
    const a = await seedStudent('Dup A');
    const b = await seedStudent('Dup B');
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO merge_event
             (source_student_id, target_student_id, reason, requested_by, approved_by, created_by, updated_by)
           VALUES ($1, $2, 'duplicate', $3, $3, $3, $3)`,
          [a.id, b.id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/merge_event_no_self_approval/);
  });

  it('retains the source student after a merge (rule 4)', async () => {
    const a = await seedStudent('Retained Source');
    const b = await seedStudent('Surviving Target');
    await asActor((c) =>
      c.query(
        `UPDATE student SET status='merged', merged_into_student_id=$2, merged_at=now() WHERE id=$1`,
        [a.id, b.id],
      ),
    );
    const { rows } = await pool.query('SELECT status, merged_into_student_id FROM student WHERE id=$1', [
      a.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('merged');
    expect(rows[0].merged_into_student_id).toBe(b.id);
  });

  it('enforces exactly one primary guardian per student (DD §5)', async () => {
    const s = await seedStudent();
    const parents = await asActor(async (c) => {
      const p1 = await c.query(
        `INSERT INTO parent_guardian (full_name, created_by, updated_by) VALUES ('Priya', $1, $1) RETURNING id`,
        [SYSTEM_ACTOR],
      );
      const p2 = await c.query(
        `INSERT INTO parent_guardian (full_name, created_by, updated_by) VALUES ('Ramesh', $1, $1) RETURNING id`,
        [SYSTEM_ACTOR],
      );
      return [p1.rows[0].id, p2.rows[0].id];
    });

    await asActor((c) =>
      c.query(
        `INSERT INTO student_parent_link
           (student_id, parent_guardian_id, relationship_type, is_primary_contact, created_by, updated_by)
         VALUES ($1, $2, 'parent', true, $3, $3)`,
        [s.id, parents[0], SYSTEM_ACTOR],
      ),
    );

    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO student_parent_link
             (student_id, parent_guardian_id, relationship_type, is_primary_contact, created_by, updated_by)
           VALUES ($1, $2, 'parent', true, $3, $3)`,
          [s.id, parents[1], SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/student_parent_link_one_primary_uq/);
  });

  it('normalises contact values for matching (DD §7)', async () => {
    const s = await seedStudent();
    await asActor((c) =>
      c.query(
        `INSERT INTO contact_history (student_id, contact_type, value, created_by, updated_by)
         VALUES ($1, 'phone', '+91 98765 43210', $2, $2)`,
        [s.id, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await pool.query(
      'SELECT value_normalized FROM contact_history WHERE student_id = $1',
      [s.id],
    );
    expect(rows[0].value_normalized).toBe('9876543210');
  });

  it('REJECTS a contact row owned by both a student and a parent', async () => {
    const s = await seedStudent();
    const p = await asActor(async (c) => {
      const r = await c.query(
        `INSERT INTO parent_guardian (full_name, created_by, updated_by) VALUES ('Both', $1, $1) RETURNING id`,
        [SYSTEM_ACTOR],
      );
      return r.rows[0].id;
    });

    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO contact_history (student_id, parent_guardian_id, contact_type, value, created_by, updated_by)
           VALUES ($1, $2, 'phone', '9876543210', $3, $3)`,
          [s.id, p, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/contact_history_one_owner/);
  });
});

describe('commercial invariants (DD §8, §9, §10)', () => {
  // Each `it()` in this block calls this fixture independently and each write
  // commits (via asActor), so a fixed code would collide the second time this
  // runs — a unique suffix per call keeps the fixtures isolated.
  let fixtureCounter = 0;

  async function seedCommercialFixtures() {
    const suffix = `${Date.now()}-${++fixtureCounter}`;
    return asActor(async (c) => {
      const subj = await c.query(
        `INSERT INTO subject (code, name) VALUES ($1, 'English') RETURNING id`,
        [`ENG-${suffix}`],
      );
      const lvl = await c.query(
        `INSERT INTO level (code, name) VALUES ($1, 'Level 1') RETURNING id`,
        [`L1-${suffix}`],
      );
      const crs = await c.query(
        `INSERT INTO course (code, name, subject_id, default_duration_minutes)
         VALUES ($1, 'English Beginner', $2, 60) RETURNING id`,
        [`ENG-BEG-${suffix}`, subj.rows[0].id],
      );
      return { subjectId: subj.rows[0].id, levelId: lvl.rows[0].id, courseId: crs.rows[0].id };
    });
  }

  it('REJECTS completing an enrollment without a reason (DD §8)', async () => {
    const s = await seedStudent();
    const f = await seedCommercialFixtures();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO enrollment
             (student_id, course_id, subject_id, level_id, start_date, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, current_date, 'completed', $5, $5)`,
          [s.id, f.courseId, f.subjectId, f.levelId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/enrollment_end_reason_required/);
  });

  it('REJECTS a subscription whose student differs from its enrollment', async () => {
    const a = await seedStudent('Student A');
    const b = await seedStudent('Student B');
    const f = await seedCommercialFixtures();

    const enrollmentId = await asActor(async (c) => {
      const r = await c.query(
        `INSERT INTO enrollment
           (student_id, course_id, subject_id, level_id, start_date, created_by, updated_by)
         VALUES ($1, $2, $3, $4, current_date, $5, $5) RETURNING id`,
        [a.id, f.courseId, f.subjectId, f.levelId, SYSTEM_ACTOR],
      );
      return r.rows[0].id;
    });

    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO subscription
             (student_id, enrollment_id, plan_name, purchased_session_count,
              price_minor_units, purchase_date, start_date, valid_until, created_by, updated_by)
           VALUES ($1, $2, '12 sessions', 12, 1200000, current_date, current_date,
                   current_date + 90, $3, $3)`,
          [b.id, enrollmentId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/does not match enrollment/i);
  });

  it('REJECTS rewriting the amount of a settled payment (DD §10)', async () => {
    const s = await seedStudent();
    const paymentId = await asActor(async (c) => {
      const r = await c.query(
        `INSERT INTO payment
           (student_id, amount_minor_units, payment_method, paid_at, status, created_by, updated_by)
         VALUES ($1, 1200000, 'upi', now(), 'settled', $2, $2) RETURNING id`,
        [s.id, SYSTEM_ACTOR],
      );
      return r.rows[0].id;
    });

    await expect(
      asActor((c) =>
        c.query('UPDATE payment SET amount_minor_units = 1 WHERE id = $1', [paymentId]),
      ),
    ).rejects.toThrow(/settled.*immutable/i);
  });

  it('allows a correction as a new adjustment row referencing the original', async () => {
    const s = await seedStudent();
    const original = await asActor(async (c) => {
      const r = await c.query(
        `INSERT INTO payment
           (student_id, amount_minor_units, payment_method, paid_at, status, created_by, updated_by)
         VALUES ($1, 1200000, 'upi', now(), 'settled', $2, $2) RETURNING id`,
        [s.id, SYSTEM_ACTOR],
      );
      return r.rows[0].id;
    });

    const refund = await asActor(async (c) => {
      const r = await c.query(
        `INSERT INTO payment
           (student_id, amount_minor_units, payment_method, paid_at, status,
            adjusts_payment_id, adjustment_type, adjustment_reason, created_by, updated_by)
         VALUES ($1, -600000, 'upi', now(), 'settled', $2, 'partial_refund',
                 'two sessions unused at cancellation', $3, $3) RETURNING id`,
        [s.id, original, SYSTEM_ACTOR],
      );
      return r.rows[0].id;
    });

    expect(refund).toBeTruthy();
  });

  it('REJECTS an adjustment without a stated reason', async () => {
    const s = await seedStudent();
    const original = await asActor(async (c) => {
      const r = await c.query(
        `INSERT INTO payment (student_id, amount_minor_units, payment_method, paid_at, created_by, updated_by)
         VALUES ($1, 1200000, 'upi', now(), $2, $2) RETURNING id`,
        [s.id, SYSTEM_ACTOR],
      );
      return r.rows[0].id;
    });

    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO payment
             (student_id, amount_minor_units, payment_method, paid_at, adjusts_payment_id, created_by, updated_by)
           VALUES ($1, -100, 'upi', now(), $2, $3, $3)`,
          [s.id, original, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/payment_adjustment_complete/);
  });

  it('REJECTS a self-approved payment (rule 22)', async () => {
    const s = await seedStudent();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO payment
             (student_id, amount_minor_units, payment_method, paid_at,
              requested_by, approved_by, approval_status, approved_at, created_by, updated_by)
           VALUES ($1, 1000, 'upi', now(), $2, $2, 'approved', now(), $2, $2)`,
          [s.id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/payment_no_self_approval/);
  });
});

describe('external id mapping (DD §42, rule 26)', () => {
  it('REJECTS mapping one external id to two Spellzee records', async () => {
    const a = await seedStudent('Ext A');
    const b = await seedStudent('Ext B');

    await asActor((c) =>
      c.query(
        `INSERT INTO external_id_map
           (spellzee_entity_type, spellzee_id, external_system, external_id, created_by, updated_by)
         VALUES ('student', $1, 'merithub', 'MH-123', $2, $2)`,
        [a.id, SYSTEM_ACTOR],
      ),
    );

    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO external_id_map
             (spellzee_entity_type, spellzee_id, external_system, external_id, created_by, updated_by)
           VALUES ('student', $1, 'merithub', 'MH-123', $2, $2)`,
          [b.id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/external_id_map_external_uq/);
  });

  it('REJECTS an error sync status with no error message', async () => {
    const s = await seedStudent();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO external_id_map
             (spellzee_entity_type, spellzee_id, external_system, external_id, sync_status, created_by, updated_by)
           VALUES ('student', $1, 'merithub', 'MH-999', 'error', $2, $2)`,
          [s.id, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow(/external_id_map_error_explained/);
  });

  it('confirms no core table carries an external id column (rule 26)', async () => {
    const { rows } = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name <> 'external_id_map'
        AND (column_name ILIKE '%merithub%'
          OR column_name ILIKE '%telicrm%'
          OR column_name ILIKE '%external_id%')
    `);
    expect(rows).toEqual([]);
  });
});

describe('migration ownership is bootstrap-role independent', () => {
  // These migrations were applied by `postgres` (the container's superuser) in
  // this test run, exactly as they would be by any bootstrapping role that
  // isn't spellzee_owner itself. If SECURITY DEFINER objects (the audit trigger,
  // ensure_partition) or their dependencies (identifier_sequence, audit_event)
  // aren't explicitly pinned to spellzee_owner, they silently inherit ownership
  // from whichever role ran the migration and lose the privileges they need on
  // each other. This is exactly the class of bug found during manual
  // verification: `next_public_id('AUD')`, called from inside the SECURITY
  // DEFINER audit trigger, failed with "permission denied for table
  // identifier_sequence" until ownership was pinned in migration 0001/0002.
  it('confirms audit.audit_event and identifier_sequence are owned by spellzee_owner', async () => {
    const { rows } = await pool.query(`
      SELECT c.relname, r.rolname AS owner
      FROM pg_class c
      JOIN pg_roles r ON r.oid = c.relowner
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname = 'audit' AND c.relname = 'audit_event')
         OR (n.nspname = 'public' AND c.relname = 'identifier_sequence')
      ORDER BY c.relname
    `);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relname: 'audit_event', owner: 'spellzee_owner' }),
        expect.objectContaining({ relname: 'identifier_sequence', owner: 'spellzee_owner' }),
      ]),
    );
  });

  it('lets an actor-only insert succeed end-to-end, proving the trigger can mint its own AUD- id', async () => {
    // This is the black-box version of the ownership check above: if any
    // SECURITY DEFINER object lost a needed grant, this insert -- not a
    // metadata query -- is what would fail.
    const s = await seedStudent('Ownership Regression Check');
    const { rows } = await pool.query(
      `SELECT public_id FROM audit.audit_event WHERE record_id = $1 AND action = 'INSERT'`,
      [s.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].public_id).toMatch(/^AUD-\d{4}-\d{6}$/);
  });
});
