/** Return the platform-authored countdown anchor for a schedule created from a
 * live turn. Admission/tool time is deliberately not a substitute: callers
 * that parse a relative schedule must fail closed when this is unavailable. */
export function resolveScheduleReferenceTime(input: {
  sourceMessageCreateTime?: number;
}): number | undefined {
  const sourceMessageCreateTime = input.sourceMessageCreateTime;
  if (typeof sourceMessageCreateTime === 'number'
      && Number.isFinite(sourceMessageCreateTime)
      && sourceMessageCreateTime > 0) {
    return sourceMessageCreateTime;
  }
  return undefined;
}
