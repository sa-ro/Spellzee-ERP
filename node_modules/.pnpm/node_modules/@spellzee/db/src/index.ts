export {
  getDb,
  createPool,
  closeDb,
  withActor,
  archiveRecord,
  recordBlockedAttempt,
  type Database,
  type Transaction,
  type ActorContext,
} from './client.js';

export * from './schema/index.js';
export * as schema from './schema/index.js';

export {
  findDuplicateCandidates,
  recordMatchDecision,
  resolveSurvivingStudent,
  type DuplicateSearchInput,
  type DuplicateSearchResult,
} from './services/identity-match.service.js';

export {
  createAllocation,
  changeTeacher,
  AllocationError,
  TeacherNotEligibleError,
  AllocationBlockedError,
  AllocationCapacityRaceError,
  type CreateAllocationInput,
  type ChangeTeacherInput,
  type ScheduleInput,
  type AllocationResult,
} from './services/allocation.service.js';

export {
  transferOwnership,
  getOwnershipHistory,
  getCurrentOwner,
  OwnershipError,
  type TransferOwnershipInput,
  type TransferOwnershipResult,
} from './services/coordinator-ownership.service.js';

export {
  createCompensation,
  completeCompensation,
  expireCompensations,
  CompensationError,
  SessionNotQualifiedError,
  DuplicateCompensationError,
  CompensationNotScheduledError,
  MissingPolicyParameterError,
  type CreateCompensationInput,
  type CompensationResult,
  type CompleteCompensationInput,
  type CompleteCompensationResult,
} from './services/compensation.service.js';

export {
  createReschedule,
  RescheduleError,
  SessionNotReschedulableError,
  MaxReschedulesExceededError,
  // MissingPolicyParameterError intentionally NOT re-exported here — it's
  // the same class already exported above from compensation.service.js;
  // reschedule.service.js re-uses it rather than defining a duplicate.
  type CreateRescheduleInput,
  type RescheduleResult,
} from './services/reschedule.service.js';

export {
  recordAttendance,
  AttendanceError,
  DuplicateAttendanceError,
  type RecordAttendanceInput,
} from './services/attendance.service.js';

export {
  createAdmissionHandover,
  acknowledgeHandover,
  AdmissionHandoverError,
  HandoverNotPendingError,
  type CreateAdmissionHandoverInput,
  type AcknowledgeHandoverInput,
} from './services/admission-handover.service.js';

export {
  createTicket,
  resolveTicket,
  checkSlaBreaches,
  SupportError,
  SlaPolicyNotFoundError,
  TicketNotOpenError,
  type CreateTicketInput,
  type CreateTicketResult,
  type ResolveTicketInput,
  type ResolveTicketResult,
  type CheckSlaBreachesResult,
} from './services/support.service.js';
