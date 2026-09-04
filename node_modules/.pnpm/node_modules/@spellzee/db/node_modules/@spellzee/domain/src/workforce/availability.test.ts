/**
 * Availability & capacity scoring tests — pure, no database.
 */

import { describe, it, expect } from 'vitest';
import {
  toMinutes,
  windowMinutes,
  windowsOverlap,
  checkAvailability,
  checkCapacity,
  checkAllSlots,
  nextOccurrenceOnOrAfter,
  type AvailabilityRule,
  type CapacitySlot,
  type RequestedSlot,
} from './availability.js';

describe('time arithmetic', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    expect(toMinutes('09:30')).toBe(570);
    expect(toMinutes('09:30:00')).toBe(570);
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('23:59')).toBe(1439);
  });

  it('computes window duration', () => {
    expect(windowMinutes({ startTime: '09:00', endTime: '10:00' })).toBe(60);
    expect(windowMinutes({ startTime: '09:00', endTime: '09:30' })).toBe(30);
  });

  it('rejects a window whose end is not after its start', () => {
    expect(() => windowMinutes({ startTime: '10:00', endTime: '09:00' })).toThrow();
    expect(() => windowMinutes({ startTime: '10:00', endTime: '10:00' })).toThrow();
  });

  it('detects overlap correctly, including half-open boundaries', () => {
    expect(windowsOverlap({ startTime: '09:00', endTime: '10:00' }, { startTime: '09:30', endTime: '10:30' })).toBe(true);
    // Back-to-back windows do not overlap (end is exclusive).
    expect(windowsOverlap({ startTime: '09:00', endTime: '10:00' }, { startTime: '10:00', endTime: '11:00' })).toBe(false);
    expect(windowsOverlap({ startTime: '09:00', endTime: '10:00' }, { startTime: '11:00', endTime: '12:00' })).toBe(false);
  });
});

describe('checkAvailability', () => {
  const regularMonday: AvailabilityRule = {
    availabilityType: 'regular',
    dayOfWeek: 1,
    startTime: '09:00',
    endTime: '17:00',
    effectiveFrom: '2026-01-01',
  };

  it('is available when a regular rule fully covers the requested slot', () => {
    const result = checkAvailability([regularMonday], {
      dayOfWeek: 1,
      onDate: '2026-09-07',
      startTime: '09:00',
      endTime: '10:00',
    });
    expect(result).toEqual({ available: true });
  });

  it('is unavailable when no rule covers the requested day', () => {
    const result = checkAvailability([regularMonday], {
      dayOfWeek: 2,
      onDate: '2026-09-08',
      startTime: '09:00',
      endTime: '10:00',
    });
    expect(result).toEqual({ available: false, reason: 'no_covering_rule' });
  });

  it('is unavailable when the requested window extends past the covering rule', () => {
    const result = checkAvailability([regularMonday], {
      dayOfWeek: 1,
      onDate: '2026-09-07',
      startTime: '16:30',
      endTime: '17:30',
    });
    expect(result).toEqual({ available: false, reason: 'no_covering_rule' });
  });

  it('an unavailable rule blocks even when a regular rule would otherwise cover it', () => {
    const exception: AvailabilityRule = {
      availabilityType: 'unavailable',
      specificDateOn: '2026-09-07',
      startTime: '10:00',
      endTime: '12:00',
      effectiveFrom: '2026-09-07',
      effectiveTo: '2026-09-07',
    };
    const result = checkAvailability([regularMonday, exception], {
      dayOfWeek: 1,
      onDate: '2026-09-07',
      startTime: '10:00',
      endTime: '11:00',
    });
    expect(result).toEqual({ available: false, reason: 'blocked_by_unavailable_rule' });
  });

  it('an unavailable rule on a different date does not block this one', () => {
    const exception: AvailabilityRule = {
      availabilityType: 'unavailable',
      specificDateOn: '2026-09-14',
      startTime: '10:00',
      endTime: '12:00',
      effectiveFrom: '2026-09-14',
      effectiveTo: '2026-09-14',
    };
    const result = checkAvailability([regularMonday, exception], {
      dayOfWeek: 1,
      onDate: '2026-09-07',
      startTime: '10:00',
      endTime: '11:00',
    });
    expect(result.available).toBe(true);
  });

  it('a temporary one-off rule covers only its exact date', () => {
    const saturdayExtra: AvailabilityRule = {
      availabilityType: 'temporary',
      specificDateOn: '2026-09-12',
      startTime: '10:00',
      endTime: '12:00',
      effectiveFrom: '2026-09-12',
      effectiveTo: '2026-09-12',
    };
    expect(
      checkAvailability([saturdayExtra], { dayOfWeek: 6, onDate: '2026-09-12', startTime: '10:00', endTime: '11:00' })
        .available,
    ).toBe(true);
    expect(
      checkAvailability([saturdayExtra], { dayOfWeek: 6, onDate: '2026-09-19', startTime: '10:00', endTime: '11:00' })
        .available,
    ).toBe(false);
  });

  it('respects effective_from/effective_to bounds on a regular rule', () => {
    const seasonal: AvailabilityRule = {
      ...regularMonday,
      effectiveFrom: '2026-06-01',
      effectiveTo: '2026-08-31',
    };
    expect(
      checkAvailability([seasonal], { dayOfWeek: 1, onDate: '2026-07-06', startTime: '09:00', endTime: '10:00' })
        .available,
    ).toBe(true);
    expect(
      checkAvailability([seasonal], { dayOfWeek: 1, onDate: '2026-09-07', startTime: '09:00', endTime: '10:00' })
        .available,
    ).toBe(false);
  });
});

describe('checkCapacity', () => {
  const mondaySlot: CapacitySlot = {
    dayOfWeek: 1,
    startTime: '09:00',
    endTime: '10:00',
    plannedCapacityMinutes: 60,
    allocatedCapacityMinutes: 0,
    reservedMinutes: 0,
    effectiveFrom: '2026-01-01',
  };

  it('is sufficient when free capacity meets the requirement', () => {
    const result = checkCapacity([mondaySlot], { dayOfWeek: 1, onDate: '2026-09-07', startTime: '09:00', endTime: '10:00' });
    expect(result).toEqual({ sufficient: true, freeMinutes: 60 });
  });

  it('is insufficient when the slot is already fully allocated', () => {
    const full = { ...mondaySlot, allocatedCapacityMinutes: 60 };
    const result = checkCapacity([full], { dayOfWeek: 1, onDate: '2026-09-07', startTime: '09:00', endTime: '10:00' });
    expect(result).toEqual({
      sufficient: false,
      freeMinutes: 0,
      requiredMinutes: 60,
      reason: 'insufficient_capacity',
    });
  });

  it('accounts for reserved minutes as well as allocated', () => {
    // 60 planned - 30 reserved = 30 free, and the requested 60-minute slot no
    // longer fits even though nothing has been formally *allocated* yet.
    const reserved = { ...mondaySlot, reservedMinutes: 30 };
    const result = checkCapacity([reserved], { dayOfWeek: 1, onDate: '2026-09-07', startTime: '09:00', endTime: '10:00' });
    expect(result).toEqual({
      sufficient: false,
      freeMinutes: 30,
      requiredMinutes: 60,
      reason: 'insufficient_capacity',
    });
  });

  it('reports no_capacity_slot when no matching slot exists at all', () => {
    const result = checkCapacity([], { dayOfWeek: 1, onDate: '2026-09-07', startTime: '09:00', endTime: '10:00' });
    expect(result).toEqual({ sufficient: false, freeMinutes: 0, requiredMinutes: 60, reason: 'no_capacity_slot' });
  });

  it('does not match a capacity slot for a different exact time window', () => {
    const differentWindow = { ...mondaySlot, startTime: '11:00', endTime: '12:00' };
    const result = checkCapacity([differentWindow], {
      dayOfWeek: 1,
      onDate: '2026-09-07',
      startTime: '09:00',
      endTime: '10:00',
    });
    expect(result.sufficient).toBe(false);
  });

  it('respects the capacity row effective period', () => {
    const expired = { ...mondaySlot, effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31' };
    const result = checkCapacity([expired], { dayOfWeek: 1, onDate: '2026-09-07', startTime: '09:00', endTime: '10:00' });
    expect(result.sufficient).toBe(false);
  });
});

describe('checkAllSlots', () => {
  const mwfRule: AvailabilityRule = {
    availabilityType: 'regular',
    dayOfWeek: 1,
    startTime: '09:00',
    endTime: '17:00',
    effectiveFrom: '2026-01-01',
  };
  const wednesdayRule: AvailabilityRule = { ...mwfRule, dayOfWeek: 3 };
  const mondayCapacity: CapacitySlot = {
    dayOfWeek: 1,
    startTime: '09:00',
    endTime: '10:00',
    plannedCapacityMinutes: 60,
    allocatedCapacityMinutes: 0,
    reservedMinutes: 0,
    effectiveFrom: '2026-01-01',
  };

  it('returns no failures when every requested slot is available and has capacity', () => {
    const requested: RequestedSlot[] = [
      { dayOfWeek: 1, onDate: '2026-09-07', startTime: '09:00', endTime: '10:00' },
    ];
    expect(checkAllSlots([mwfRule], [mondayCapacity], requested)).toEqual([]);
  });

  it('reports every failing day, not just the first (Monday ok, Wednesday has no capacity row)', () => {
    const requested: RequestedSlot[] = [
      { dayOfWeek: 1, onDate: '2026-09-07', startTime: '09:00', endTime: '10:00' },
      { dayOfWeek: 3, onDate: '2026-09-09', startTime: '09:00', endTime: '10:00' },
    ];
    const failures = checkAllSlots([mwfRule, wednesdayRule], [mondayCapacity], requested);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.slot.dayOfWeek).toBe(3);
    expect(failures[0]?.capacity?.reason).toBe('no_capacity_slot');
  });

  it('reports both availability and capacity failures on the same slot when both fail', () => {
    const requested: RequestedSlot[] = [
      { dayOfWeek: 5, onDate: '2026-09-11', startTime: '09:00', endTime: '10:00' },
    ];
    const failures = checkAllSlots([mwfRule], [mondayCapacity], requested);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.availability?.reason).toBe('no_covering_rule');
    expect(failures[0]?.capacity?.reason).toBe('no_capacity_slot');
  });
});

describe('nextOccurrenceOnOrAfter', () => {
  // 2026-09-07 is a Monday (dayOfWeek=1).
  it('returns the same date when it already falls on the target weekday', () => {
    expect(nextOccurrenceOnOrAfter('2026-09-07', 1)).toBe('2026-09-07');
  });

  it('finds the next occurrence later in the same week', () => {
    expect(nextOccurrenceOnOrAfter('2026-09-07', 3)).toBe('2026-09-09'); // Wed
  });

  it('wraps into the following week when the weekday has already passed', () => {
    expect(nextOccurrenceOnOrAfter('2026-09-07', 0)).toBe('2026-09-13'); // next Sunday
  });

  it('rejects an unparseable date', () => {
    expect(() => nextOccurrenceOnOrAfter('not-a-date', 1)).toThrow();
  });
});
