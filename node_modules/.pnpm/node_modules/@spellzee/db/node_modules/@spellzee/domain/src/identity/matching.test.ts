/**
 * Duplicate-detection scoring tests — pure, no database.
 *
 * These cover the scenarios Master §6.4 and DD §7 describe in prose, especially
 * the one the whole feature exists for: a returning family using a different
 * phone number or a slightly different spelling (Master §2).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  normalizeEmail,
  normalizeName,
  nameSimilarity,
  combine,
  bandFor,
  scoreCandidate,
  evaluateMatches,
  THRESHOLDS,
  type CandidateRecord,
  type MatchQuery,
} from './matching.js';

function candidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    studentId: '11111111-1111-1111-1111-111111111111',
    publicId: 'STU-2026-000184',
    fullName: 'Aarav Sharma',
    fullNameNormalized: 'aarav sharma',
    dateOfBirth: '2015-04-12',
    phones: ['9876543210'],
    alternatePhones: [],
    emails: ['parent@example.com'],
    parentNamesNormalized: ['priya sharma'],
    ...overrides,
  };
}

describe('normalisation (must mirror the SQL functions exactly)', () => {
  it('collapses phone formats to the trailing ten digits', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('9876543210');
    expect(normalizePhone('09876543210')).toBe('9876543210');
    expect(normalizePhone('98765-43210')).toBe('9876543210');
    expect(normalizePhone('+919876543210')).toBe('9876543210');
  });

  it('returns null for empty or non-numeric input', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('---')).toBeNull();
  });

  it('lowercases and trims emails', () => {
    expect(normalizeEmail('  Parent@Example.COM ')).toBe('parent@example.com');
  });

  it('strips punctuation and collapses whitespace in names', () => {
    expect(normalizeName('  Aarav   S.  Sharma ')).toBe('aarav s sharma');
    expect(normalizeName('D’Souza, Maria')).toBe('d souza maria');
  });
});

describe('name similarity', () => {
  it('scores exact matches as 1', () => {
    expect(nameSimilarity('aarav sharma', 'aarav sharma')).toBe(1);
  });

  it('handles reordered name parts', () => {
    // "Sharma Aarav" vs "Aarav Sharma" — common in Indian records.
    expect(nameSimilarity('sharma aarav', 'aarav sharma')).toBeGreaterThan(0.9);
  });

  it('scores spelling variants highly', () => {
    expect(nameSimilarity('arav sharma', 'aarav sharma')).toBeGreaterThan(THRESHOLDS.nameFloor);
  });

  it('does not confuse genuinely different names', () => {
    expect(nameSimilarity('anand kumar', 'ananya kumari')).toBeLessThan(THRESHOLDS.nameFloor);
  });
});

describe('signal combination', () => {
  it('never exceeds 1 even with many strong signals', () => {
    const score = combine([
      { kind: 'exact_phone', weight: 0.75, detail: '' },
      { kind: 'exact_email', weight: 0.7, detail: '' },
      { kind: 'name_similarity', weight: 0.45, detail: '' },
      { kind: 'date_of_birth', weight: 0.35, detail: '' },
    ]);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0.9);
  });

  it('reinforces rather than sums — two 0.7 signals give 0.91, not 1.4', () => {
    const score = combine([
      { kind: 'exact_phone', weight: 0.7, detail: '' },
      { kind: 'exact_email', weight: 0.7, detail: '' },
    ]);
    expect(score).toBeCloseTo(0.91, 2);
  });

  it('returns 0 for no signals', () => {
    expect(combine([])).toBe(0);
  });

  it('does not let three weak signals become a certainty', () => {
    const score = combine([
      { kind: 'name_similarity', weight: 0.2, detail: '' },
      { kind: 'parent_name_similarity', weight: 0.2, detail: '' },
      { kind: 'date_of_birth', weight: 0.2, detail: '' },
    ]);
    expect(bandFor(score)).not.toBe('block');
  });
});

describe('scoring real scenarios', () => {
  it('blocks the same child re-submitted with the same phone and name', () => {
    const query: MatchQuery = {
      fullName: 'Aarav Sharma',
      phones: ['+91 98765 43210'],
      parentFullName: 'Priya Sharma',
    };
    const result = scoreCandidate(query, candidate());
    expect(result.score).toBeGreaterThanOrEqual(THRESHOLDS.block);
    expect(result.signals.map((s) => s.kind)).toContain('exact_phone');
  });

  it('catches a returning family using the mother’s number instead of the father’s', () => {
    // The scenario Master §2 names explicitly: different contact detail, same child.
    const query: MatchQuery = {
      fullName: 'Aarav Sharma',
      phones: ['9000000001'], // brand new number
      parentFullName: 'Priya Sharma',
      dateOfBirth: '2015-04-12',
    };
    const result = scoreCandidate(query, candidate());
    expect(result.signals.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['name_similarity', 'parent_name_similarity', 'date_of_birth']),
    );
    expect(bandFor(result.score)).not.toBe('clear');
  });

  it('does not flag a sibling sharing the household phone as the same student', () => {
    // Same number, clearly different child. Must be reviewable, never auto-blocked,
    // or Operations cannot enrol siblings.
    const query: MatchQuery = {
      fullName: 'Ishaan Sharma',
      phones: ['9876543210'],
      parentFullName: 'Priya Sharma',
      dateOfBirth: '2012-01-01',
    };
    const result = scoreCandidate(query, candidate());
    expect(result.signals.map((s) => s.kind)).not.toContain('date_of_birth');
    expect(result.score).toBeLessThan(THRESHOLDS.block);
  });

  it('scores an unrelated student at zero', () => {
    const query: MatchQuery = {
      fullName: 'Meera Nair',
      phones: ['9111111111'],
      emails: ['different@example.com'],
    };
    expect(scoreCandidate(query, candidate()).score).toBe(0);
  });

  it('treats an alternate-phone hit as weaker than a primary-phone hit', () => {
    const base: MatchQuery = { fullName: 'Zzzz Qqqq' }; // name contributes nothing
    const primary = scoreCandidate({ ...base, phones: ['9876543210'] }, candidate());
    const alternate = scoreCandidate(
      { ...base, alternatePhones: ['9876543211'] },
      candidate({ alternatePhones: ['9876543211'] }),
    );
    expect(primary.score).toBeGreaterThan(alternate.score);
  });
});

describe('evaluateMatches', () => {
  it('ranks candidates by score and bands on the strongest', () => {
    const strong = candidate({ studentId: 'a', publicId: 'STU-2026-000001' });
    const weak = candidate({
      studentId: 'b',
      publicId: 'STU-2026-000002',
      fullName: 'Aarav Verma',
      fullNameNormalized: 'aarav verma',
      phones: ['9000000000'],
      emails: [],
      parentNamesNormalized: [],
      dateOfBirth: null,
    });

    const result = evaluateMatches(
      { fullName: 'Aarav Sharma', phones: ['9876543210'], parentFullName: 'Priya Sharma' },
      [weak, strong],
    );

    expect(result.candidates[0]?.studentId).toBe('a');
    expect(result.band).toBe('block');
    expect(result.requiresApprovalToCreate).toBe(true);
  });

  it('returns a clear band and no approval requirement when nothing matches', () => {
    const result = evaluateMatches({ fullName: 'Completely Different', phones: ['9000000009'] }, [
      candidate(),
    ]);
    expect(result.band).toBe('clear');
    expect(result.candidates).toHaveLength(0);
    expect(result.requiresApprovalToCreate).toBe(false);
  });

  it('stamps the ruleset version so past decisions stay interpretable (rule 28)', () => {
    const result = evaluateMatches({ fullName: 'Anyone' }, []);
    expect(result.rulesetVersion).toMatch(/^identity-match\//);
  });
});
