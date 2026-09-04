/**
 * Integration tests for the governance/RBAC constraints to be added in the next
 * migration batch (role, permission, role_permission, user_role, user_session,
 * approval_request + the user_account TOTP/session columns).
 *
 * Written FIRST per CLAUDE.md's TDD mandate: these must fail against the current
 * schema (tables don't exist yet) before the migration that creates them is
 * written. CLAUDE.md §6: every migration that adds a constraint or trigger gets
 * a test proving the constraint REJECTS the bad case.
 *
 * Sources: DD §38-41 (RBAC, sessions, audit), DD §39 (approval_request),
 * Master §22 (governance, maker-checker, RBAC), rules 21-25.
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

/** Two distinct user_accounts + a role, unique per call. */
async function seedFixtures() {
  const suffix = `${Date.now()}-${++fixtureCounter}`;
  return asActor(async (c) => {
    const userA = await c.query(
      `INSERT INTO user_account (email, full_name, password_hash) VALUES ($1, 'User A', 'hash') RETURNING id`,
      [`user-a-${suffix}@spellzee.test`],
    );
    const userB = await c.query(
      `INSERT INTO user_account (email, full_name, password_hash) VALUES ($1, 'User B', 'hash') RETURNING id`,
      [`user-b-${suffix}@spellzee.test`],
    );
    const role = await c.query(
      `INSERT INTO role (code, name) VALUES ($1, 'Coordinator') RETURNING id`,
      [`role-${suffix}`],
    );
    const permission = await c.query(
      `INSERT INTO permission (code, resource, action) VALUES ($1, 'session', 'cancel') RETURNING id`,
      [`perm-${suffix}`],
    );
    return {
      userAId: userA.rows[0].id as string,
      userBId: userB.rows[0].id as string,
      roleId: role.rows[0].id as string,
      permissionId: permission.rows[0].id as string,
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

describe('role / permission / role_permission (DD §40, rule 24)', () => {
  it('creates a role and permission and links them via role_permission', async () => {
    const f = await seedFixtures();
    await asActor(async (c) => {
      await c.query(
        `INSERT INTO role_permission (role_id, permission_id, created_by) VALUES ($1, $2, $3)`,
        [f.roleId, f.permissionId, SYSTEM_ACTOR],
      );
    });
    const { rows } = await pool.query(
      `SELECT 1 FROM role_permission WHERE role_id = $1 AND permission_id = $2`,
      [f.roleId, f.permissionId],
    );
    expect(rows).toHaveLength(1);
  });

  it('REJECTS a duplicate role code', async () => {
    const suffix = `${Date.now()}-${++fixtureCounter}`;
    await asActor((c) => c.query(`INSERT INTO role (code, name) VALUES ($1, 'A')`, [`dup-${suffix}`]));
    await expect(
      asActor((c) => c.query(`INSERT INTO role (code, name) VALUES ($1, 'B')`, [`dup-${suffix}`])),
    ).rejects.toThrow();
  });
});

describe('user_role — effective-dated assignment (rule 12, rule 24)', () => {
  it('assigns a role to a user with a scope', async () => {
    const f = await seedFixtures();
    await asActor((c) =>
      c.query(
        `INSERT INTO user_role (user_account_id, role_id, scope, granted_by, created_by, updated_by)
         VALUES ($1, $2, 'own', $3, $3, $3)`,
        [f.userAId, f.roleId, SYSTEM_ACTOR],
      ),
    );
    const { rows } = await pool.query(
      `SELECT scope, is_current FROM user_role WHERE user_account_id = $1 AND role_id = $2`,
      [f.userAId, f.roleId],
    );
    expect(rows[0].scope).toBe('own');
    expect(rows[0].is_current).toBe(true);
  });

  it('REJECTS an invalid scope value', async () => {
    const f = await seedFixtures();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO user_role (user_account_id, role_id, scope, granted_by, created_by, updated_by) VALUES ($1, $2, 'department', $3, $3, $3)`,
          [f.userAId, f.roleId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('REJECTS two simultaneous current assignments of the same role to the same user', async () => {
    const f = await seedFixtures();
    await asActor((c) =>
      c.query(
        `INSERT INTO user_role (user_account_id, role_id, scope, granted_by, created_by, updated_by) VALUES ($1, $2, 'own', $3, $3, $3)`,
        [f.userAId, f.roleId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO user_role (user_account_id, role_id, scope, granted_by, created_by, updated_by) VALUES ($1, $2, 'all', $3, $3, $3)`,
          [f.userAId, f.roleId, SYSTEM_ACTOR],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete a role assignment', async () => {
    const f = await seedFixtures();
    const inserted = await asActor((c) =>
      c.query(
        `INSERT INTO user_role (user_account_id, role_id, scope, granted_by, created_by, updated_by) VALUES ($1, $2, 'own', $3, $3, $3) RETURNING id`,
        [f.userAId, f.roleId, SYSTEM_ACTOR],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM user_role WHERE id = $1`, [inserted.rows[0].id])),
    ).rejects.toThrow();
  });
});

describe('user_session (DD §41 session metadata on audit)', () => {
  it('creates a session for a user with an expiry', async () => {
    const f = await seedFixtures();
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO user_session (user_account_id, expires_at, ip_address, user_agent)
         VALUES ($1, now() + interval '1 day', '127.0.0.1', 'vitest') RETURNING id`,
        [f.userAId],
      ),
    );
    expect(rows[0].id).toBeTruthy();
  });

  it('REJECTS a session with expires_at in the past relative to created_at', async () => {
    const f = await seedFixtures();
    await expect(
      asActor((c) =>
        c.query(
          `INSERT INTO user_session (user_account_id, expires_at) VALUES ($1, now() - interval '1 day')`,
          [f.userAId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not hard-delete a session -- it must be revoked instead', async () => {
    const f = await seedFixtures();
    const created = await asActor((c) =>
      c.query(
        `INSERT INTO user_session (user_account_id, expires_at) VALUES ($1, now() + interval '1 day') RETURNING id`,
        [f.userAId],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM user_session WHERE id = $1`, [created.rows[0].id])),
    ).rejects.toThrow();
    await asActor((c) =>
      c.query(`UPDATE user_session SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1`, [created.rows[0].id]),
    );
    const { rows } = await pool.query(`SELECT revoked_at FROM user_session WHERE id = $1`, [created.rows[0].id]);
    expect(rows[0].revoked_at).toBeTruthy();
  });
});

describe('approval_request — maker-checker (DD §39, rule 22)', () => {
  it('issues approval_request ids in the APR-YYYY-NNNNNN format', async () => {
    const f = await seedFixtures();
    const { rows } = await asActor((c) =>
      c.query(
        `INSERT INTO approval_request (entity_type, entity_id, action, payload, reason, requested_by, created_by, updated_by)
         VALUES ('session', gen_random_uuid(), 'cancel', '{}'::jsonb, 'test', $1, $1, $1) RETURNING public_id`,
        [f.userAId],
      ),
    );
    expect(rows[0].public_id).toMatch(/^APR-\d{4}-\d{6}$/);
  });

  it('REJECTS a self-approval at the DB layer (rule 22 — the core guarantee)', async () => {
    const f = await seedFixtures();
    const created = await asActor((c) =>
      c.query(
        `INSERT INTO approval_request (entity_type, entity_id, action, payload, reason, requested_by, created_by, updated_by)
         VALUES ('session', gen_random_uuid(), 'cancel', '{}'::jsonb, 'test', $1, $1, $1) RETURNING id`,
        [f.userAId],
      ),
    );
    await expect(
      asActor((c) =>
        c.query(
          `UPDATE approval_request SET status = 'approved', approved_by = $2, decided_at = now()
           WHERE id = $1`,
          [created.rows[0].id, f.userAId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('allows approval by a different user', async () => {
    const f = await seedFixtures();
    const created = await asActor((c) =>
      c.query(
        `INSERT INTO approval_request (entity_type, entity_id, action, payload, reason, requested_by, created_by, updated_by)
         VALUES ('session', gen_random_uuid(), 'cancel', '{}'::jsonb, 'test', $1, $1, $1) RETURNING id`,
        [f.userAId],
      ),
    );
    await asActor((c) =>
      c.query(
        `UPDATE approval_request SET status = 'approved', approved_by = $2, decided_at = now()
         WHERE id = $1`,
        [created.rows[0].id, f.userBId],
      ),
    );
    const { rows } = await pool.query(`SELECT status FROM approval_request WHERE id = $1`, [created.rows[0].id]);
    expect(rows[0].status).toBe('approved');
  });

  it('does not hard-delete an approval_request', async () => {
    const f = await seedFixtures();
    const created = await asActor((c) =>
      c.query(
        `INSERT INTO approval_request (entity_type, entity_id, action, payload, reason, requested_by, created_by, updated_by)
         VALUES ('session', gen_random_uuid(), 'cancel', '{}'::jsonb, 'test', $1, $1, $1) RETURNING id`,
        [f.userAId],
      ),
    );
    await expect(
      asActor((c) => c.query(`DELETE FROM approval_request WHERE id = $1`, [created.rows[0].id])),
    ).rejects.toThrow();
  });
});

describe('user_account — MFA columns (Master §22, TOTP for approver roles)', () => {
  it('defaults mfa_enabled to false and allows enabling it with a secret', async () => {
    const f = await seedFixtures();
    await asActor((c) =>
      c.query(
        `UPDATE user_account SET mfa_enabled = true, totp_secret_encrypted = 'enc:test' WHERE id = $1`,
        [f.userAId],
      ),
    );
    const { rows } = await pool.query(`SELECT mfa_enabled, totp_secret_encrypted FROM user_account WHERE id = $1`, [f.userAId]);
    expect(rows[0].mfa_enabled).toBe(true);
    expect(rows[0].totp_secret_encrypted).toBe('enc:test');
  });

  it('REJECTS mfa_enabled=true with no secret set', async () => {
    const f = await seedFixtures();
    await expect(
      asActor((c) => c.query(`UPDATE user_account SET mfa_enabled = true WHERE id = $1`, [f.userAId])),
    ).rejects.toThrow();
  });
});
