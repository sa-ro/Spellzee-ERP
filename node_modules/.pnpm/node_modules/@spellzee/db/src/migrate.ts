/**
 * Migration runner.
 *
 * Forward-only, numbered SQL, applied in filename order, each in its own
 * transaction, recorded in `schema_migration`. Never edit an applied migration —
 * write a new one (CLAUDE.md §6).
 *
 * The runner connects as the owner (migrations create roles and SECURITY DEFINER
 * functions) and sets a migration actor so even bootstrap writes are attributable.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

async function ensureMigrationTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename    text PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer     NOT NULL
    )
  `);
}

export async function migrate(connectionString = process.env['DATABASE_URL']): Promise<void> {
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();

  try {
    await ensureMigrationTable(client);

    const applied = new Map<string, string>(
      (await client.query<{ filename: string; checksum: string }>(
        'SELECT filename, checksum FROM schema_migration',
      )).rows.map((r) => [r.filename, r.checksum]),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const previous = applied.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} has changed since it was applied.\n` +
              'Applied migrations are immutable — write a new migration instead (CLAUDE.md §6).',
          );
        }
        continue;
      }

      const started = Date.now();
      process.stdout.write(`  applying ${file} ... `);

      try {
        // Migrations manage their own BEGIN/COMMIT so they can run statements
        // that must not share a transaction. The actor is set per-session here.
        await client.query(`SELECT set_config('app.actor_id', '${SYSTEM_ACTOR}', false)`);
        await client.query(`SELECT set_config('app.source', 'migration', false)`);
        await client.query(body);

        const duration = Date.now() - started;
        await client.query(
          'INSERT INTO schema_migration (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
          [file, checksum, duration],
        );
        process.stdout.write(`ok (${duration}ms)\n`);
      } catch (error) {
        process.stdout.write('FAILED\n');
        throw error;
      }
    }

    process.stdout.write('Migrations up to date.\n');
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
