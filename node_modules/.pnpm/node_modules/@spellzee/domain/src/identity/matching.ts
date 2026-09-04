/**
 * Duplicate-detection scoring — DD §7 (Identity Match), Master §6.4.
 *
 * Pure functions only: no I/O, no database, no clock. Candidate retrieval lives in
 * @spellzee/db; this module decides what a candidate is *worth* and what the
 * operator is allowed to do about it.
 *
 * Master §6.4 requires:
 *   - search before creation across names, phones, alternate numbers, emails
 *   - show probable matches before allowing creation
 *   - block or require approval for high-confidence duplicates
 *   - never create a new identity just because a contact detail changed
 *
 * The thresholds below are ENGINEERING DEFAULTS. Master §30 leaves duplicate
 * matching confidence open. The ruleset version is stamped onto every decision
 * (rule 28) so past decisions stay interpretable when these change.
 */

export const MATCHING_RULESET_VERSION = 'identity-match/2026-09-04.1';

export type MatchBand = 'clear' | 'review' | 'block';

export type MatchSignalKind =
  | 'exact_phone'
  | 'exact_alternate_phone'
  | 'exact_email'
  | 'name_similarity'
  | 'parent_name_similarity'
  | 'date_of_birth';

export interface MatchSignal {
  kind: MatchSignalKind;
  weight: number;
  detail: string;
}

/** What the operator is trying to create. */
export interface MatchQuery {
  fullName: string;
  dateOfBirth?: string | null;
  parentFullName?: string | null;
  phones?: string[];
  alternatePhones?: string[];
  emails?: string[];
}

/** A possible existing student, as retrieved from the database. */
export interface CandidateRecord {
  studentId: string;
  publicId: string;
  fullName: string;
  fullNameNormalized: string;
  dateOfBirth?: string | null;
  /** Normalised contact values already held for this student or their guardians. */
  phones: string[];
  alternatePhones: string[];
  emails: string[];
  parentNamesNormalized: string[];
}

export interface ScoredCandidate {
  studentId: string;
  publicId: string;
  fullName: string;
  score: number;
  signals: MatchSignal[];
}

export interface MatchResult {
  band: MatchBand;
  topScore: number;
  candidates: ScoredCandidate[];
  rulesetVersion: string;
  /** True when creation requires an explicit, reasoned override (Master §6.4). */
  requiresApprovalToCreate: boolean;
}

/* -------------------------------------------------------------------------- */
/* Normalisation — must mirror the SQL functions in 0004_identity.sql exactly,  */
/* or the application and the database will disagree about what "same" means.   */
/* -------------------------------------------------------------------------- */

/** Trailing 10 digits, so +91 98765 43210 and 09876543210 collapse to one value. */
export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return null;
  return digits.slice(-10);
}

export function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/* -------------------------------------------------------------------------- */
/* Similarity                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Trigram similarity, matching Postgres pg_trgm semantics closely enough that
 * SQL-side pre-filtering and application-side scoring agree on ordering.
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const trigrams = (s: string): Set<string> => {
    const padded = `  ${s} `;
    const out = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) {
      out.add(padded.slice(i, i + 3));
    }
    return out;
  };

  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;

  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Token-aware name comparison. Handles reordering ("Priya Ramesh" vs
 * "Ramesh Priya") and initials, which trigram alone scores poorly.
 */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;

  const tokensA = a.split(' ').filter(Boolean);
  const tokensB = b.split(' ').filter(Boolean);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setB = new Set(tokensB);
  let exactTokenMatches = 0;
  for (const t of tokensA) if (setB.has(t)) exactTokenMatches++;

  const tokenScore = exactTokenMatches / Math.max(tokensA.length, tokensB.length);
  return Math.max(trigramSimilarity(a, b), tokenScore);
}

/* -------------------------------------------------------------------------- */
/* Weights and thresholds — ENGINEERING DEFAULTS (Master §30 open)             */
/* -------------------------------------------------------------------------- */

export const WEIGHTS = {
  exactPhone: 0.75,
  exactAlternatePhone: 0.55,
  exactEmail: 0.7,
  nameSimilarity: 0.45,
  parentNameSimilarity: 0.3,
  dateOfBirth: 0.35,
} as const;

export const THRESHOLDS = {
  /** At or above this, creating a new student requires an approved override. */
  block: 0.85,
  /** At or above this, candidates are shown and the operator must choose. */
  review: 0.45,
  /** Names below this contribute nothing — avoids "Anand" matching "Ananya". */
  nameFloor: 0.6,
} as const;

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

export function scoreCandidate(query: MatchQuery, candidate: CandidateRecord): ScoredCandidate {
  const signals: MatchSignal[] = [];

  const queryPhones = (query.phones ?? []).map(normalizePhone).filter((p): p is string => !!p);
  const queryAltPhones = (query.alternatePhones ?? [])
    .map(normalizePhone)
    .filter((p): p is string => !!p);
  const queryEmails = (query.emails ?? []).map(normalizeEmail).filter((e): e is string => !!e);

  // A phone match is the strongest single signal: families reuse numbers across
  // siblings, but a shared number plus a similar name is near-certain duplication.
  const candidateAllPhones = new Set([...candidate.phones, ...candidate.alternatePhones]);
  const phoneHit = queryPhones.find((p) => candidateAllPhones.has(p));
  if (phoneHit) {
    signals.push({
      kind: 'exact_phone',
      weight: WEIGHTS.exactPhone,
      detail: `phone ending ${phoneHit.slice(-4)} already on record`,
    });
  } else {
    const altHit = queryAltPhones.find((p) => candidateAllPhones.has(p));
    if (altHit) {
      signals.push({
        kind: 'exact_alternate_phone',
        weight: WEIGHTS.exactAlternatePhone,
        detail: `alternate phone ending ${altHit.slice(-4)} already on record`,
      });
    }
  }

  const candidateEmails = new Set(candidate.emails);
  const emailHit = queryEmails.find((e) => candidateEmails.has(e));
  if (emailHit) {
    signals.push({
      kind: 'exact_email',
      weight: WEIGHTS.exactEmail,
      detail: `email ${emailHit} already on record`,
    });
  }

  const queryName = normalizeName(query.fullName);
  if (queryName) {
    const similarity = nameSimilarity(queryName, candidate.fullNameNormalized);
    if (similarity >= THRESHOLDS.nameFloor) {
      signals.push({
        kind: 'name_similarity',
        weight: WEIGHTS.nameSimilarity * similarity,
        detail: `student name ${(similarity * 100).toFixed(0)}% similar to "${candidate.fullName}"`,
      });
    }
  }

  const queryParentName = normalizeName(query.parentFullName);
  if (queryParentName && candidate.parentNamesNormalized.length > 0) {
    const best = Math.max(
      ...candidate.parentNamesNormalized.map((n) => nameSimilarity(queryParentName, n)),
    );
    if (best >= THRESHOLDS.nameFloor) {
      signals.push({
        kind: 'parent_name_similarity',
        weight: WEIGHTS.parentNameSimilarity * best,
        detail: `guardian name ${(best * 100).toFixed(0)}% similar`,
      });
    }
  }

  if (query.dateOfBirth && candidate.dateOfBirth && query.dateOfBirth === candidate.dateOfBirth) {
    signals.push({
      kind: 'date_of_birth',
      weight: WEIGHTS.dateOfBirth,
      detail: `date of birth matches (${candidate.dateOfBirth})`,
    });
  }

  return {
    studentId: candidate.studentId,
    publicId: candidate.publicId,
    fullName: candidate.fullName,
    score: combine(signals),
    signals,
  };
}

/**
 * Combines signals with diminishing returns rather than a plain sum.
 *
 * Independent evidence should reinforce, but three weak signals must not add up
 * to a certainty. Probabilistic OR: 1 - Π(1 - wᵢ). Two 0.7 signals give 0.91,
 * never the 1.4 a sum would produce.
 */
export function combine(signals: MatchSignal[]): number {
  if (signals.length === 0) return 0;
  const inverse = signals.reduce((acc, s) => acc * (1 - clamp01(s.weight)), 1);
  return round4(1 - inverse);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function bandFor(score: number): MatchBand {
  if (score >= THRESHOLDS.block) return 'block';
  if (score >= THRESHOLDS.review) return 'review';
  return 'clear';
}

/**
 * Scores and ranks every candidate, returning the banding decision.
 *
 * Master §6.4: high-confidence duplicates are blocked or require approval; the
 * operator sees probable matches *before* a new identity exists.
 */
export function evaluateMatches(
  query: MatchQuery,
  candidates: CandidateRecord[],
): MatchResult {
  const scored = candidates
    .map((c) => scoreCandidate(query, c))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const topScore = scored[0]?.score ?? 0;
  const band = bandFor(topScore);

  return {
    band,
    topScore,
    candidates: scored,
    rulesetVersion: MATCHING_RULESET_VERSION,
    requiresApprovalToCreate: band === 'block',
  };
}
