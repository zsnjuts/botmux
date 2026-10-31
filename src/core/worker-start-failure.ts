/**
 * Which user-facing text a worker startup failure gets.
 *
 * The generic text asks the user to check Dashboard backend settings and resend.
 * A Remote Runner whose persisted remote state disagrees with the Session record
 * cannot be fixed by either: resending only repeats the same refusal. Point the
 * user at /close and a new topic instead (Mew #101 follow-up).
 */
const REMOTE_STATE_FORK_RE = /does not match (?:durable state|orphan control state)/;

export function workerStartFailedMessageKey(
  reason: string,
): 'worker.start_failed' | 'worker.start_failed_state_mismatch' {
  return REMOTE_STATE_FORK_RE.test(reason) ? 'worker.start_failed_state_mismatch' : 'worker.start_failed';
}
