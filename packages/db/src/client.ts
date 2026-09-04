/**
 * Database client and the actor-context mechanism.
 *
 * The audit trigger (DD §41) refuses any write when `app.actor_id` is unset. That
 * is deliberate: it makes attribution impossible to forget rather than merely
 * expected. `withActor()` is therefore the ONLY supported way to write.
 *
 * Reads may use `db` directly.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ActorContext {
  /** user_account.id — required. Service accounts count; anonymity does not. */
  actorId: string;
  /** user_session.id, when the write originates from a logged-in session. */
  sessionId?: string;
  /** Ties every write in one request/job/webhook together in the audit trail. */
  correlationId?: string;
  /** ui | api | job | migration | webhook:<system> */
  source?: 'ui' | 'api' | 'job' | 'migration' | `webhook:${string}`;
  /** Business reason, surfaced as audit_event.reason. */
  reason?: string;
  ip?: string;
  userAgent?: string;
}

let pool: pg.Pool | undefined;
let database: Database | undefined;

export function createPool(connectionString = process.env['DATABASE_URL']): pg.Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set.');
  }
  return new pg.Pool({
    connectionString,
    max: Number(process.env['DATABASE_POOL_MAX'] ?? 10),
    idleTimeoutMillis: 30_000,
    // Every timestamp is timestamptz; keep the driver from inventing local time.
    options: '-c timezone=UTC',
  });
}

export function getDb(): Database {
  if (!database) {
    pool = createPool();
    database = drizzle(pool, { schema });
  }
  return database;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  database = undefined;
}

/**
 * Runs `fn` inside a transaction with the actor context applied.
 *
 * `SET LOCAL` scopes the settings to this transaction, so they cannot leak to the
 * next borrower of the pooled connection — which would silently misattribute
 * someone else's writes.
 *
 * @example
 * await withActor({ actorId, source: 'ui', reason: 'Parent reported new number' }, async (tx) => {
 *   await tx.insert(contactHistory).values({ ... });
 * });
 */
export async function withActor<T>(
  ctx: ActorContext,
  fn: (tx: Transaction) => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  if (!ctx.actorId) {
    throw new Error(
      'withActor requires an actorId. Every write must be attributable (DD §41). ' +
        'Background jobs must supply a service-account id.',
    );
  }

  return db.transaction(async (tx) => {
    // set_config(..., true) is the parameterised equivalent of SET LOCAL, which
    // does not accept bind parameters.
    await tx.execute(sql`SELECT set_config('app.actor_id', ${ctx.actorId}, true)`);
    await tx.execute(
      sql`SELECT set_config('app.session_id', ${ctx.sessionId ?? ''}, true)`,
    );
    await tx.execute(
      sql`SELECT set_config('app.correlation_id', ${ctx.correlationId ?? ''}, true)`,
    );
    await tx.execute(sql`SELECT set_config('app.source', ${ctx.source ?? 'api'}, true)`);
    await tx.execute(sql`SELECT set_config('app.reason', ${ctx.reason ?? ''}, true)`);
    await tx.execute(sql`SELECT set_config('app.ip', ${ctx.ip ?? ''}, true)`);
    await tx.execute(sql`SELECT set_config('app.user_agent', ${ctx.userAgent ?? ''}, true)`);

    return fn(tx);
  });
}

/**
 * Soft-delete. Hard deletion is revoked and trigger-blocked (rule 13);
 * this is the supported path.
 */
export async function archiveRecord(
  ctx: ActorContext,
  table: 'parent_guardian' | 'student' | 'enrollment' | 'subscription' | 'payment' | 'employee' | 'teacher',
  id: string,
  reason: string,
  db: Database = getDb(),
): Promise<void> {
  await withActor(
    { ...ctx, reason },
    async (tx) => {
      await tx.execute(sql`SELECT archive_record(${table}, ${id}::uuid, ${reason})`);
    },
    db,
  );
}

/**
 * Records a blocked attempt (DD §41 outcome='blocked') as a durable audit row.
 *
 * MUST be called AFTER the failed operation's transaction has already rolled
 * back (from a catch block, never from inside the transaction that failed).
 * Postgres has no autonomous-transaction primitive: a row written earlier in a
 * transaction that later `RAISE EXCEPTION`s is rolled back along with it. That
 * was verified against a live database while building the teacher-allocation
 * eligibility guard (docs/data-model/04-history-audit-and-integrity.md §1b) —
 * the DB trigger itself no longer attempts to self-log; this function is the
 * durable replacement, run in its own transaction from the calling service.
 *
 * @example
 * try {
 *   await createAllocation(ctx, input);
 * } catch (err) {
 *   if (err instanceof AllocationBlockedError) {
 *     await recordBlockedAttempt(ctx, {
 *       entityType: 'teacher_allocation',
 *       recordId: crypto.randomUUID(), // synthetic — the row was never created
 *       action: 'INSERT',
 *       reason: err.message,
 *     });
 *   }
 *   throw err;
 * }
 */
export async function recordBlockedAttempt(
  ctx: ActorContext,
  params: { entityType: string; recordId: string; action: string; reason: string },
  db: Database = getDb(),
): Promise<void> {
  await withActor(
    { ...ctx, source: ctx.source ?? 'api' },
    async (tx) => {
      await tx.execute(
        sql`SELECT audit.record_blocked(${params.entityType}, ${params.recordId}::uuid, ${params.action}, ${params.reason})`,
      );
    },
    db,
  );
}

export * as schema from './schema/index.js';
