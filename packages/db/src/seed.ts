/**
 * Minimal reference-data seed for local development.
 *
 * Deliberately small: enough master data (one language, one subject/level/course)
 * to exercise the entities in scope. Not a fixture factory — tests build their own
 * data via the services in src/services/.
 */

import { getDb, withActor, schema } from './index.js';
import { SYSTEM_USER_ID } from './schema/reference.js';

async function seed(): Promise<void> {
  const db = getDb();

  await withActor({ actorId: SYSTEM_USER_ID, source: 'job', reason: 'initial seed' }, async (tx) => {
    const [english] = await tx
      .insert(schema.language)
      .values({ code: 'en', name: 'English' })
      .onConflictDoNothing()
      .returning();

    const [subject] = await tx
      .insert(schema.subject)
      .values({ code: 'ENG', name: 'English' })
      .onConflictDoNothing()
      .returning();

    const [level] = await tx
      .insert(schema.level)
      .values({ code: 'BEG', name: 'Beginner', sortOrder: 1 })
      .onConflictDoNothing()
      .returning();

    if (subject) {
      await tx
        .insert(schema.course)
        .values({
          code: 'ENG-BEG-1TO1',
          name: 'English Beginner (1-to-1)',
          subjectId: subject.id,
          defaultDurationMinutes: 60,
        })
        .onConflictDoNothing();
    }

    console.log('Seeded:', { english: english?.code, subject: subject?.code, level: level?.code });
  }, db);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
