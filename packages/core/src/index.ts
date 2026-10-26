export const CORE_VERSION = '0.1.0';

export * from './config/index.ts';
export {
  activeSchedules,
  isScheduleActive,
  isScheduleWindowActive,
  utcDate,
  type ScheduleDay,
  type ScheduleEvaluation,
  type ScheduleMatch,
} from './schedule.ts';
