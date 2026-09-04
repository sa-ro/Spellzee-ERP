/**
 * Duplicate detection service — DD §7 (Identity Match), Master §6.4.
 *
 * Framework-agnostic on purpose: this is a data-layer service, later wrapped by a
 * NestJS provider. It performs candidate *retrieval*; scoring lives in
 * @spellzee/domain so it can be unit-tested without a database.
 *
 * The flow Master §6.4 mandates:
 *   1. search existing students before creation
 *   2. match across student/parent names, phones, alternate numbers, emails
 *   3. show probable matches before allowing creation
 *   4. block or require approval for high-confidence duplicates
 *   5. record the decision either way (DD §7) — including "not a duplicate"
 */

import { sql, eq } from 'drizzle-orm';
import {
  evaluateMatches,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  MATCHING_RULESET_VERSION,
  type CandidateRecord,
  type MatchQuery,
  type MatchResult,
} from '@spellzee/domain/identity/matching';
import type { ActorContext, Database, Transaction } from '../client.js';
import { getDb, withActor } from '../client.js';
import { identityMatch, student } from '../schema/identity.js';

export interface DuplicateSearchInput extends MatchQuery {
  /** Excluded from results — used when re-checking an existing record. */
  excludeStudentId?: string;
}

export interface DuplicateSearchResult extends MatchResult {
  /** identity_match.id — persisted so the decision can be attached later. */
  identityMatchId: string;
}

/** Names below this are not worth a trigram scan. Mirrors THRESHOLDS.nameFloor. */
const SQL_NAME_SIMILARITY_FLOOR = 0.35;
const MAX_CANDIDATES = 25;

/**
 * Finds probable duplicates and records the attempt.
 *
 * Always writes an `identity_match` row — including when nothing matched. DD §7
 * treats the negative decision as evidence: it is what later explains why two
 * similar-looking students legitimately coexist.
 */
export async function findDuplicateCandidates(
  ctx: ActorContext,
  input: DuplicateSearchInput,
  db: Database = getDb(),
): Promise<DuplicateSearchResult> {
  const phones = dedupe([
    ...(input.phones ?? []).map(normalizePhone),
    ...(input.alternatePhones ?? []).map(normalizePhone),
  ]);
  const emails = dedupe((input.emails ?? []).map(normalizeEmail));
  const nameNormalized = normalizeName(input.fullName);

  return withActor(
    { ...ctx, source: ctx.source ?? 'ui' },
    async (tx) => {
      const candidates = await retrieveCandidates(tx, {
        phones,
        emails,
        nameNormalized,
        excludeStudentId: input.excludeStudentId,
      });

      const result = evaluateMatches(input, candidates);

      const [row] = await tx
        .insert(identityMatch)
        .values({
          attemptedRecord: {
            fullName: input.fullName,
            dateOfBirth: input.dateOfBirth ?? null,
            parentFullName: input.parentFullName ?? null,
            phones: input.phones ?? [],
            alternatePhones: input.alternatePhones ?? [],
            emails: input.emails ?? [],
          },
          searchName: nameNormalized,
          searchPhones: phones,
          searchEmails: emails,
          candidateCount: result.candidates.length,
          candidates: result.candidates,
          topCandidateStudentId: result.candidates[0]?.studentId ?? null,
          topScore: result.topScore > 0 ? result.topScore.toFixed(4) : null,
          band: result.band,
          matchingRulesetVersion: result.rulesetVersion,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
          source: ctx.source ?? 'ui',
        })
        .returning({ id: identityMatch.id });

      if (!row) {
        throw new Error('Failed to persist identity_match row.');
      }

      return { ...result, identityMatchId: row.id };
    },
    db,
  );
}

/**
 * Candidate retrieval.
 *
 * Three passes, unioned:
 *   1. exact normalised phone / alternate phone  (contact_history)
 *   2. exact normalised email                    (contact_history)
 *   3. fuzzy student or guardian name            (pg_trgm)
 *
 * Contacts belonging to the student *or any of their guardians* count — a family
 * re-enrolling under the mother's number instead of the father's is precisely the
 * duplicate case Master §6.4 is written to catch.
 *
 * Merged-away students are excluded: they are tombstones, and matching against one
 * would send the operator to a dead record instead of the surviving identity.
 */
async function retrieveCandidates(
  tx: Transaction,
  params: {
    phones: string[];
    emails: string[];
    nameNormalized: string | null;
    excludeStudentId?: string | undefined;
  },
): Promise<CandidateRecord[]> {
  const { phones, emails, nameNormalized, excludeStudentId } = params;

  if (phones.length === 0 && emails.length === 0 && !nameNormalized) {
    return [];
  }

  const contactValues = [...phones, ...emails];

  const rows = await tx.execute<{
    student_id: string;
    public_id: string;
    full_name: string;
    full_name_normalized: string;
    date_of_birth: string | null;
    phones: string[];
    alternate_phones: string[];
    emails: string[];
    parent_names: string[];
  }>(sql`
    WITH student_guardians AS (
      -- Every student, with the guardians currently linked to them.
      SELECT s.id AS student_id,
             array_remove(array_agg(DISTINCT spl.parent_guardian_id), NULL) AS parent_ids
      FROM student s
      LEFT JOIN student_parent_link spl
        ON spl.student_id = s.id AND spl.is_current
      GROUP BY s.id
    ),
    owned_contacts AS (
      -- Contacts reachable from a student: their own, plus their guardians'.
      SELECT sg.student_id, ch.contact_type, ch.value_normalized
      FROM student_guardians sg
      JOIN contact_history ch
        ON ch.student_id = sg.student_id
        OR ch.parent_guardian_id = ANY(sg.parent_ids)
      WHERE ch.value_normalized IS NOT NULL
    ),
    contact_hits AS (
      SELECT DISTINCT student_id
      FROM owned_contacts
      WHERE ${contactValues.length > 0
        ? sql`value_normalized = ANY(${contactValues}::text[])`
        : sql`false`}
    ),
    name_hits AS (
      SELECT s.id AS student_id
      FROM student s
      WHERE ${nameNormalized
        ? sql`similarity(s.full_name_normalized, ${nameNormalized}) >= ${SQL_NAME_SIMILARITY_FLOOR}`
        : sql`false`}
      UNION
      SELECT spl.student_id
      FROM student_parent_link spl
      JOIN parent_guardian pg ON pg.id = spl.parent_guardian_id
      WHERE spl.is_current
        AND ${nameNormalized
          ? sql`similarity(pg.full_name_normalized, ${nameNormalized}) >= ${SQL_NAME_SIMILARITY_FLOOR}`
          : sql`false`}
    ),
    matched AS (
      SELECT student_id FROM contact_hits
      UNION
      SELECT student_id FROM name_hits
    )
    SELECT
      s.id                    AS student_id,
      s.public_id,
      s.full_name,
      s.full_name_normalized,
      s.date_of_birth::text   AS date_of_birth,
      coalesce(
        (SELECT array_agg(DISTINCT oc.value_normalized)
         FROM owned_contacts oc
         WHERE oc.student_id = s.id AND oc.contact_type = 'phone'), '{}'
      ) AS phones,
      coalesce(
        (SELECT array_agg(DISTINCT oc.value_normalized)
         FROM owned_contacts oc
         WHERE oc.student_id = s.id AND oc.contact_type = 'alternate_phone'), '{}'
      ) AS alternate_phones,
      coalesce(
        (SELECT array_agg(DISTINCT oc.value_normalized)
         FROM owned_contacts oc
         WHERE oc.student_id = s.id AND oc.contact_type = 'email'), '{}'
      ) AS emails,
      coalesce(
        (SELECT array_agg(DISTINCT pg.full_name_normalized)
         FROM student_parent_link spl
         JOIN parent_guardian pg ON pg.id = spl.parent_guardian_id
         WHERE spl.student_id = s.id AND spl.is_current), '{}'
      ) AS parent_names
    FROM matched m
    JOIN student s ON s.id = m.student_id
    WHERE s.status <> 'merged'
      AND ${excludeStudentId ? sql`s.id <> ${excludeStudentId}::uuid` : sql`true`}
    LIMIT ${MAX_CANDIDATES}
  `);

  return rows.rows.map((r) => ({
    studentId: r.student_id,
    publicId: r.public_id,
    fullName: r.full_name,
    fullNameNormalized: r.full_name_normalized,
    dateOfBirth: r.date_of_birth,
    phones: r.phones ?? [],
    alternatePhones: r.alternate_phones ?? [],
    emails: r.emails ?? [],
    parentNamesNormalized: r.parent_names ?? [],
  }));
}

/**
 * Records what the operator decided. DD §7 requires the decision and reviewer be
 * preserved, not just the candidate list.
 *
 * Creating a new student despite a `block` band requires a reason — Master §6.4
 * ("block or require approval for high-confidence duplicates"). The DB constraint
 * `identity_match_block_not_silently_created` enforces the same rule.
 */
export async function recordMatchDecision(
  ctx: ActorContext,
  params: {
    identityMatchId: string;
    decision: 'created_new' | 'used_existing' | 'abandoned' | 'blocked';
    decidedStudentId?: string;
    reason?: string;
  },
  db: Database = getDb(),
): Promise<void> {
  await withActor(
    ctx,
    async (tx) => {
      const [existing] = await tx
        .select({ band: identityMatch.band, decision: identityMatch.decision })
        .from(identityMatch)
        .where(eq(identityMatch.id, params.identityMatchId));

      if (!existing) {
        throw new Error(`identity_match ${params.identityMatchId} not found.`);
      }
      if (existing.decision !== null) {
        throw new Error(
          `identity_match ${params.identityMatchId} is already decided (${existing.decision}). ` +
            'Decisions are not overwritten (rule 11).',
        );
      }
      if (existing.band === 'block' && params.decision === 'created_new' && !params.reason) {
        throw new Error(
          'Creating a new student against a high-confidence duplicate requires an approved ' +
            'override reason (Master §6.4).',
        );
      }
      if (params.decision === 'used_existing' && !params.decidedStudentId) {
        throw new Error('used_existing requires decidedStudentId.');
      }

      await tx
        .update(identityMatch)
        .set({
          decision: params.decision,
          decisionReason: params.reason ?? null,
          decidedStudentId: params.decidedStudentId ?? null,
          decidedBy: ctx.actorId,
          decidedAt: new Date(),
          updatedBy: ctx.actorId,
        })
        .where(eq(identityMatch.id, params.identityMatchId));
    },
    db,
  );
}

/**
 * Follows the merge chain to the surviving student.
 *
 * Rule 4 keeps merged records forever, so any lookup by an old identifier must
 * redirect rather than return a tombstone. Depth-limited: a cycle would otherwise
 * spin, and cycles are possible if a merge is ever mis-recorded.
 */
export async function resolveSurvivingStudent(
  studentId: string,
  db: Database = getDb(),
  maxDepth = 10,
): Promise<string> {
  let current = studentId;

  for (let depth = 0; depth < maxDepth; depth++) {
    const [row] = await db
      .select({ mergedInto: student.mergedIntoStudentId })
      .from(student)
      .where(eq(student.id, current));

    if (!row) throw new Error(`Student ${current} not found.`);
    if (!row.mergedInto) return current;
    current = row.mergedInto;
  }

  throw new Error(
    `Merge chain from ${studentId} exceeded ${maxDepth} hops — probable cycle in merge history.`,
  );
}

function dedupe(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null && v.length > 0))];
}
