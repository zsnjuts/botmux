import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DurableInboxStore,
  DurableJson,
  InboxClaim,
  InboxClaimMutationResult,
} from '../src/services/durable-coordination.js';
import {
  startDurableInboxPrimaryConsumer,
  type DurableInboxPrimaryDispatchResult,
} from '../src/services/durable-inbox-primary-consumer.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import { durableLarkAdmissionReceipt } from '../src/services/durable-lark-admission.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sqliteStore(now: () => number): SqliteDurableCoordinationStore {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-primary-inbox-'));
  tempDirs.push(dir);
  return new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function claim(messageId: string, payload?: unknown): InboxClaim {
  return {
    event: {
      eventId: `im.message.receive_v1:cli_test:${messageId}`,
      partitionKey: 'lark-message-routing:cli_test:oc_test',
      payload: (payload ?? {
        version: 1,
        type: 'lark.im.message.receive_v1',
        larkAppId: 'cli_test',
        event: { message: { message_id: messageId } },
      }) as DurableJson,
      visibleAt: 1,
      createdAt: 1,
    },
    workerId: 'unassigned',
    claimEpoch: 1,
    claimUntil: 60_000,
    attempts: 1,
  };
}

function committed(message: DurableLarkMessageClaim): Extract<
  DurableInboxPrimaryDispatchResult,
  { kind: 'committed' }
> {
  const sessionKey = `${message.messageId}::${message.larkAppId}`;
  return {
    kind: 'committed',
    receipt: durableLarkAdmissionReceipt({
      message,
      lease: {
        sessionKey,
        ownerId: 'session-owner-boot',
        epoch: 3,
        leaseUntil: 60_000,
      },
      record: {
        sessionKey,
        revision: 5,
        value: { status: 'active' },
        updatedAt: 10_000,
      },
    }),
  };
}

function inboxStore(input: {
  claims: InboxClaim[];
  completed?: InboxClaim[];
  retried?: Array<{ claim: InboxClaim; visibleAt: number }>;
}): DurableInboxStore {
  return {
    enqueueInbox: vi.fn(),
    claimNextInbox: vi.fn(async ({ workerId }) => {
      const next = input.claims.shift();
      return next ? { ...next, workerId } : undefined;
    }),
    renewInboxClaim: vi.fn(async ({ claim: current, leaseDurationMs }) => ({
      kind: 'applied',
      claim: { ...current, claimUntil: current.claimUntil + leaseDurationMs },
    })),
    completeInboxClaim: vi.fn(async current => {
      input.completed?.push(current);
      return { kind: 'applied' } as InboxClaimMutationResult;
    }),
    retryInboxClaim: vi.fn(async retry => {
      input.retried?.push(retry);
      return { kind: 'applied' } as InboxClaimMutationResult;
    }),
  };
}

describe('durable inbox primary consumer', () => {
  it('completes only after committed or explicitly ignored dispatch receipts', async () => {
    const completed: InboxClaim[] = [];
    const store = inboxStore({
      claims: [claim('om_commit'), claim('om_ignore')],
      completed,
    });
    const dispatch = vi.fn(async message => message.messageId === 'om_commit'
      ? committed(message)
      : { kind: 'ignored' as const, reason: 'not addressed to this bot' });
    const commits: string[] = [];
    const receipts: number[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch,
      onCommitted: ({ message, result }) => {
        commits.push(message.messageId);
        if (result.kind === 'committed') receipts.push(result.receipt.sessionRevision);
      },
    });
    await consumer.ready;

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      messageId: 'om_commit',
      data: { message: { message_id: 'om_commit' } },
    });
    expect(completed.map(item => item.event.eventId)).toEqual([
      'im.message.receive_v1:cli_test:om_commit',
      'im.message.receive_v1:cli_test:om_ignore',
    ]);
    expect(commits).toEqual(['om_commit', 'om_ignore']);
    expect(receipts).toEqual([5]);
    expect(store.completeInboxClaim).toHaveBeenCalledTimes(2);
    expect(store.retryInboxClaim).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('retries an invalid envelope without exposing it to dispatch', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({
      claims: [claim('om_invalid', { version: 2 })],
      retried,
    });
    const dispatch = vi.fn();
    const errors: unknown[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      retryDelayMs: 2_000,
      now: () => 10_000,
      dispatch,
      onError: error => errors.push(error),
    });
    await consumer.ready;

    expect(dispatch).not.toHaveBeenCalled();
    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    expect(retried[0].visibleAt).toBe(12_000);
    expect(errors).toHaveLength(1);
    await consumer.stop();
  });

  it('retries a dispatch failure while the claim is still owned', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({ claims: [claim('om_retry')], retried });
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      retryDelayMs: 500,
      now: () => 5_000,
      dispatch: async () => { throw new Error('durable admission unavailable'); },
      onError: () => { throw new Error('observer failure'); },
    });
    await consumer.ready;

    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    expect(retried[0].visibleAt).toBe(5_500);
    await consumer.stop();
  });

  it('honours an earlier retry hint, bounded by the floor and the ordinary delay', async () => {
    for (const [hint, expected] of [[300, 9_300], [20, 9_100], [60_000, 14_000]] as const) {
      const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
      const store = inboxStore({ claims: [claim(`om_hint_${hint}`)], retried });
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 60_000,
        retryDelayMs: 5_000,
        now: () => 9_000,
        dispatch: async () => ({
          kind: 'retry',
          reason: 'active Session lease is still owned by replica-a',
          retryAfterMs: hint,
        }),
      });
      await consumer.ready;
      expect(retried).toHaveLength(1);
      expect(retried[0].visibleAt).toBe(expected);
      await consumer.stop();
    }
  });

  it('stops claiming after a peer-owned retry until the peer has polled once', async () => {
    // Mew #93：两个副本都按固定周期轮询，非 owner 放回后若立刻接着领，
    // 常常又是它先看到同一条，续轮在两个副本之间空转。
    let now = 9_000;
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({ claims: [claim('om_peer_owned'), claim('om_other')], retried });
    const dispatched: string[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 500,
      retryDelayMs: 5_000,
      now: () => now,
      dispatch: async message => {
        dispatched.push(message.messageId);
        return message.messageId === 'om_peer_owned'
          ? { kind: 'retry', reason: 'active Session lease is still owned by replica-a', retryAfterMs: 300 }
          : committed(message);
      },
    });
    await consumer.ready;
    expect(retried).toHaveLength(1);
    expect(retried[0].visibleAt).toBe(9_300);
    expect(dispatched).toEqual(['om_peer_owned']);

    // Visible again at 9 300; the owner polls within one interval after that.
    now = 9_999;
    consumer.wake();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(dispatched).toEqual(['om_peer_owned']);

    now = 10_000;
    consumer.wake();
    await vi.waitFor(() => expect(dispatched).toEqual(['om_peer_owned', 'om_other']));
    await consumer.stop();
  });

  it('keeps claiming after an ordinary retry without a peer hint', async () => {
    const store = inboxStore({ claims: [claim('om_busy_turn'), claim('om_next')], retried: [] });
    const dispatched: string[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      retryDelayMs: 5_000,
      now: () => 9_000,
      dispatch: async message => {
        dispatched.push(message.messageId);
        return message.messageId === 'om_busy_turn'
          ? { kind: 'retry', reason: 'session has an unfinished turn' }
          : committed(message);
      },
    });
    await consumer.ready;
    expect(dispatched).toEqual(['om_busy_turn', 'om_next']);
    await consumer.stop();
  });

  it('requeues an explicit busy result without reporting a dispatch error', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    // Explicit retry is a wait-state, not a failing attempt. Even an already
    // high attempt count must not hit the generic poison-row completion path.
    const busy = { ...claim('om_busy'), attempts: 999 };
    const store = inboxStore({ claims: [busy], retried });
    const errors: unknown[] = [];
    const commits: DurableInboxPrimaryDispatchResult[] = [];
    const retries: string[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      retryDelayMs: 750,
      maxAttempts: 1,
      now: () => 9_000,
      dispatch: async () => ({ kind: 'retry', reason: 'session has an unfinished turn' }),
      onCommitted: ({ result }) => commits.push(result),
      onRetried: ({ result }) => retries.push(result.reason),
      onError: error => errors.push(error),
    });
    await consumer.ready;

    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    expect(retried[0].visibleAt).toBe(9_750);
    expect(commits).toHaveLength(0);
    expect(retries).toEqual(['session has an unfinished turn']);
    expect(errors).toHaveLength(0);
    await consumer.stop();
  });

  it('keeps the Inbox queued when the post-retry observer fails', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({ claims: [claim('om_retry_notice')], retried });
    const errors: string[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch: async () => ({ kind: 'retry', reason: 'message_quota_infrastructure_unavailable' }),
      onRetried: async () => { throw new Error('notice unavailable'); },
      onError: error => errors.push((error as Error).message),
    });
    await consumer.ready;

    expect(retried).toHaveLength(1);
    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(errors).toEqual([
      expect.stringContaining('retry observer failed'),
    ]);
    await consumer.stop();
  });

  it('lets another consumer slot commit while one partition head is explicitly busy', async () => {
    const completed: InboxClaim[] = [];
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const busy = claim('om_busy_partition');
    busy.event.partitionKey = 'lark-message-routing:cli_test:oc_busy';
    const independent = claim('om_independent_partition');
    independent.event.partitionKey = 'lark-message-routing:cli_test:oc_independent';
    const store = inboxStore({ claims: [busy, independent], completed, retried });
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 2,
      intervalMs: 60_000,
      now: () => 2_000,
      dispatch: async message => message.messageId === 'om_busy_partition'
        ? { kind: 'retry', reason: 'session has an unfinished turn' }
        : committed(message),
    });
    await consumer.ready;

    expect(retried.map(item => item.claim.event.partitionKey)).toEqual([
      'lark-message-routing:cli_test:oc_busy',
    ]);
    expect(completed.map(item => item.event.partitionKey)).toEqual([
      'lark-message-routing:cli_test:oc_independent',
    ]);
    await consumer.stop();
  });

  it('requeues a transient failure in SQLite with an incremented attempt', async () => {
    let now = 100;
    const store = sqliteStore(() => now);
    const event = claim('om_sqlite_retry').event;
    await store.enqueueInbox(event);
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      retryDelayMs: 500,
      now: () => now,
      dispatch: async () => { throw new Error('capture store unavailable'); },
    });
    await consumer.ready;

    expect(await store.claimNextInbox({
      workerId: 'too-early',
      leaseDurationMs: 1_000,
    })).toBeUndefined();
    now = 600;
    await expect(store.claimNextInbox({
      workerId: 'after-delay',
      leaseDurationMs: 1_000,
    })).resolves.toMatchObject({
      event: { eventId: event.eventId },
      attempts: 2,
    });
    await consumer.stop();
    await store.close();
  });

  it('settles an exhausted failure and continues with the next row', async () => {
    const completed: InboxClaim[] = [];
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const exhausted = { ...claim('om_exhausted'), attempts: 3 };
    const store = inboxStore({
      claims: [exhausted, claim('om_after_exhausted')],
      completed,
      retried,
    });
    const commits: DurableInboxPrimaryDispatchResult[] = [];
    const dropped: Array<[string, number]> = [];
    const errors: unknown[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      maxAttempts: 3,
      dispatch: async message => {
        if (message.messageId === 'om_exhausted') throw new Error('provider unavailable');
        return committed(message);
      },
      onCommitted: ({ result }) => commits.push(result),
      onExhausted: ({ message, attempts }) => { dropped.push([message.messageId, attempts]); },
      onError: error => errors.push(error),
    });
    await consumer.ready;

    expect(dropped).toEqual([['om_exhausted', 3]]);
    expect(completed.map(item => item.event.eventId)).toEqual([
      'im.message.receive_v1:cli_test:om_exhausted',
      'im.message.receive_v1:cli_test:om_after_exhausted',
    ]);
    expect(retried).toHaveLength(0);
    expect(commits[0]).toEqual({
      kind: 'ignored',
      reason: 'durable primary retry limit reached',
    });
    expect(commits[1]?.kind).toBe('committed');
    expect(errors.some(error => String(error).includes('retry limit reached'))).toBe(true);
    await consumer.stop();
  });

  it('keeps polling after a transient claim failure', async () => {
    vi.useFakeTimers();
    try {
      const completed: InboxClaim[] = [];
      const store = inboxStore({ claims: [claim('om_recovered')], completed });
      const fallback = vi.mocked(store.claimNextInbox).getMockImplementation()!;
      vi.mocked(store.claimNextInbox)
        .mockRejectedValueOnce(new Error('provider unavailable'))
        .mockImplementation(fallback);
      const errors: unknown[] = [];
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 10,
        dispatch: async message => committed(message),
        onError: error => errors.push(error),
      });
      await consumer.ready;
      expect(errors).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(completed).toHaveLength(1);
      await consumer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an unproven dispatch receipt instead of completing the row', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({ claims: [claim('om_unproven')], retried });
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      now: () => 8_000,
      dispatch: async () => ({ kind: 'queued' } as never),
    });
    await consumer.ready;

    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    await consumer.stop();
  });

  it('refuses a bare committed marker without a fenced Session receipt', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({ claims: [claim('om_bare_commit')], retried });
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch: async () => ({ kind: 'committed' } as never),
    });
    await consumer.ready;

    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    await consumer.stop();
  });

  it('refuses a committed receipt copied from another inbox event', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({ claims: [claim('om_expected')], retried });
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch: async message => {
        const result = committed(message);
        return {
          ...result,
          receipt: {
            ...result.receipt,
            eventId: 'im.message.receive_v1:cli_test:om_other',
          },
        };
      },
    });
    await consumer.ready;

    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    await consumer.stop();
  });

  it('does not retry a completed row when the observer callback fails', async () => {
    const store = inboxStore({ claims: [claim('om_observer')] });
    const errors: unknown[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch: async message => committed(message),
      onCommitted: () => { throw new Error('observer unavailable'); },
      onError: error => errors.push(error),
    });
    await consumer.ready;

    expect(store.completeInboxClaim).toHaveBeenCalledOnce();
    expect(store.retryInboxClaim).not.toHaveBeenCalled();
    expect(errors.some(error => String(error).includes('commit observer failed'))).toBe(true);
    await consumer.stop();
  });

  it('renews a long dispatch and completes with the latest claim proof', async () => {
    vi.useFakeTimers();
    try {
      const completed: InboxClaim[] = [];
      const store = inboxStore({ claims: [claim('om_long')], completed });
      const started = deferred<void>();
      const admission = deferred<void>();
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 60_000,
        leaseDurationMs: 3_000,
        renewalIntervalMs: 1_000,
        dispatch: message => {
          started.resolve();
          return admission.promise.then(() => committed(message));
        },
      });

      await started.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.renewInboxClaim).toHaveBeenCalledOnce();
      admission.resolve();
      await consumer.ready;

      expect(completed).toHaveLength(1);
      expect(completed[0].claimUntil).toBe(63_000);
      await consumer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts dispatch and leaves the row recoverable after stale renewal', async () => {
    vi.useFakeTimers();
    try {
      const store = inboxStore({ claims: [claim('om_stale')] });
      vi.mocked(store.renewInboxClaim).mockResolvedValue({ kind: 'stale' });
      const started = deferred<void>();
      const aborted = deferred<void>();
      const dispatch = vi.fn(async (message, { signal }) => {
        started.resolve();
        await new Promise<void>(resolve => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        aborted.resolve();
        return committed(message);
      });
      const errors: unknown[] = [];
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 60_000,
        leaseDurationMs: 3_000,
        renewalIntervalMs: 1_000,
        dispatch,
        onError: error => errors.push(error),
      });

      await started.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await aborted.promise;
      await consumer.ready;

      expect(errors.some(error => String(error).includes('renewal lost claim'))).toBe(true);
      expect(store.completeInboxClaim).not.toHaveBeenCalled();
      expect(store.retryInboxClaim).not.toHaveBeenCalled();
      await consumer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims a freshly enqueued row on wake instead of the next poll tick', async () => {
    let now = 1_000;
    const store = sqliteStore(() => now);
    const dispatched: string[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      now: () => now,
      dispatch: async message => {
        dispatched.push(message.messageId);
        return committed(message);
      },
    });
    await consumer.ready;

    await store.enqueueInbox(claim('om_woken').event);
    consumer.wake();
    await vi.waitFor(() => expect(dispatched).toEqual(['om_woken']));
    await vi.waitFor(async () => expect(await store.claimNextInbox({
      workerId: 'probe',
      leaseDurationMs: 1_000,
    })).toBeUndefined());
    await consumer.stop();
    await store.close();
  });

  it('finishes the in-flight claim but leaves new rows to peers while shutdown pauses claiming', async () => {
    // Mew #93：滚动发布时旧 Pod 要先交接、等 worker 退出，最后才停消费者；
    // 这段时间它若继续领取，消息会在旧 Pod 和接替的 Pod 之间来回放回。
    const completed: InboxClaim[] = [];
    const store = inboxStore({ claims: [claim('om_in_flight'), claim('om_after_pause')], completed });
    const inFlight = deferred<void>();
    const dispatched: string[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      now: () => 9_000,
      dispatch: async message => {
        dispatched.push(message.messageId);
        if (message.messageId === 'om_in_flight') await inFlight.promise;
        return committed(message);
      },
    });
    await vi.waitFor(() => expect(dispatched).toEqual(['om_in_flight']));

    consumer.pauseClaims();
    inFlight.resolve();
    await consumer.ready;
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    consumer.wake();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(dispatched).toEqual(['om_in_flight']);

    // The shutdown was refused: this process stays online and claims again.
    consumer.resumeClaims();
    await vi.waitFor(() => expect(dispatched).toEqual(['om_in_flight', 'om_after_pause']));
    await consumer.stop();
  });

  describe('retry waiting on a wake key', () => {
    const waiting = (wakeKey = 'session:busy'): DurableInboxPrimaryDispatchResult => ({
      kind: 'retry',
      reason: 'session has an unfinished turn',
      wakeKey,
    });

    it('is redelivered as soon as its key is woken, not after the retry delay', async () => {
      let now = 1_000;
      const store = sqliteStore(() => now);
      await store.enqueueInbox(claim('om_follow_up').event);
      let busy = true;
      const dispatched: string[] = [];
      const retried: string[] = [];
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 60_000,
        retryDelayMs: 30_000,
        now: () => now,
        dispatch: async message => {
          dispatched.push(message.messageId);
          return busy ? waiting() : committed(message);
        },
        onRetried: ({ result }) => { retried.push(result.reason); },
      });
      await consumer.ready;
      expect(dispatched).toEqual(['om_follow_up']);
      // Waiting rows stay unavailable to every other claimer, exactly like a
      // retry whose visibility time has not come yet.
      expect(await store.claimNextInbox({ workerId: 'other-replica', leaseDurationMs: 1_000 }))
        .toBeUndefined();

      busy = false;
      consumer.wakeRetry('session:someone-else');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(dispatched).toHaveLength(1);

      consumer.wakeRetry('session:busy');
      await vi.waitFor(() => expect(dispatched).toEqual(['om_follow_up', 'om_follow_up']));
      expect(retried).toEqual(['session has an unfinished turn']);
      await vi.waitFor(async () => expect(await store.claimNextInbox({
        workerId: 'probe',
        leaseDurationMs: 1_000,
      })).toBeUndefined());
      await consumer.stop();
      await store.close();
    });

    it('keeps partition FIFO: a later message waits behind the waiting one', async () => {
      let now = 1_000;
      const store = sqliteStore(() => now);
      await store.enqueueInbox(claim('om_first').event);
      await store.enqueueInbox(claim('om_second').event);
      let busy = true;
      const dispatched: string[] = [];
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 2,
        intervalMs: 60_000,
        retryDelayMs: 30_000,
        now: () => now,
        dispatch: async message => {
          dispatched.push(message.messageId);
          return busy && message.messageId === 'om_first' ? waiting() : committed(message);
        },
      });
      await consumer.ready;
      consumer.wake();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(dispatched).toEqual(['om_first']);

      busy = false;
      consumer.wakeRetry('session:busy');
      await vi.waitFor(() => expect(dispatched).toEqual(['om_first', 'om_first', 'om_second']));
      await consumer.stop();
      await store.close();
    });

    it('is still handed back at its retry delay when no wake comes', async () => {
      let now = 1_000;
      const store = sqliteStore(() => now);
      await store.enqueueInbox(claim('om_never_woken').event);
      const dispatched: string[] = [];
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 60_000,
        retryDelayMs: 100,
        now: () => now,
        dispatch: async message => {
          dispatched.push(message.messageId);
          return dispatched.length === 1 ? waiting() : committed(message);
        },
      });
      await consumer.ready;
      expect(dispatched).toHaveLength(1);
      await vi.waitFor(() => expect(dispatched).toHaveLength(2));
      await consumer.stop();
      await store.close();
    });

    it('frees the row about when the plain retry would have if the process dies while waiting', async () => {
      let now = 1_000;
      const store = sqliteStore(() => now);
      await store.enqueueInbox(claim('om_crash').event);
      const renew = vi.spyOn(store, 'renewInboxClaim');
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 60_000,
        leaseDurationMs: 60_000,
        retryDelayMs: 1_000,
        now: () => now,
        dispatch: async () => waiting(),
      });
      await consumer.ready;
      await vi.waitFor(() => expect(renew).toHaveBeenCalled());
      await renew.mock.results[0].value;
      consumer.terminate();

      // Not before the retry delay: the row still waits as a retry would.
      now = 1_000 + 999;
      expect(await store.claimNextInbox({ workerId: 'survivor', leaseDurationMs: 1_000 }))
        .toBeUndefined();
      // Well before the full claim lease would have expired.
      now = 1_000 + 59_999;
      await expect(store.claimNextInbox({ workerId: 'survivor', leaseDurationMs: 1_000 }))
        .resolves.toMatchObject({ event: { eventId: claim('om_crash').event.eventId } });
      await store.close();
    });

    it('is handed back on stop exactly like the plain retry', async () => {
      const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
      const store = inboxStore({ claims: [claim('om_stop_waiting')], retried });
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 60_000,
        retryDelayMs: 750,
        now: () => 9_000,
        dispatch: async () => waiting(),
      });
      await consumer.ready;
      expect(retried).toHaveLength(0);

      await expect(consumer.stop()).resolves.toMatchObject({ kind: 'stopped' });
      expect(retried).toHaveLength(1);
      expect(retried[0].visibleAt).toBe(9_750);
    });
  });

  it('bounds shutdown and aborts an in-flight dispatch without completing', async () => {
    const store = inboxStore({ claims: [claim('om_shutdown')] });
    const started = deferred<void>();
    const sawAbort = deferred<void>();
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch: async (message, { signal }) => {
        started.resolve();
        await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        sawAbort.resolve();
        return committed(message);
      },
    });

    await started.promise;
    await expect(consumer.stop(0)).resolves.toEqual({ kind: 'timed_out', inFlight: 1 });
    await sawAbort.promise;
    await consumer.ready;
    expect(store.completeInboxClaim).not.toHaveBeenCalled();
  });
});
