import { describe, expect, it } from 'vitest';
import { resolveScheduleReferenceTime } from '../src/core/schedule-reference-time.js';
import { parseNaturalSchedule, parseSchedule } from '../src/core/scheduler.js';

describe('schedule reference time', () => {
  it('prefers the source Lark message timestamp over later tool admission', () => {
    expect(resolveScheduleReferenceTime({
      sourceMessageCreateTime: Date.parse('2026-10-25T05:57:42.000Z'),
    })).toBe(Date.parse('2026-10-25T05:57:42.000Z'));
  });

  it('does not substitute daemon admission or current time', () => {
    expect(resolveScheduleReferenceTime({})).toBeUndefined();
    expect(resolveScheduleReferenceTime({ sourceMessageCreateTime: 0 })).toBeUndefined();
  });

  it.each(['30m', '2 hours', '30分钟后', '2小时后', '明天 09:00', '明天09:00'])(
    'fails closed for relative schedule %s without a trusted platform time', schedule => {
      expect(() => parseSchedule(schedule, undefined, {
        requireTrustedReferenceTime: true,
      })).toThrow('schedule_reference_time_unavailable');
    },
  );

  it('rejects an explicit zero sentinel instead of treating it as Unix epoch', () => {
    expect(() => parseSchedule('30m', 0, {
      requireTrustedReferenceTime: true,
    })).toThrow('invalid schedule reference time');
  });

  it('still accepts absolute and recurring schedules without a reference time', () => {
    expect(parseSchedule('0 9 * * *', undefined, { requireTrustedReferenceTime: true }).kind)
      .toBe('cron');
    expect(parseSchedule('2026-10-26T09:00:00+08:00', undefined, {
      requireTrustedReferenceTime: true,
    }).kind).toBe('once');
    expect(parseNaturalSchedule('每日 09:00 检查状态', undefined, {
      requireTrustedReferenceTime: true,
    })?.parsed.kind).toBe('cron');
    expect(() => parseNaturalSchedule('30分钟后 检查状态', undefined, {
      requireTrustedReferenceTime: true,
    })).toThrow('schedule_reference_time_unavailable');
  });
});
