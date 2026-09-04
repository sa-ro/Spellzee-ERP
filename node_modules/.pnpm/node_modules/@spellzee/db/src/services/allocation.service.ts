/**
 * Allocation workflow — DD §13, Master §14.
 *
 * "Allocation is not merely a teacher assignment. It represents the teacher +
 * schedule arrangement for delivery." (DD §13, rule 9) This is the SERVICE
 * layer the prompt asked for, not CRUD: every allocation change
 *
 *   1. checks teacher availability AND capacity before confirming (this
 *      module's core job), using the pure logic in @spellzee/domain so the
 *      policy itself stays unit-testable without a database;
 *   2. preserves history — the previous teacher_allocation and class_schedule
 *      rows are superseded (valid_to, is_current=false, superseded_by_id),
 *      never overwritten (Master §14.3, rule 12);
 *   3. keeps class_schedule.teacher_id and teacher_allocation.teacher_id in
 *      lockstep by writing both inside one transaction — a service-layer
 *      invariant, not a DB constraint (docs/data-model/04, §"class_schedule").
 *
 * Concurrency model: the availability/capacity pre-check and the write happen
 * in the SAME transaction. The pre-check gives a fast, clear domain error in
 * the common case; teacher_capacity's `within_plan` CHECK constraint is the
 * final authority against a race between two concurrent allocations for the
 * same slot — if both pass the pre-check on stale reads, the second writer's
 * UPDATE will violate that CHECK and this service surfaces it as
 * AllocationCapacityRaceError rather than a raw constraint violation.
 *
 * Explicitly NOT built here (out of scope for this prompt):
 *   - Merithub sync (class_schedule is created directly in 'active' status;
 *     external_id_map already has 'class_schedule'/'teacher' as valid mappable
 *     types — see 0012_class_schedule_session.sql header).
 *   - A maker-checker approval GATE on allocation itself. `approvedBy` is
 *     recorded when the caller supplies it, but the service does not require
 *     it before writing — no approval-workflow module exists yet to enforce
 *     it against. Master §22.4 lists teacher change as needing approval "per
 *     policy"; that policy is not yet built.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  checkAllSlots,
  nextOccurrenceOnOrAfter,
  windowMinutes,
  type AvailabilityRule,
  type CapacitySlot,
  type DayOfWeek,
  type RequestedSlot,
  type SlotCheckFailure,
} from '@spellzee/domain/workforce/availability';
import type { ActorContext, Database, Transaction } from '../client.js';
import { getDb, withActor } from '../client.js';
import {
  teacher,
  teacherAvailability,
  teacherCapacity,
} from '../schema/workforce.js';
import { enrollment } from '../schema/commercial.js';
import {
  classSchedule,
  teacherAllocation,
  type AllocationType,
  type ClassSchedule,
  type SessionType,
  type TeacherAllocation,
} from '../schema/operations.js';

export class AllocationError extends Error {}

/** Thrown when the teacher fails rule 25 (DD §43) before any write is attempted. */
export class TeacherNotEligibleError extends AllocationError {
  constructor(public readonly teacherPublicId: string) {
    super(`Teacher ${teacherPublicId} is not allocation-eligible (rule 25).`);
  }
}

/** Thrown when the pre-check finds the teacher unavailable or over capacity on one or more days. */
export class AllocationBlockedError extends AllocationError {
  constructor(public readonly failures: SlotCheckFailure[]) {
    super(
      `Allocation blocked: ${failures.length} requested slot(s) failed availability/capacity — ` +
        failures
          .map((f) => `day ${f.slot.dayOfWeek} ${f.slot.startTime}-${f.slot.endTime}` +
            (f.availability ? ` [${f.availability.reason}]` : '') +
            (f.capacity ? ` [${f.capacity.reason}]` : ''))
          .join('; '),
    );
  }
}

/** Thrown when the CHECK-constraint backstop catches a race the pre-check missed. */
export class AllocationCapacityRaceError extends AllocationError {
  constructor(cause: unknown) {
    super('Allocation lost a capacity race to a concurrent booking for the same slot.');
    this.cause = cause;
  }
}

export interface ScheduleInput {
  sessionType: SessionType;
  courseId: string;
  subjectId: string;
  /** 0 = Sunday .. 6 = Saturday. */
  daysOfWeek: DayOfWeek[];
  startTime: string; // 'HH:MM'
  endTime: string; // 'HH:MM'
  timezone: string; // IANA zone name
  startDate: string; // 'YYYY-MM-DD'
  plannedEndDate?: string;
}

export interface CreateAllocationInput {
  enrollmentId: string;
  teacherId: string;
  allocationType: AllocationType;
  reason: string;
  requestedBy: string;
  approvedBy?: string;
  schedule: ScheduleInput;
}

export interface AllocationResult {
  allocation: TeacherAllocation;
  schedule: ClassSchedule;
}

/* -------------------------------------------------------------------------- */
/* Availability/capacity retrieval — thin SQL, policy lives in @spellzee/domain */
/* -------------------------------------------------------------------------- */

async function loadAvailabilityRules(tx: Transaction, teacherId: string): Promise<AvailabilityRule[]> {
  const rows = await tx
    .select()
    .from(teacherAvailability)
    .where(eq(teacherAvailability.teacherId, teacherId));

  return rows.map((r) => ({
    availabilityType: r.availabilityType,
    dayOfWeek: r.dayOfWeek as DayOfWeek | null,
    specificDateOn: r.specificDateOn,
    startTime: r.startTime,
    endTime: r.endTime,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  }));
}

async function loadCapacitySlots(tx: Transaction, teacherId: string): Promise<CapacitySlot[]> {
  const rows = await tx
    .select()
    .from(teacherCapacity)
    .where(and(eq(teacherCapacity.teacherId, teacherId), eq(teacherCapacity.isCurrent, true)));

  return rows.map((r) => ({
    dayOfWeek: r.dayOfWeek as DayOfWeek,
    startTime: r.startTime,
    endTime: r.endTime,
    plannedCapacityMinutes: r.plannedCapacityMinutes,
    allocatedCapacityMinutes: r.allocatedCapacityMinutes,
    reservedMinutes: r.reservedMinutes,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  }));
}

function buildRequestedSlots(schedule: ScheduleInput): RequestedSlot[] {
  return schedule.daysOfWeek.map((dayOfWeek) => ({
    dayOfWeek,
    onDate: nextOccurrenceOnOrAfter(schedule.startDate, dayOfWeek),
    startTime: schedule.startTime,
    endTime: schedule.endTime,
  }));
}

/**
 * Applies a signed minute delta to the teacher_capacity row exactly matching
 * each requested slot, for the SAME transaction as the allocation write.
 *
 * A row missing here (deltaMinutes > 0, i.e. we are allocating, not releasing)
 * means the pre-check should already have failed with no_capacity_slot — this
 * is a defensive check against that invariant being violated by a caller that
 * bypassed checkAllSlots.
 */
async function adjustCapacity(
  tx: Transaction,
  teacherId: string,
  slots: RequestedSlot[],
  deltaMinutesPerSlot: number,
): Promise<void> {
  for (const slot of slots) {
    const result = await tx.execute(sql`
      UPDATE teacher_capacity
      SET allocated_capacity_minutes = allocated_capacity_minutes + ${deltaMinutesPerSlot}
      WHERE teacher_id = ${teacherId}::uuid
        AND day_of_week = ${slot.dayOfWeek}
        AND start_time = ${slot.startTime}
        AND end_time = ${slot.endTime}
        AND is_current
      RETURNING id
    `);

    if (result.rows.length === 0 && deltaMinutesPerSlot > 0) {
      throw new AllocationError(
        `No current capacity row for teacher ${teacherId} at day ${slot.dayOfWeek} ` +
          `${slot.startTime}-${slot.endTime} — the availability/capacity pre-check should ` +
          'have caught this before any write was attempted.',
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* createAllocation — the core workflow                                       */
/* -------------------------------------------------------------------------- */

/**
 * Creates a new allocation for an enrollment — a fresh admission, or any
 * change (teacher/schedule/day/session-type/course change, break, resume).
 *
 * Steps, all inside one transaction:
 *   1. Confirm the teacher is allocation-eligible (rule 25) — checked here so
 *      the caller gets a clean domain error instead of relying solely on the
 *      DB trigger backstop (trg_teacher_allocation_eligible).
 *   2. Check availability + capacity for every requested day (the prompt's
 *      explicit requirement) via @spellzee/domain's checkAllSlots.
 *   3. Supersede the current class_schedule for this enrollment, if any.
 *   4. Insert the new class_schedule (status='active' — no Merithub
 *      integration to await in Phase 1).
 *   5. Supersede the current teacher_allocation for this enrollment, if any.
 *   6. Insert the new teacher_allocation, carrying previous_teacher_id and
 *      previous_class_schedule_id (Master §14.3).
 *   7. Release capacity held by the previous schedule (if any) and consume
 *      capacity for the new schedule.
 */
export async function createAllocation(
  ctx: ActorContext,
  input: CreateAllocationInput,
  db: Database = getDb(),
): Promise<AllocationResult> {
  return withActor(
    { ...ctx, reason: input.reason },
    async (tx) => {
      const [enr] = await tx.select().from(enrollment).where(eq(enrollment.id, input.enrollmentId));
      if (!enr) {
        throw new AllocationError(`Enrollment ${input.enrollmentId} not found.`);
      }

      const [tch] = await tx.select().from(teacher).where(eq(teacher.id, input.teacherId));
      if (!tch) {
        throw new AllocationError(`Teacher ${input.teacherId} not found.`);
      }
      // Rule 25, checked here (not just left to the DB trigger backstop) so
      // the caller gets a clean, catchable domain error.
      if (!tch.isAllocationEligible) {
        throw new TeacherNotEligibleError(tch.publicId);
      }

      const requestedSlots = buildRequestedSlots(input.schedule);
      const [rules, capacitySlots] = await Promise.all([
        loadAvailabilityRules(tx, input.teacherId),
        loadCapacitySlots(tx, input.teacherId),
      ]);

      const failures = checkAllSlots(rules, capacitySlots, requestedSlots);
      if (failures.length > 0) {
        throw new AllocationBlockedError(failures);
      }

      // --- Preserve history: find what this change replaces, before writing anything. ---
      const [previousSchedule] = await tx
        .select()
        .from(classSchedule)
        .where(and(eq(classSchedule.enrollmentId, input.enrollmentId), eq(classSchedule.isCurrent, true)));

      const [previousAllocation] = await tx
        .select()
        .from(teacherAllocation)
        .where(and(eq(teacherAllocation.enrollmentId, input.enrollmentId), eq(teacherAllocation.isCurrent, true)));

      // --- class_schedule: supersede old, insert new. ---
      if (previousSchedule) {
        await tx
          .update(classSchedule)
          .set({
            isCurrent: false,
            validTo: new Date(),
            changeReason: input.reason,
          })
          .where(eq(classSchedule.id, previousSchedule.id));
      }

      const [newSchedule] = await tx
        .insert(classSchedule)
        .values({
          enrollmentId: input.enrollmentId,
          teacherId: input.teacherId,
          sessionType: input.schedule.sessionType,
          courseId: input.schedule.courseId,
          subjectId: input.schedule.subjectId,
          daysOfWeek: input.schedule.daysOfWeek,
          startTime: input.schedule.startTime,
          endTime: input.schedule.endTime,
          timezone: input.schedule.timezone,
          startDate: input.schedule.startDate,
          plannedEndDate: input.schedule.plannedEndDate ?? null,
          status: 'active',
          changeReason: previousSchedule ? input.reason : null,
          requestedBy: input.requestedBy,
          approvedBy: input.approvedBy ?? null,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();

      if (!newSchedule) {
        throw new AllocationError('Failed to insert class_schedule.');
      }

      if (previousSchedule) {
        await tx
          .update(classSchedule)
          .set({ supersededById: newSchedule.id })
          .where(eq(classSchedule.id, previousSchedule.id));
      }

      // --- teacher_allocation: supersede old, insert new. ---
      if (previousAllocation) {
        await tx
          .update(teacherAllocation)
          .set({ isCurrent: false, validTo: new Date(), status: 'superseded' })
          .where(eq(teacherAllocation.id, previousAllocation.id));
      }

      const [newAllocation] = await tx
        .insert(teacherAllocation)
        .values({
          enrollmentId: input.enrollmentId,
          studentId: enr.studentId,
          teacherId: input.teacherId,
          classScheduleId: newSchedule.id,
          allocationType: input.allocationType,
          previousTeacherId: previousAllocation?.teacherId ?? null,
          previousClassScheduleId: previousSchedule?.id ?? null,
          reason: input.reason,
          requestedBy: input.requestedBy,
          approvedBy: input.approvedBy ?? null,
          status: 'active',
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();

      if (!newAllocation) {
        throw new AllocationError('Failed to insert teacher_allocation.');
      }

      if (previousAllocation) {
        await tx
          .update(teacherAllocation)
          .set({ supersededById: newAllocation.id })
          .where(eq(teacherAllocation.id, previousAllocation.id));
      }

      // --- Capacity bookkeeping: release the old schedule's slots (any
      // teacher), consume the new schedule's slots. The CHECK-constraint
      // backstop (teacher_capacity_within_plan) is the final race guard. ---
      try {
        if (previousSchedule) {
          const previousDuration = windowMinutes({
            startTime: previousSchedule.startTime,
            endTime: previousSchedule.endTime,
          });
          const previousSlots = (previousSchedule.daysOfWeek as DayOfWeek[]).map((dayOfWeek) => ({
            dayOfWeek,
            onDate: nextOccurrenceOnOrAfter(previousSchedule.startDate, dayOfWeek),
            startTime: previousSchedule.startTime,
            endTime: previousSchedule.endTime,
          }));
          await adjustCapacity(tx, previousSchedule.teacherId, previousSlots, -previousDuration);
        }

        const newDuration = windowMinutes(input.schedule);
        await adjustCapacity(tx, input.teacherId, requestedSlots, newDuration);
      } catch (err) {
        if (err instanceof AllocationError) throw err;
        throw new AllocationCapacityRaceError(err);
      }

      return { allocation: newAllocation, schedule: newSchedule };
    },
    db,
  );
}

/* -------------------------------------------------------------------------- */
/* changeTeacher — the common case, wrapping createAllocation                  */
/* -------------------------------------------------------------------------- */

export interface ChangeTeacherInput {
  enrollmentId: string;
  newTeacherId: string;
  reason: string;
  requestedBy: string;
  approvedBy?: string;
}

/**
 * Swaps the teacher for an enrollment's CURRENT schedule, keeping every other
 * schedule attribute (days, time, timezone, course, subject, dates) unchanged.
 * A thin, explicit wrapper over createAllocation for the most common change —
 * Master §14.3's "old teacher ... new teacher, reason, initiator, effective
 * date" is exactly what createAllocation already preserves.
 */
export async function changeTeacher(
  ctx: ActorContext,
  input: ChangeTeacherInput,
  db: Database = getDb(),
): Promise<AllocationResult> {
  const [currentSchedule] = await db
    .select()
    .from(classSchedule)
    .where(and(eq(classSchedule.enrollmentId, input.enrollmentId), eq(classSchedule.isCurrent, true)));

  if (!currentSchedule) {
    throw new AllocationError(
      `Enrollment ${input.enrollmentId} has no current class_schedule to change the teacher on.`,
    );
  }

  return createAllocation(
    ctx,
    {
      enrollmentId: input.enrollmentId,
      teacherId: input.newTeacherId,
      allocationType: 'teacher_change',
      reason: input.reason,
      requestedBy: input.requestedBy,
      // exactOptionalPropertyTypes: these fields must be OMITTED, not set to
      // `undefined` — a present-but-undefined key is a different (rejected)
      // shape than an absent one.
      ...(input.approvedBy !== undefined ? { approvedBy: input.approvedBy } : {}),
      schedule: {
        sessionType: currentSchedule.sessionType,
        courseId: currentSchedule.courseId,
        subjectId: currentSchedule.subjectId,
        daysOfWeek: currentSchedule.daysOfWeek as DayOfWeek[],
        startTime: currentSchedule.startTime,
        endTime: currentSchedule.endTime,
        timezone: currentSchedule.timezone,
        startDate: currentSchedule.startDate,
        ...(currentSchedule.plannedEndDate !== null
          ? { plannedEndDate: currentSchedule.plannedEndDate }
          : {}),
      },
    },
    db,
  );
}
