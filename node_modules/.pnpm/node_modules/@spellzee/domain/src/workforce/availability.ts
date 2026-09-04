/**
 * Availability & capacity checking — DD §12, rule 8.
 *
 * Pure functions only: no I/O, no database, no clock (a `now` is always
 * passed in). Retrieval of the rows these functions reason over lives in
 * @spellzee/db; this module decides what the rows MEAN.
 *
 * Rule 8 (DD §43): "Teacher availability is not the same as capacity."
 * Availability answers "is this person free at this time?" — a possibly
 * overlapping set of declared rules. Capacity answers "how much can Spellzee
 * realistically deliver?" — a measured quantity. The allocation service must
 * check BOTH before confirming a new allocation (this prompt's requirement).
 */

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export interface TimeWindow {
  /** 'HH:MM' or 'HH:MM:SS', 24-hour. */
  startTime: string;
  endTime: string;
}

export interface AvailabilityRule extends TimeWindow {
  availabilityType: 'regular' | 'specific_date' | 'temporary' | 'unavailable';
  dayOfWeek?: DayOfWeek | null;
  specificDateOn?: string | null; // 'YYYY-MM-DD'
  effectiveFrom: string; // 'YYYY-MM-DD'
  effectiveTo?: string | null;
}

export interface CapacitySlot extends TimeWindow {
  dayOfWeek: DayOfWeek;
  plannedCapacityMinutes: number;
  allocatedCapacityMinutes: number;
  reservedMinutes: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface RequestedSlot extends TimeWindow {
  dayOfWeek: DayOfWeek;
  /** The date this specific occurrence check is being evaluated for. */
  onDate: string; // 'YYYY-MM-DD'
}

export type AvailabilityCheckResult =
  | { available: true }
  | { available: false; reason: 'no_covering_rule' | 'blocked_by_unavailable_rule' };

export type CapacityCheckResult =
  | { sufficient: true; freeMinutes: number }
  | { sufficient: false; freeMinutes: number; requiredMinutes: number; reason: 'insufficient_capacity' | 'no_capacity_slot' };

/* -------------------------------------------------------------------------- */
/* Time arithmetic                                                            */
/* -------------------------------------------------------------------------- */

/** Parses 'HH:MM' or 'HH:MM:SS' into minutes since midnight. */
export function toMinutes(time: string): number {
  const parts = time.split(':').map(Number);
  const hours = parts[0] ?? 0;
  const minutes = parts[1] ?? 0;
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    throw new Error(`Invalid time string: "${time}"`);
  }
  return hours * 60 + minutes;
}

export function windowMinutes(window: TimeWindow): number {
  const duration = toMinutes(window.endTime) - toMinutes(window.startTime);
  if (duration <= 0) {
    throw new Error(`Time window end (${window.endTime}) must be after start (${window.startTime}).`);
  }
  return duration;
}

/** Whether two time windows overlap (half-open: end is exclusive). */
export function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(b.startTime) < toMinutes(a.endTime);
}

/** Whether a requested window is fully contained within a covering window. */
function isContainedWithin(requested: TimeWindow, covering: TimeWindow): boolean {
  return toMinutes(requested.startTime) >= toMinutes(covering.startTime)
    && toMinutes(requested.endTime) <= toMinutes(covering.endTime);
}

function dateInRange(date: string, from: string, to?: string | null): boolean {
  return date >= from && (to === undefined || to === null || date <= to);
}

function ruleAppliesOnDate(rule: AvailabilityRule, dayOfWeek: DayOfWeek, onDate: string): boolean {
  if (!dateInRange(onDate, rule.effectiveFrom, rule.effectiveTo)) return false;

  if (rule.availabilityType === 'regular') {
    return rule.dayOfWeek === dayOfWeek;
  }
  // specific_date | temporary | unavailable: keyed by an exact date, not a weekday.
  return rule.specificDateOn === onDate;
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Determines whether a teacher is available for a requested slot.
 *
 * Logic:
 *   1. An 'unavailable' rule that applies on this date and overlaps the
 *      requested window blocks availability outright, regardless of any
 *      'regular'/'specific_date'/'temporary' rule that would otherwise cover it
 *      — an exception rule always wins (this is the entire point of having one).
 *   2. Otherwise, the requested window must be fully contained within at least
 *      one 'regular', 'specific_date' or 'temporary' rule that applies on this date.
 */
export function checkAvailability(
  rules: AvailabilityRule[],
  requested: RequestedSlot,
): AvailabilityCheckResult {
  const applicable = rules.filter((r) => ruleAppliesOnDate(r, requested.dayOfWeek, requested.onDate));

  const blockedByUnavailable = applicable.some(
    (r) => r.availabilityType === 'unavailable' && windowsOverlap(r, requested),
  );
  if (blockedByUnavailable) {
    return { available: false, reason: 'blocked_by_unavailable_rule' };
  }

  const coveringRule = applicable.find(
    (r) => r.availabilityType !== 'unavailable' && isContainedWithin(requested, r),
  );
  if (!coveringRule) {
    return { available: false, reason: 'no_covering_rule' };
  }

  return { available: true };
}

/* -------------------------------------------------------------------------- */
/* Capacity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Determines whether a teacher has sufficient free capacity for a requested
 * slot's duration, using the capacity row that exactly matches the slot
 * (same day/time-window) and is effective on the requested date.
 *
 * Capacity is keyed at the exact (day, start, end) granularity a class_schedule
 * would use — see teacher_capacity's slot index. A capacity row that does not
 * exactly match the requested window is not consulted; provisioning capacity
 * for a new time-slot is a separate operational action (create the
 * teacher_capacity row), not something this check infers.
 */
export function checkCapacity(
  slots: CapacitySlot[],
  requested: RequestedSlot,
): CapacityCheckResult {
  const requiredMinutes = windowMinutes(requested);

  // Compare by parsed minutes, not raw string equality: Postgres returns
  // `time` columns as 'HH:MM:SS' regardless of the 'HH:MM' format callers may
  // supply, so a naive string match silently fails to find an existing slot
  // (caught by live-database verification — every capacity-consuming test
  // reported no_capacity_slot despite the row genuinely existing).
  const slot = slots.find(
    (s) =>
      s.dayOfWeek === requested.dayOfWeek
      && toMinutes(s.startTime) === toMinutes(requested.startTime)
      && toMinutes(s.endTime) === toMinutes(requested.endTime)
      && dateInRange(requested.onDate, s.effectiveFrom, s.effectiveTo),
  );

  if (!slot) {
    return { sufficient: false, freeMinutes: 0, requiredMinutes, reason: 'no_capacity_slot' };
  }

  const freeMinutes = slot.plannedCapacityMinutes - slot.allocatedCapacityMinutes - slot.reservedMinutes;
  if (freeMinutes < requiredMinutes) {
    return { sufficient: false, freeMinutes, requiredMinutes, reason: 'insufficient_capacity' };
  }

  return { sufficient: true, freeMinutes };
}

/* -------------------------------------------------------------------------- */
/* Combined pre-check                                                          */
/* -------------------------------------------------------------------------- */

export interface SlotCheckFailure {
  slot: RequestedSlot;
  availability?: Extract<AvailabilityCheckResult, { available: false }>;
  capacity?: Extract<CapacityCheckResult, { sufficient: false }>;
}

/**
 * Checks every requested slot (a weekly schedule may span several days) and
 * returns every failure found — never just the first — so the caller can
 * report a complete picture rather than making the operator fix issues one
 * day at a time.
 */
export function checkAllSlots(
  rules: AvailabilityRule[],
  capacitySlots: CapacitySlot[],
  requestedSlots: RequestedSlot[],
): SlotCheckFailure[] {
  const failures: SlotCheckFailure[] = [];

  for (const slot of requestedSlots) {
    const availability = checkAvailability(rules, slot);
    const capacity = checkCapacity(capacitySlots, slot);

    if (!availability.available || !capacity.sufficient) {
      failures.push({
        slot,
        ...(!availability.available ? { availability } : {}),
        ...(!capacity.sufficient ? { capacity } : {}),
      });
    }
  }

  return failures;
}

/* -------------------------------------------------------------------------- */
/* Date helper                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The first occurrence of `dayOfWeek` on or after `fromDate` — the natural
 * representative date for checking a recurring weekly schedule's availability
 * and capacity: "is this rule already in effect by the time this class would
 * first meet?"
 *
 * Pure date-string arithmetic (UTC, no locale/timezone dependency) since the
 * caller supplies plain 'YYYY-MM-DD' calendar dates, not instants.
 */
export function nextOccurrenceOnOrAfter(fromDate: string, dayOfWeek: DayOfWeek): string {
  const start = new Date(`${fromDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid date string: "${fromDate}"`);
  }
  const startDay = start.getUTCDay();
  const daysToAdd = (dayOfWeek - startDay + 7) % 7;
  const result = new Date(start);
  result.setUTCDate(result.getUTCDate() + daysToAdd);
  return result.toISOString().slice(0, 10);
}
