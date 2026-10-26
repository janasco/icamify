import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activeSchedules, isScheduleActive, utcDate } from '../src/schedule.ts';
import type { ScheduleConfig } from '../src/config/types.ts';

function schedule(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    id: 'work',
    name: 'Work hours',
    windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '18:00' }],
    ...overrides,
  };
}

// 2026-10-26 is a Monday.
const monday = (hours: number, minutes = 0): Date => new Date(Date.UTC(2026, 9, 26, hours, minutes));

describe('schedules', () => {
  it('matches inside a weekday window', () => {
    assert.equal(isScheduleActive(schedule(), monday(9)), true);
    assert.equal(isScheduleActive(schedule(), monday(7, 59)), false);
    assert.equal(isScheduleActive(schedule(), monday(18)), false, 'end is exclusive');
    assert.equal(isScheduleActive(schedule(), monday(17, 59)), true);
  });

  it('does not match on a day the window excludes', () => {
    // Sunday.
    assert.equal(isScheduleActive(schedule(), new Date(Date.UTC(2026, 9, 25, 12))), false);
  });

  it('supports overnight windows that belong to their start day', () => {
    const night = schedule({ windows: [{ days: ['mon'], start: '22:00', end: '06:00' }] });
    assert.equal(isScheduleActive(night, monday(23)), true);
    // Tuesday 02:00 still belongs to Monday's window.
    assert.equal(isScheduleActive(night, new Date(Date.UTC(2026, 9, 27, 2))), true);
    assert.equal(isScheduleActive(night, new Date(Date.UTC(2026, 9, 27, 7))), false);
    // Sunday 23:00 is not Monday yet.
    assert.equal(isScheduleActive(night, new Date(Date.UTC(2026, 9, 25, 23))), false);
  });

  it('honours closed exceptions', () => {
    const holiday = schedule({ exceptions: [{ date: utcDate(monday(9)), closed: true }] });
    assert.equal(isScheduleActive(holiday, monday(9)), false);
    assert.equal(isScheduleActive(holiday, monday(9, 30)) === false, true);
  });

  it('ignores malformed clock values instead of matching everything', () => {
    const broken = schedule({ windows: [{ days: ['mon'], start: 'noon', end: '18:00' }] });
    assert.equal(isScheduleActive(broken, monday(9)), false);
  });

  it('reports the matching schedules, optionally filtered by camera ids', () => {
    const schedules: ScheduleConfig[] = [
      schedule(),
      { id: 'night', name: 'Night', windows: [{ days: ['mon'], start: '00:00', end: '06:00' }] },
    ];
    const all = activeSchedules(schedules, monday(9));
    assert.equal(all.active, true);
    assert.deepEqual(all.matches.map((match) => match.scheduleId), ['work']);

    const filtered = activeSchedules(schedules, monday(9), ['night']);
    assert.equal(filtered.active, false);

    const unrestricted = activeSchedules(undefined, monday(9));
    assert.equal(unrestricted.active, false);
  });
});
