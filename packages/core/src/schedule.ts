import type { ScheduleConfig, ScheduleWindow } from './config/types.ts';

/**
 * Schedule evaluation.
 *
 * Schedules are wall-clock windows ("record 08:00-18:00 on weekdays"). Evaluation
 * is done in UTC because the container clock is what the recordings are stamped
 * with; `system.timezone` is advisory and a per-schedule `timezone` is accepted
 * but not yet converted. Getting this wrong would silently record nothing, so the
 * limitation is documented rather than papered over.
 */

export type ScheduleDay = ScheduleWindow['days'][number];

const DAY_KEYS: ScheduleDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface ScheduleMatch {
  scheduleId: string;
  name: string;
}

export interface ScheduleEvaluation {
  active: boolean;
  matches: ScheduleMatch[];
}

export function isScheduleWindowActive(window: ScheduleWindow, at: Date): boolean {
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === undefined || end === undefined || start === end) return false;

  const today = DAY_KEYS[at.getUTCDay()]!;
  if (start < end) {
    return window.days.includes(today) && minutes >= start && minutes < end;
  }

  // Overnight window: it belongs to the day it started on.
  const yesterday = DAY_KEYS[(at.getUTCDay() + 6) % 7]!;
  return (window.days.includes(today) && minutes >= start) || (window.days.includes(yesterday) && minutes < end);
}

export function isScheduleActive(schedule: ScheduleConfig, at: Date): boolean {
  if (schedule.exceptions?.some((exception) => exception.date === utcDate(at) && exception.closed === true)) {
    return false;
  }
  return schedule.windows.some((window) => isScheduleWindowActive(window, at));
}

/** Schedules active right now, optionally restricted to the ids a camera names. */
export function activeSchedules(
  schedules: ScheduleConfig[] | undefined,
  at: Date,
  ids?: string[],
): ScheduleEvaluation {
  const matches: ScheduleMatch[] = [];
  for (const schedule of schedules ?? []) {
    if (ids !== undefined && ids.length > 0 && !ids.includes(schedule.id)) continue;
    if (isScheduleActive(schedule, at)) matches.push({ scheduleId: schedule.id, name: schedule.name });
  }
  return { active: matches.length > 0, matches };
}

export function utcDate(at: Date): string {
  const year = at.getUTCFullYear();
  const month = `${at.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${at.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseClock(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}
