import type { Session } from '../types.js';

export type DurablePrimaryExistingTurnDisposition = 'committed' | 'retry' | 'ready';
export type DurablePrimaryRejectedLiveSendDisposition = 'retry' | 'ignored';
export type DurablePrimaryInputCommit = NonNullable<Session['durablePrimaryInputCommits']>[number];
export type DurablePrimaryWorkerStartBlocker = 'pending-repo' | 'in-flight-claim';

export interface DurablePrimaryTurnRuntimeState {
  session: Pick<Session, 'durablePrimaryInputCommits'>;
  worker?: { killed?: boolean } | null;
  cliReady?: boolean;
  activeInteractiveTurn?: unknown;
  /** This exact ingress was independently authorized as a subordinate steer of
   * the active turn. It may cross the busy gate and does not wait for
   * `cliReady` (a session opened with a prompt reports its first prompt_ready
   * only after that turn ends); it still requires a live worker, and the
   * provider itself rejects a steer without an acknowledged active turn. All
   * other active-turn input remains retry-only. */
  allowActiveTurnSteer?: boolean;
  /** A real worker-null start conflict, never a durable recovery journal. */
  workerStartBlocker?: DurablePrimaryWorkerStartBlocker;
}

/** Pure admission decision used before any daemon-side business-turn effect. */
export function durablePrimaryExistingTurnDisposition(
  state: DurablePrimaryTurnRuntimeState,
  turnId: string,
): DurablePrimaryExistingTurnDisposition {
  if (state.session.durablePrimaryInputCommits?.some(item => item.turnId === turnId)) {
    return 'committed';
  }
  return durablePrimarySessionAdmitsTurns(state) ? 'ready' : 'retry';
}

/** Whether the Session would admit a not-yet-committed turn right now. A
 * turn retried because this was false becomes deliverable once it is true. */
export function durablePrimarySessionAdmitsTurns(state: DurablePrimaryTurnRuntimeState): boolean {
  if (!state.worker || state.worker.killed) {
    // A dead/missing worker is recoverable through the existing cold-refork
    // path. Treating it as merely busy would leave the durable Inbox row in an
    // unbounded retry loop while this replica keeps renewing the Session lease.
    // Only an already-owned start boundary must remain retry-only.
    return !state.workerStartBlocker;
  }
  if (state.allowActiveTurnSteer) return true;
  return !!state.cliReady && !state.activeInteractiveTurn;
}

/** A primary Inbox claim cannot settle until the worker proves input acceptance. */
export function durablePrimaryRejectedLiveSendDisposition(
  durablePrimaryDispatch: boolean,
): DurablePrimaryRejectedLiveSendDisposition {
  return durablePrimaryDispatch ? 'retry' : 'ignored';
}

/** Primary retries remain replayable until canonical admission is committed.
 * An admitted attempt that still asked the Inbox to retry (its provider
 * receipt wait expired) must stay replayable too: only the redelivery can see
 * the late receipt and commit the canonical admission (Mew #72). */
export function shouldPersistTriggeredMessage(input: {
  durablePrimaryDispatch: boolean;
  handlerCompleted: boolean;
  admitted: boolean;
  retryPending?: boolean;
}): boolean {
  return input.durablePrimaryDispatch
    ? input.admitted && !input.retryPending
    : input.handlerCompleted || input.admitted;
}

export function appendDurablePrimaryInputCommit(
  previous: readonly DurablePrimaryInputCommit[],
  input: Omit<DurablePrimaryInputCommit, 'version'>,
  limit: number,
): { history: DurablePrimaryInputCommit[]; added: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('durable primary input commit limit must be positive');
  }
  if (previous.some(item => item.turnId === input.turnId)) {
    return { history: [...previous], added: false };
  }
  return {
    history: [...previous, { version: 1 as const, ...input }].slice(-limit),
    added: true,
  };
}
