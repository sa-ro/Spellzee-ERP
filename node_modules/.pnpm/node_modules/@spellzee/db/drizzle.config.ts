import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit is used for INTROSPECTION and type generation only.
 *
 * Migrations are hand-authored SQL in ./migrations and applied by src/migrate.ts.
 * Generated migrations are deliberately not used: the schema depends on triggers,
 * SECURITY DEFINER functions, partial indexes, generated columns and REVOKE
 * grants that drizzle-kit cannot express (CLAUDE.md §2).
 */
export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  verbose: true,
  strict: true,
} satisfies Config;
