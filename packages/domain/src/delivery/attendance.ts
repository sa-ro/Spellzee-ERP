/**
 * Attendance classification. Pure function, no I/O.
 *
 * CLAUDE.md §4 accepted policy defaults: ≥90% Present, 50-89% Partial, <50%
 * Absent, >10 min late = Late. Thresholds are ALWAYS passed in — this module
 * has no built-in numbers, so a caller reading policy_parameter live (rule
 * 28) is the only way these get applied, never a hard-coded fallback here.
 */

export interface AttendanceThresholds {
  presentThresholdPct: number;
  partialThresholdPct: number;
  lateMinutes: number;
}

export interface AttendanceInput {
  presentMinutes: number;
  totalMinutes: number;
  lateByMinutes: number;
}

export type AttendanceStatus = 'present' | 'late' | 'partial' | 'absent';

/**
 * Presence percentage decides present/partial/absent first — a student who
 * left early or attended only part of the session is not merely "late",
 * regardless of how late they arrived. Only once presence clears the
 * present-threshold does lateness get to demote the result to 'late'.
 */
export function classifyAttendance(input: AttendanceInput, thresholds: AttendanceThresholds): AttendanceStatus {
  if (input.totalMinutes <= 0) {
    throw new Error(`totalMinutes must be positive, got ${input.totalMinutes}.`);
  }
  if (input.presentMinutes > input.totalMinutes) {
    throw new Error(
      `presentMinutes (${input.presentMinutes}) cannot exceed totalMinutes (${input.totalMinutes}).`,
    );
  }
  if (input.presentMinutes < 0 || input.lateByMinutes < 0) {
    throw new Error('presentMinutes and lateByMinutes must be non-negative.');
  }

  const presencePct = (input.presentMinutes / input.totalMinutes) * 100;

  if (presencePct < thresholds.partialThresholdPct) {
    return 'absent';
  }
  if (presencePct < thresholds.presentThresholdPct) {
    return 'partial';
  }
  // presencePct >= presentThresholdPct
  if (input.lateByMinutes > thresholds.lateMinutes) {
    return 'late';
  }
  return 'present';
}
