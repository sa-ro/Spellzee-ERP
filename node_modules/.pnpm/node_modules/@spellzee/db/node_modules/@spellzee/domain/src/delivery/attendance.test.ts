import { describe, it, expect } from 'vitest';
import { classifyAttendance, type AttendanceThresholds } from './attendance.js';

const thresholds: AttendanceThresholds = {
  presentThresholdPct: 90,
  partialThresholdPct: 50,
  lateMinutes: 10,
};

describe('classifyAttendance', () => {
  it('classifies 100% presence, on time, as present', () => {
    const result = classifyAttendance({ presentMinutes: 60, totalMinutes: 60, lateByMinutes: 0 }, thresholds);
    expect(result).toBe('present');
  });

  it('classifies >=90% presence as present even with a couple of minutes missing', () => {
    const result = classifyAttendance({ presentMinutes: 55, totalMinutes: 60, lateByMinutes: 0 }, thresholds);
    expect(result).toBe('present');
  });

  it('classifies presence between 50% and 90% as partial', () => {
    const result = classifyAttendance({ presentMinutes: 35, totalMinutes: 60, lateByMinutes: 0 }, thresholds);
    expect(result).toBe('partial');
  });

  it('classifies presence below 50% as absent', () => {
    const result = classifyAttendance({ presentMinutes: 20, totalMinutes: 60, lateByMinutes: 0 }, thresholds);
    expect(result).toBe('absent');
  });

  it('classifies zero presence as absent', () => {
    const result = classifyAttendance({ presentMinutes: 0, totalMinutes: 60, lateByMinutes: 0 }, thresholds);
    expect(result).toBe('absent');
  });

  it('classifies as late when present >=90% but arrived more than lateMinutes after start', () => {
    const result = classifyAttendance({ presentMinutes: 55, totalMinutes: 60, lateByMinutes: 15 }, thresholds);
    expect(result).toBe('late');
  });

  it('does NOT classify as late when arrival delay is within the threshold', () => {
    const result = classifyAttendance({ presentMinutes: 58, totalMinutes: 60, lateByMinutes: 5 }, thresholds);
    expect(result).toBe('present');
  });

  it('partial/absent take priority over lateness -- a student who left early is not just "late"', () => {
    const result = classifyAttendance({ presentMinutes: 20, totalMinutes: 60, lateByMinutes: 15 }, thresholds);
    expect(result).toBe('absent');
  });

  it('exact boundary: presence == presentThresholdPct counts as present', () => {
    const result = classifyAttendance({ presentMinutes: 54, totalMinutes: 60, lateByMinutes: 0 }, thresholds);
    // 54/60 = 90% exactly
    expect(result).toBe('present');
  });

  it('exact boundary: presence == partialThresholdPct counts as partial, not absent', () => {
    const result = classifyAttendance({ presentMinutes: 30, totalMinutes: 60, lateByMinutes: 0 }, thresholds);
    // 30/60 = 50% exactly
    expect(result).toBe('partial');
  });

  it('throws on a non-positive totalMinutes -- a malformed session duration is a caller bug', () => {
    expect(() => classifyAttendance({ presentMinutes: 0, totalMinutes: 0, lateByMinutes: 0 }, thresholds)).toThrow();
  });

  it('throws when presentMinutes exceeds totalMinutes', () => {
    expect(() => classifyAttendance({ presentMinutes: 70, totalMinutes: 60, lateByMinutes: 0 }, thresholds)).toThrow();
  });
});
