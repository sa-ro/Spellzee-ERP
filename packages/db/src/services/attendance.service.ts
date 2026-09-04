/**
 * Attendance recording — thresholds read LIVE from policy_parameter (rule 28),
 * classification via the pure domain function in @spellzee/domain.
 */

import { and, eq } from 'drizzle-orm';
import { classifyAttendance } from '@spellzee/domain/delivery/attendance';
import type { ActorContext, Database, Transaction } from '../client.js';
import { getDb, withActor } from '../client.js';
import { attendance, type Attendance } from '../schema/attendance.js';
import { policyParameter } from '../schema/platform.js';
import { MissingPolicyParameterError } from './compensation.service.js';

export class AttendanceError extends Error {}

export class DuplicateAttendanceError extends AttendanceError {
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} already has an attendance record.`);
  }
}

export { MissingPolicyParameterError };

const PRESENT_THRESHOLD_KEY = 'attendance_present_threshold_pct';
const PARTIAL_THRESHOLD_KEY = 'attendance_partial_threshold_pct';
const LATE_MINUTES_KEY = 'attendance_late_minutes';

async function loadPolicyNumber(tx: Transaction, key: string): Promise<number> {
  const [row] = await tx
    .select()
    .from(policyParameter)
    .where(and(eq(policyParameter.key, key), eq(policyParameter.isCurrent, true)));
  if (!row) {
    throw new MissingPolicyParameterError(key);
  }
  const value = Number(row.value);
  if (!Number.isFinite(value)) {
    throw new AttendanceError(`policy_parameter "${key}" has a non-numeric value.`);
  }
  return value;
}

export interface RecordAttendanceInput {
  sessionId: string;
  studentId: string;
  presentMinutes: number;
  totalMinutes: number;
  lateByMinutes: number;
  notes?: string;
}

export async function recordAttendance(
  ctx: ActorContext,
  input: RecordAttendanceInput,
  db: Database = getDb(),
): Promise<Attendance> {
  return withActor(
    ctx,
    async (tx) => {
      const [existing] = await tx.select().from(attendance).where(eq(attendance.sessionId, input.sessionId));
      if (existing) {
        throw new DuplicateAttendanceError(input.sessionId);
      }

      // Cutoff-style live policy reads, in a fixed order so the "no policy"
      // test always fails on the first key deterministically.
      const presentThresholdPct = await loadPolicyNumber(tx, PRESENT_THRESHOLD_KEY);
      const partialThresholdPct = await loadPolicyNumber(tx, PARTIAL_THRESHOLD_KEY);
      const lateMinutes = await loadPolicyNumber(tx, LATE_MINUTES_KEY);

      const status = classifyAttendance(
        {
          presentMinutes: input.presentMinutes,
          totalMinutes: input.totalMinutes,
          lateByMinutes: input.lateByMinutes,
        },
        { presentThresholdPct, partialThresholdPct, lateMinutes },
      );

      const [record] = await tx
        .insert(attendance)
        .values({
          sessionId: input.sessionId,
          studentId: input.studentId,
          attendanceStatus: status,
          presentMinutes: input.presentMinutes,
          totalMinutes: input.totalMinutes,
          lateByMinutes: input.lateByMinutes,
          notes: input.notes ?? null,
          recordedBy: ctx.actorId,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();
      if (!record) {
        throw new AttendanceError('Failed to insert the attendance record.');
      }
      return record;
    },
    db,
  );
}
