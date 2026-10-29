const MIN_LARK_CREATE_TIME_MS = 1_000_000_000_000;
const MAX_LARK_CREATE_TIME_MS = 9_999_999_999_999;
const MAX_LARK_CREATE_TIME_FUTURE_SKEW_MS = 5 * 60_000;

/** Normalize a raw Lark create_time without accepting JavaScript numeric
 * syntax such as hex, exponent notation, fractions or surrounding whitespace.
 * Lark's millisecond epoch is a canonical 13-digit decimal string; a small
 * future allowance covers clock skew but cannot turn an arbitrary future date
 * into scheduling authority. */
export function normalizeScheduleSourceMessageCreateTime(
  value: unknown,
  nowMs = Date.now(),
): number | undefined {
  if (typeof value === 'string' && !/^[1-9][0-9]{12}$/.test(value)) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(normalized)
      || normalized < MIN_LARK_CREATE_TIME_MS
      || normalized > MAX_LARK_CREATE_TIME_MS
      || !Number.isFinite(nowMs)
      || normalized > nowMs + MAX_LARK_CREATE_TIME_FUTURE_SKEW_MS) {
    return undefined;
  }
  return normalized;
}

/** Return the platform-authored countdown anchor for a schedule created from a
 * live turn. Admission/tool time is deliberately not a substitute: callers
 * that parse a relative schedule must fail closed when this is unavailable. */
export function resolveScheduleReferenceTime(input: {
  sourceMessageCreateTime?: number;
}): number | undefined {
  return normalizeScheduleSourceMessageCreateTime(input.sourceMessageCreateTime);
}
