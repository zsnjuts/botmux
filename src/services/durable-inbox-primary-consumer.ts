import { randomUUID } from 'node:crypto';
import {
  DURABLE_INBOX_LANE_LARK_MESSAGE,
  type DurableInboxStore,
  type InboxClaim,
} from './durable-coordination.js';
import {
  parseDurableLarkMessageClaim,
  type DurableLarkMessageClaim,
} from './durable-inbox-shadow.js';
import {
  parseDurableLarkAdmissionReceipt,
  type DurableLarkAdmissionReceipt,
} from './durable-lark-admission.js';

export type DurableInboxPrimaryDispatchResult =
  | { kind: 'committed'; receipt: DurableLarkAdmissionReceipt }
  | { kind: 'ignored'; reason: string }
  /** `wakeKey`: the event waits for a condition this process can observe
   * (e.g. one Session finishing its turn). It is redelivered as soon as
   * {@link DurableInboxPrimaryConsumer.wakeRetry} names that key, and no later
   * than the ordinary retry delay.
   * `retryAfterMs`: an earlier, bounded redelivery hint for retries that some
   * other live replica is expected to resolve by claiming the event itself
   * (for example the Session owner). Never later than the ordinary delay.
   * This consumer then stops claiming until that replica has polled at least
   * once after the event became visible again (Mew #93). */
  | { kind: 'retry'; reason: string; wakeKey?: string; retryAfterMs?: number };

export interface DurableInboxPrimaryDispatchContext {
  claim: InboxClaim;
  signal: AbortSignal;
}

export interface DurableInboxPrimaryCommit {
  message: DurableLarkMessageClaim;
  result: DurableInboxPrimaryDispatchResult;
}

export interface DurableInboxPrimaryRetry {
  message: DurableLarkMessageClaim;
  result: Extract<DurableInboxPrimaryDispatchResult, { kind: 'retry' }>;
}

export interface DurableInboxPrimaryExhausted {
  message: DurableLarkMessageClaim;
  attempts: number;
}

export interface DurableInboxPrimaryStopResult {
  kind: 'stopped' | 'timed_out';
  inFlight: number;
}

export interface DurableInboxPrimaryConsumer {
  readonly workerId: string;
  ready: Promise<void>;
  /** Claim now instead of on the next poll tick (e.g. right after this process
   * enqueued an event). Same claim path, fencing and FIFO as the tick. */
  wake(): void;
  /** Redeliver retried events that are waiting on `wakeKey` now instead of at
   * their retry delay. Unknown keys are a no-op. */
  wakeRetry(wakeKey: string): void;
  stop(timeoutMs?: number): Promise<DurableInboxPrimaryStopResult>;
  terminate(): void;
}

export interface DurableInboxPrimaryConsumerOptions {
  store: DurableInboxStore;
  /** 生产默认值包含进程与随机 boot identity；显式值仅用于测试。 */
  workerId?: string;
  dispatch(
    message: DurableLarkMessageClaim,
    context: DurableInboxPrimaryDispatchContext,
  ): Promise<DurableInboxPrimaryDispatchResult>;
  intervalMs?: number;
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
  retryDelayMs?: number;
  /** Stop retrying one permanently failing row before it can block the whole partition forever. */
  maxAttempts?: number;
  concurrency?: number;
  batchSize?: number;
  shutdownMs?: number;
  now?: () => number;
  onCommitted?: (commit: DurableInboxPrimaryCommit) => void;
  /** Runs only after the claim is durably returned to queued.  Failures are
   * observational: they never complete or poison the retained Inbox row. */
  onRetried?: (retry: DurableInboxPrimaryRetry) => void | Promise<void>;
  /** Runs after a failing row was completed at the retry limit, i.e. dropped.
   * Observational like onRetried: it cannot reopen the completed row. */
  onExhausted?: (exhausted: DurableInboxPrimaryExhausted) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

interface Slot {
  index: number;
  running?: Promise<void>;
}

/** A retried claim that waits for its wake key. It stays claimed — and so keeps
 * its partition blocked exactly like a queued, not-yet-visible retry — until it
 * is handed back to the queue by a wake, its retry deadline, or shutdown. */
interface ParkedRetry {
  claim: InboxClaim;
  message: DurableLarkMessageClaim;
  result: Extract<DurableInboxPrimaryDispatchResult, { kind: 'retry' }>;
  wakeKey: string;
  /** When the ordinary retry would have become visible. */
  deadline: number;
  /** Resolves once the claim lease was cut to the retry window. */
  leased: Promise<'applied' | 'stale' | 'unknown'>;
  timer?: NodeJS.Timeout;
  released?: Promise<void>;
}

/** Slack between a parked retry's deadline and its shortened claim lease, so a
 * slightly late hand-back still owns the claim. */
const PARKED_RETRY_LEASE_SLACK_MS = 2_000;
/** Floor for a dispatch-provided early retry hint, so a hint cannot spin the queue. */
const MIN_RETRY_HINT_MS = 100;
/** Margin past the peer's next poll before this consumer claims again. Without
 * the pause both replicas poll on a fixed grid, and whichever polls first after
 * the hand-back keeps winning the same event (Mew #93: up to 6 claims in a row). */
const PEER_CLAIM_YIELD_SLACK_MS = 200;

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function workerIdFrom(value: string | undefined): string {
  const workerId = (value ?? `primary-inbox:${process.pid}:${randomUUID()}`).trim();
  if (!workerId || workerId.length > 240) {
    throw new Error('durable inbox primary workerId must contain at most 240 non-empty characters');
  }
  return workerId;
}

function timeoutPromise(ms: number): { promise: Promise<false>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    promise: new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), ms);
    }),
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Provider-neutral durable inbox handler for a later primary route.
 *
 * The dispatch callback must return only after the event is durably classified
 * as committed or ignored. A committed result includes the fenced Session
 * epoch/revision receipt and is revalidated against the claimed inbox identity.
 * Merely appending work to an in-memory queue is not a commit receipt. A
 * stale/failed claim renewal aborts the callback and prevents complete/retry
 * mutations, leaving the row recoverable after its lease.
 *
 * This service deliberately does not wire itself into the daemon. The Lark ACK
 * path must first prove pre-ACK durable enqueue and the existing message router
 * must expose a real durable-admission receipt; until then `primary` stays
 * fail-closed.
 */
export function startDurableInboxPrimaryConsumer(
  options: DurableInboxPrimaryConsumerOptions,
): DurableInboxPrimaryConsumer {
  const workerId = workerIdFrom(options.workerId);
  const intervalMs = boundedInteger(options.intervalMs ?? 500, 'intervalMs', 10, 60_000);
  const leaseDurationMs = boundedInteger(
    options.leaseDurationMs ?? 60_000,
    'leaseDurationMs',
    1_000,
    300_000,
  );
  const renewalIntervalMs = boundedInteger(
    options.renewalIntervalMs ?? Math.max(250, Math.floor(leaseDurationMs / 3)),
    'renewalIntervalMs',
    100,
    leaseDurationMs - 1,
  );
  const retryDelayMs = boundedInteger(options.retryDelayMs ?? 5_000, 'retryDelayMs', 100, 3_600_000);
  const maxAttempts = boundedInteger(options.maxAttempts ?? 16, 'maxAttempts', 1, 1_000);
  const concurrency = boundedInteger(options.concurrency ?? 4, 'concurrency', 1, 32);
  const batchSize = boundedInteger(options.batchSize ?? 32, 'batchSize', 1, 1_000);
  const shutdownMs = boundedInteger(options.shutdownMs ?? 5_000, 'shutdownMs', 0, 300_000);
  const now = options.now ?? Date.now;
  const slots: Slot[] = Array.from({ length: concurrency }, (_, index) => ({ index }));
  const controllers = new Set<AbortController>();
  const parked = new Map<string, ParkedRetry>();
  // A crash while parked must not hide the row much longer than the retry it
  // replaces: cut the claim lease to the retry window (plus slack). A retry
  // delay that does not fit in one lease keeps the plain queued retry.
  const parkedLeaseMs = retryDelayMs + PARKED_RETRY_LEASE_SLACK_MS;
  const canParkRetries = parkedLeaseMs <= leaseDurationMs;
  let stopped = false;
  let claimsYieldUntil = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopPromise: Promise<DurableInboxPrimaryStopResult> | undefined;
  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* observers cannot alter claim state */ }
  };

  const processClaim = async (initialClaim: InboxClaim): Promise<void> => {
    const controller = new AbortController();
    controllers.add(controller);
    let claim = initialClaim;
    let ownershipLost = false;
    let renewing: Promise<void> | undefined;
    const loseOwnership = (error: unknown): void => {
      if (ownershipLost) return;
      ownershipLost = true;
      controller.abort(error);
      reportError(error);
    };
    const renew = (): void => {
      // Graceful stop halts NEW claims but must keep an admitted dispatch
      // fenced until it settles. Only termination/ownership loss aborts renew.
      if (ownershipLost || controller.signal.aborted || renewing) return;
      renewing = options.store.renewInboxClaim({ claim, leaseDurationMs })
        .then(result => {
          if (result.kind === 'stale') {
            loseOwnership(new Error(`durable inbox primary renewal lost claim ${claim.event.eventId}`));
            return;
          }
          if (result.claim) claim = result.claim;
        })
        .catch(error => {
          loseOwnership(new Error(
            `durable inbox primary renewal failed for ${claim.event.eventId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          ));
        })
        .finally(() => { renewing = undefined; });
    };
    const renewalTimer = setInterval(renew, renewalIntervalMs);
    renewalTimer.unref?.();

    let message: DurableLarkMessageClaim | undefined;
    try {
      message = parseDurableLarkMessageClaim(claim);
      const result = await options.dispatch(message, { claim, signal: controller.signal });
      clearInterval(renewalTimer);
      if (renewing) await renewing;
      if (ownershipLost || controller.signal.aborted) return;
      if (result.kind !== 'committed' && result.kind !== 'ignored' && result.kind !== 'retry') {
        throw new Error('durable inbox primary dispatch returned an invalid receipt');
      }
      if (result.kind === 'retry') {
        const reason = result.reason.trim();
        if (!reason || reason.length > 512) {
          throw new Error('durable inbox primary retry result requires a bounded reason');
        }
        if (result.wakeKey !== undefined) {
          const wakeKey = result.wakeKey.trim();
          if (!wakeKey || wakeKey.length > 512) {
            throw new Error('durable inbox primary retry wakeKey must be bounded');
          }
          if (!stopped && canParkRetries) {
            parkRetry(claim, message, { ...result, wakeKey }, wakeKey);
            return;
          }
        }
        if (result.retryAfterMs !== undefined
            && (!Number.isFinite(result.retryAfterMs) || result.retryAfterMs <= 0)) {
          throw new Error('durable inbox primary retryAfterMs must be a positive finite number');
        }
        const retryAfterMs = result.retryAfterMs === undefined
          ? retryDelayMs
          : Math.min(retryDelayMs, Math.max(MIN_RETRY_HINT_MS, Math.trunc(result.retryAfterMs)));
        const retried = await options.store.retryInboxClaim({
          claim,
          visibleAt: now() + retryAfterMs,
        });
        if (retried.kind === 'stale') {
          loseOwnership(new Error(`durable inbox primary retry lost claim ${claim.event.eventId}`));
          return;
        }
        if (result.retryAfterMs !== undefined) {
          claimsYieldUntil = Math.max(
            claimsYieldUntil,
            now() + retryAfterMs + intervalMs + PEER_CLAIM_YIELD_SLACK_MS,
          );
        }
        try {
          await options.onRetried?.({ message, result });
        } catch (error) {
          reportError(new Error(
            `durable inbox primary retry observer failed for ${claim.event.eventId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          ));
        }
        return;
      }
      const validatedResult: DurableInboxPrimaryDispatchResult = result.kind === 'committed'
        ? { kind: 'committed', receipt: parseDurableLarkAdmissionReceipt(result.receipt, message) }
        : result;
      if (result.kind === 'ignored' && (!result.reason.trim() || result.reason.length > 512)) {
        throw new Error('durable inbox primary ignored result requires a bounded reason');
      }
      const completed = await options.store.completeInboxClaim(claim);
      if (completed.kind === 'stale') {
        loseOwnership(new Error(`durable inbox primary completion lost claim ${claim.event.eventId}`));
        return;
      }
      try {
        options.onCommitted?.({ message, result: validatedResult });
      } catch (error) {
        reportError(new Error(
          `durable inbox primary commit observer failed for ${claim.event.eventId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    } catch (error) {
      clearInterval(renewalTimer);
      if (renewing) await renewing;
      if (ownershipLost || controller.signal.aborted) return;
      reportError(error);
      if (claim.attempts >= maxAttempts) {
        const completed = await options.store.completeInboxClaim(claim);
        if (completed.kind === 'stale') {
          reportError(new Error(`durable inbox primary retry limit lost claim ${claim.event.eventId}`));
          return;
        }
        reportError(new Error(
          `durable inbox primary retry limit reached for ${claim.event.eventId} after ${claim.attempts} attempts`,
        ));
        if (message) {
          try {
            await options.onExhausted?.({ message, attempts: claim.attempts });
          } catch (observerError) {
            reportError(new Error(
              `durable inbox primary exhausted observer failed for ${claim.event.eventId}: `
              + `${observerError instanceof Error ? observerError.message : String(observerError)}`,
            ));
          }
          try {
            options.onCommitted?.({
              message,
              result: {
                kind: 'ignored',
                reason: 'durable primary retry limit reached',
              },
            });
          } catch (observerError) {
            reportError(new Error(
              `durable inbox primary commit observer failed for ${claim.event.eventId}: `
              + `${observerError instanceof Error ? observerError.message : String(observerError)}`,
            ));
          }
        }
        return;
      }
      const retried = await options.store.retryInboxClaim({
        claim,
        visibleAt: now() + retryDelayMs,
      });
      if (retried.kind === 'stale') {
        reportError(new Error(`durable inbox primary retry lost claim ${claim.event.eventId}`));
      }
    } finally {
      clearInterval(renewalTimer);
      controllers.delete(controller);
    }
  };

  /** Hand a parked claim back to the queue, visible at `visibleAt`. */
  const releaseParked = (entry: ParkedRetry, visibleAt: number): Promise<void> => {
    if (entry.released) return entry.released;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.released = (async () => {
      try {
        const leased = await entry.leased;
        if (leased === 'stale') return;
        const retried = await options.store.retryInboxClaim({ claim: entry.claim, visibleAt });
        if (retried.kind === 'stale') {
          reportError(new Error(`durable inbox primary retry lost claim ${entry.claim.event.eventId}`));
          return;
        }
        try {
          await options.onRetried?.({ message: entry.message, result: entry.result });
        } catch (error) {
          reportError(new Error(
            `durable inbox primary retry observer failed for ${entry.claim.event.eventId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          ));
        }
      } catch (error) {
        reportError(error);
      } finally {
        if (parked.get(entry.claim.event.eventId) === entry) parked.delete(entry.claim.event.eventId);
      }
    })();
    return entry.released;
  };

  const parkRetry = (
    claim: InboxClaim,
    message: DurableLarkMessageClaim,
    result: Extract<DurableInboxPrimaryDispatchResult, { kind: 'retry' }>,
    wakeKey: string,
  ): void => {
    const deadline = now() + retryDelayMs;
    const entry: ParkedRetry = {
      claim,
      message,
      result,
      wakeKey,
      deadline,
      leased: options.store.renewInboxClaim({ claim, leaseDurationMs: parkedLeaseMs }).then(
        renewed => {
          if (renewed.kind !== 'stale') return 'applied' as const;
          reportError(new Error(`durable inbox primary retry lost claim ${claim.event.eventId}`));
          return 'stale' as const;
        },
        error => {
          // The claim keeps its previous lease; the hand-back is still owned.
          reportError(error);
          return 'unknown' as const;
        },
      ),
    };
    parked.set(claim.event.eventId, entry);
    entry.timer = setTimeout(() => {
      void releaseParked(entry, now()).then(() => tick()).catch(reportError);
    }, retryDelayMs);
    entry.timer.unref?.();
  };

  const drainSlot = async (slot: Slot): Promise<void> => {
    const slotWorkerId = `${workerId}:${slot.index}`;
    for (let index = 0; index < batchSize && !stopped; index++) {
      if (now() < claimsYieldUntil) return;
      let claim: InboxClaim | undefined;
      try {
        claim = await options.store.claimNextInbox({
          workerId: slotWorkerId,
          lane: DURABLE_INBOX_LANE_LARK_MESSAGE,
          leaseDurationMs,
        });
      } catch (error) {
        reportError(error);
        return;
      }
      if (!claim) return;
      if (claim.workerId !== slotWorkerId) {
        reportError(new Error(
          `durable inbox provider returned a claim owned by ${claim.workerId}`,
        ));
        return;
      }
      await processClaim(claim);
    }
  };

  const startSlot = (slot: Slot): Promise<void> => {
    if (slot.running) return slot.running;
    slot.running = drainSlot(slot).finally(() => { slot.running = undefined; });
    return slot.running;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    await Promise.all(slots.map(startSlot));
  };

  const installInterval = (): void => {
    if (stopped || timer) return;
    timer = setInterval(() => {
      void tick().catch(reportError);
    }, intervalMs);
    timer.unref?.();
  };

  const ready = tick().catch(error => {
    reportError(error);
  }).finally(installInterval);

  const wake = (): void => {
    if (stopped) return;
    void tick().catch(reportError);
  };

  const wakeRetry = (wakeKey: string): void => {
    if (stopped) return;
    for (const entry of [...parked.values()]) {
      if (entry.wakeKey !== wakeKey || entry.released) continue;
      void releaseParked(entry, now()).then(() => tick()).catch(reportError);
    }
  };

  const terminate = (): void => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    // Parked claims keep their shortened lease and become claimable when it
    // expires, like a retry whose visibility time passed.
    for (const entry of parked.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    parked.clear();
    for (const controller of controllers) {
      controller.abort(new Error('durable inbox primary consumer terminated'));
    }
  };

  return {
    workerId,
    ready,
    wake,
    wakeRetry,
    terminate,
    stop: (timeoutMs = shutdownMs) => {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      const budget = boundedInteger(timeoutMs, 'timeoutMs', 0, 300_000);
      // Parked retries go back to the queue exactly as the ordinary retry
      // would have: visible at their original deadline.
      const handedBack = [...parked.values()].map(entry => releaseParked(entry, entry.deadline));
      stopPromise = (async () => {
        const running = [
          ...slots.flatMap(slot => slot.running ? [slot.running] : []),
          ...handedBack,
        ];
        if (running.length === 0) return { kind: 'stopped', inFlight: 0 };
        if (budget === 0) {
          for (const controller of controllers) {
            controller.abort(new Error('durable inbox primary shutdown timed out'));
          }
          return { kind: 'timed_out', inFlight: running.length };
        }
        const timeout = timeoutPromise(budget);
        const drained = await Promise.race([
          Promise.allSettled(running).then(() => true as const),
          timeout.promise,
        ]);
        timeout.cancel();
        if (drained) return { kind: 'stopped', inFlight: 0 };
        for (const controller of controllers) {
          controller.abort(new Error('durable inbox primary shutdown timed out'));
        }
        return { kind: 'timed_out', inFlight: running.length };
      })();
      return stopPromise;
    },
  };
}
