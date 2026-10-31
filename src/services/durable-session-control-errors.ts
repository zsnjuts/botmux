/**
 * A standby replica discovered control work for a Session whose exact owner
 * still holds the distributed lease. This is a routing handoff, not a backend
 * failure: re-expose the Inbox row quickly so the owner can claim it instead
 * of paying the ordinary multi-second effect retry delay.
 */
export class DurableSessionControlOwnerHandoffError extends Error {
  override name = 'DurableSessionControlOwnerHandoffError';
}

/** A read-only orphan proof was unavailable or disproved. Keep the durable
 * control pending, but avoid hammering the provider control plane. */
export class DurableSessionControlDeferredError extends Error {
  override name = 'DurableSessionControlDeferredError';
}

/** The canonical active Session can never be taken over by any replica (for
 * example its Remote Runner never published a resumable remote session). A
 * lifecycle control must settle it instead of retrying the takeover forever. */
export class DurableActiveTakeoverUnsupportedError extends Error {
  override name = 'DurableActiveTakeoverUnsupportedError';
}
