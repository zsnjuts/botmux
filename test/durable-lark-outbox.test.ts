import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableOutboxRecord, OutboxAttempt } from '../src/services/durable-coordination.js';
import {
  deliverDurableLarkOutbox,
  durableLarkOutboxMessage,
  LARK_OUTBOX_IDEMPOTENCY_TTL_MS,
  parseDurableLarkOutboxRecord,
  reconcileAmbiguousLarkOutbox,
} from '../src/services/durable-lark-outbox.js';
import { startDurableOutboxPump } from '../src/services/durable-outbox-pump.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { MessageUpdateExpiredError, MessageWithdrawnError } from '../src/im/lark/client.js';
import { TopicSendError } from '../src/cli/topic-send-guard.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function row(overrides: Partial<Parameters<typeof durableLarkOutboxMessage>[0]> = {}): DurableOutboxRecord {
  const message = durableLarkOutboxMessage({
    messageId: 'outbox-1',
    sessionKey: 'om_root::cli_test',
    larkAppId: 'cli_test',
    target: { kind: 'send', chatId: 'oc_chat' },
    content: 'hello',
    msgType: 'text',
    providerUuid: 'bts_0123456789abcdef0123456789abcdef',
    hookContext: { sessionId: 'session-1' },
    createdAt: 1_000,
    visibleAt: 1_000,
    ...overrides,
  });
  return {
    ...message,
    state: 'attempting',
    originEpoch: 1,
    attempts: 1,
    updatedAt: 1_000,
  };
}

function context(record: DurableOutboxRecord, attempt = 1, signal = new AbortController().signal) {
  const outboxAttempt: OutboxAttempt = {
    record: { ...record, state: 'attempting', attempts: attempt },
    workerId: 'outbox-worker',
    claimEpoch: 1,
    claimUntil: 60_000,
    attempt,
  };
  return { attempt: outboxAttempt, signal };
}

function deps() {
  return {
    sendMessage: vi.fn(async () => 'om_sent'),
    replyMessage: vi.fn(async () => 'om_replied'),
    updateMessage: vi.fn(async () => true),
  };
}

describe('durable Lark outbox adapter', () => {
  it('re-attempts an ambiguous send only while Lark still dedupes its provider UUID', () => {
    // Mew #35: a stuck ambiguous row must either be safely re-sent or released.
    const sent = row({ createdAt: 1_000 });
    expect(reconcileAmbiguousLarkOutbox(sent, 1_000 + LARK_OUTBOX_IDEMPOTENCY_TTL_MS / 2)).toEqual({ kind: 'retry' });
    expect(reconcileAmbiguousLarkOutbox(sent, 1_000 + LARK_OUTBOX_IDEMPOTENCY_TTL_MS)).toMatchObject({
      kind: 'abandon',
      reason: expect.stringContaining('dedupe window'),
    });
    const reply = row({ target: { kind: 'reply', messageId: 'om_parent', replyInThread: true } });
    expect(reconcileAmbiguousLarkOutbox(reply, 1_000 + LARK_OUTBOX_IDEMPOTENCY_TTL_MS)).toMatchObject({ kind: 'abandon' });
  });

  it('always re-applies an idempotent card patch and abandons an unparseable row', () => {
    const update = row({ target: { kind: 'update', messageId: 'om_card' } });
    expect(reconcileAmbiguousLarkOutbox(update, 1_000 + 10 * LARK_OUTBOX_IDEMPOTENCY_TTL_MS)).toEqual({ kind: 'retry' });
    // A terminal update may fall back to a fresh reply, which is UUID-deduped too.
    const withFallback = row({
      target: { kind: 'update', messageId: 'om_card' },
      terminalUpdateFallback: {
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        providerUuid: 'fallback_0123456789abcdef0123456789abcdef',
      },
    });
    expect(reconcileAmbiguousLarkOutbox(withFallback, 1_000 + LARK_OUTBOX_IDEMPOTENCY_TTL_MS)).toMatchObject({ kind: 'abandon' });
    expect(reconcileAmbiguousLarkOutbox({ ...row(), payload: { broken: true } }, 2_000)).toMatchObject({
      kind: 'abandon',
      reason: expect.stringContaining('invalid durable Lark payload'),
    });
  });

  it('builds and revalidates a frozen provider identity', () => {
    const record = row({
      target: { kind: 'reply', messageId: 'om_parent', replyInThread: true },
    });
    expect(parseDurableLarkOutboxRecord(record)).toEqual({
      version: 1,
      type: 'botmux.lark.outbound',
      messageId: 'outbox-1',
      larkAppId: 'cli_test',
      target: { kind: 'reply', messageId: 'om_parent', replyInThread: true },
      content: 'hello',
      msgType: 'text',
      providerUuid: 'bts_0123456789abcdef0123456789abcdef',
      hookContext: { sessionId: 'session-1' },
    });

    expect(() => row({ providerUuid: 'x'.repeat(51) })).toThrow(/1\.\.50/);
    expect(() => parseDurableLarkOutboxRecord({ ...record, messageId: 'outbox-other' }))
      .toThrow(/identity/);
  });

  it('sends with the stable UUID and a revalidated first-attempt hook fence', async () => {
    const record = row();
    const transport = deps();
    const beforeEffect = vi.fn();
    const beforeHook = vi.fn();
    const hookOrigin = {
      ipcPort: 9999,
      sessionId: 'session-1',
      capability: 'frozen-capability',
      turnId: 'turn-1',
      dispatchAttempt: 1,
    };
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      {
        now: () => 2_000,
        beforeEffect,
        hookAuthority: async () => ({ beforeHook, hookOrigin }),
      },
    );

    expect(result).toEqual({
      kind: 'delivered',
      receipt: {
        provider: 'lark',
        providerMessageId: 'om_sent',
        providerUuid: 'bts_0123456789abcdef0123456789abcdef',
        operation: 'send',
        targetId: 'oc_chat',
      },
    });
    expect(beforeEffect).toHaveBeenCalledOnce();
    expect(transport.sendMessage).toHaveBeenCalledWith(
      'cli_test',
      'oc_chat',
      'hello',
      'text',
      'bts_0123456789abcdef0123456789abcdef',
      { sessionId: 'session-1' },
      { beforeHook, hookOrigin },
    );
    expect(transport.replyMessage).not.toHaveBeenCalled();
  });

  it('replies to the frozen parent and suppresses hooks during UUID reconciliation', async () => {
    const record = row({
      target: { kind: 'reply', messageId: 'om_parent', replyInThread: true },
    });
    const transport = deps();
    const hookAuthority = vi.fn();
    const result = await deliverDurableLarkOutbox(
      record,
      context(record, 2),
      transport,
      { now: () => 2_000, hookAuthority },
    );

    expect(result.kind).toBe('delivered');
    expect(hookAuthority).not.toHaveBeenCalled();
    expect(transport.replyMessage).toHaveBeenCalledWith(
      'cli_test',
      'om_parent',
      'hello',
      'text',
      true,
      'bts_0123456789abcdef0123456789abcdef',
      { sessionId: 'session-1' },
      { suppressHook: true },
    );
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('updates one stable card target idempotently through the durable outbox', async () => {
    const record = row({
      target: { kind: 'update', messageId: 'om_card' },
      msgType: 'interactive',
      terminalUpdateFallback: {
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        providerUuid: 'fallback_0123456789abcdef0123456789abcdef',
      },
    });
    const transport = deps();
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      { now: () => 2_000 },
    );

    expect(result).toEqual({
      kind: 'delivered',
      receipt: {
        provider: 'lark',
        providerMessageId: 'om_card',
        providerUuid: 'bts_0123456789abcdef0123456789abcdef',
        operation: 'update',
        targetId: 'om_card',
      },
    });
    expect(transport.updateMessage).toHaveBeenCalledWith('cli_test', 'om_card', 'hello');
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(transport.replyMessage).not.toHaveBeenCalled();
  });

  it('replies once with the same terminal card when its update target was withdrawn', async () => {
    const record = row({
      target: { kind: 'update', messageId: 'om_card' },
      msgType: 'interactive',
      terminalUpdateFallback: {
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        providerUuid: 'fallback_0123456789abcdef0123456789abcdef',
      },
    });
    const transport = deps();
    transport.updateMessage.mockRejectedValueOnce(new MessageWithdrawnError('om_card'));

    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      { now: () => 2_000 },
    );

    expect(result).toEqual({
      kind: 'delivered',
      receipt: {
        provider: 'lark',
        providerMessageId: 'om_replied',
        providerUuid: 'fallback_0123456789abcdef0123456789abcdef',
        operation: 'reply',
        targetId: 'om_root',
        disposition: 'fallback',
        reason: 'message_withdrawn',
        replacedTargetId: 'om_card',
      },
    });
    expect(transport.replyMessage).toHaveBeenCalledWith(
      'cli_test',
      'om_root',
      'hello',
      'interactive',
      true,
      'fallback_0123456789abcdef0123456789abcdef',
      { sessionId: 'session-1' },
      { suppressHook: true },
    );
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('safely retries a terminal-card fallback with its stable UUID', async () => {
    const record = row({
      target: { kind: 'update', messageId: 'om_card' },
      msgType: 'interactive',
      terminalUpdateFallback: {
        target: { kind: 'send', chatId: 'oc_chat' },
        providerUuid: 'fallback_0123456789abcdef0123456789abcdef',
      },
    });
    const transport = deps();
    transport.updateMessage.mockRejectedValueOnce(new MessageUpdateExpiredError('om_card'));
    transport.sendMessage.mockRejectedValueOnce(Object.assign(new Error('gateway unavailable'), { status: 503 }));

    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      { now: () => 2_000, retryDelaysMs: [5_000] },
    );

    expect(result).toEqual({
      kind: 'retry',
      visibleAt: 7_000,
      error: 'terminal update message_update_expired; fallback failed: gateway unavailable',
      proof: 'stable_target_idempotency',
    });
  });

  it('rejects a terminal update fallback on a non-update row', () => {
    expect(() => row({
      terminalUpdateFallback: {
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        providerUuid: 'fallback_0123456789abcdef0123456789abcdef',
      },
    })).toThrow(/requires an update target/);
  });

  it('uses the provider UUID window for bounded safe retry', async () => {
    const record = row();
    const transport = deps();
    const error = Object.assign(new Error('gateway unavailable'), { status: 503 });
    transport.sendMessage.mockRejectedValue(error);
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      { now: () => 2_000, retryDelaysMs: [5_000] },
    );

    expect(result).toEqual({
      kind: 'retry',
      visibleAt: 7_000,
      error: 'gateway unavailable',
      proof: 'stable_target_idempotency',
    });
  });

  it('stops retrying before the provider UUID window expires', async () => {
    const record = row();
    const transport = deps();
    transport.sendMessage.mockRejectedValue(Object.assign(new Error('timeout'), { status: 503 }));
    const result = await deliverDurableLarkOutbox(
      record,
      context(record, 3),
      transport,
      {
        now: () => record.createdAt + LARK_OUTBOX_IDEMPOTENCY_TTL_MS - 30_000,
        retryDelaysMs: [1_000],
      },
    );

    expect(result).toMatchObject({ kind: 'ambiguous' });
    if (result.kind === 'ambiguous') expect(result.error).toContain('dedupe window is exhausted');
  });

  it('never retargets a withdrawn reply under the same UUID', async () => {
    const record = row({
      target: { kind: 'reply', messageId: 'om_parent', replyInThread: true },
    });
    const transport = deps();
    transport.replyMessage.mockRejectedValue(new MessageWithdrawnError('om_parent'));
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      { now: () => 2_000 },
    );

    expect(result).toMatchObject({ kind: 'ambiguous' });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['withdrawn', new MessageWithdrawnError('om_card'), 'message_withdrawn'],
    ['expired', new MessageUpdateExpiredError('om_card'), 'message_update_expired'],
    ['unavailable topic', new TopicSendError('TOPIC_SEND_BLOCKED', 'withdrawn'), 'topic_unavailable'],
  ] as const)('terminally discards a %s card update and unblocks the next SQLite outbox row', async (
    _case,
    terminalError,
    reason,
  ) => {
    let now = 10;
    const dir = mkdtempSync(join(tmpdir(), 'botmux-lark-outbox-terminal-update-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const acquired = await store.acquireSessionLease({
      sessionKey: 'om_root::cli_test',
      ownerId: 'session-owner',
      leaseDurationMs: 1_000,
    });
    if (acquired.kind !== 'acquired') throw new Error('expected Session lease');
    await store.enqueueOutbox({
      lease: acquired.lease,
      message: durableLarkOutboxMessage({
        messageId: `control-update-${reason}`,
        sessionKey: 'om_root::cli_test',
        larkAppId: 'cli_test',
        target: { kind: 'update', messageId: 'om_card' },
        content: '{"card":"settled"}',
        msgType: 'interactive',
        providerUuid: `update_${reason}`,
        createdAt: 1,
        visibleAt: 1,
      }),
    });
    await store.enqueueOutbox({
      lease: acquired.lease,
      message: durableLarkOutboxMessage({
        messageId: `notice-${reason}`,
        sessionKey: 'om_root::cli_test',
        larkAppId: 'cli_test',
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        content: 'follow-up',
        providerUuid: `notice_${reason}`,
        createdAt: 2,
        visibleAt: 2,
      }),
    });
    const transport = deps();
    transport.updateMessage.mockRejectedValueOnce(terminalError);
    const pump = startDurableOutboxPump({
      store,
      workerId: `outbox-${reason}`,
      concurrency: 1,
      batchSize: 2,
      intervalMs: 60_000,
      now: () => now,
      deliver: (record, deliveryContext) => deliverDurableLarkOutbox(
        record,
        deliveryContext,
        transport,
        { now: () => now },
      ),
    });
    await pump.ready;

    expect(await store.readOutbox(`control-update-${reason}`)).toMatchObject({
      state: 'delivered',
      receipt: { disposition: 'discarded', reason },
    });
    expect(await store.readOutbox(`notice-${reason}`)).toMatchObject({ state: 'delivered' });
    expect(transport.replyMessage).toHaveBeenCalledWith(
      'cli_test',
      'om_root',
      'follow-up',
      'text',
      true,
      `notice_${reason}`,
      undefined,
      { suppressHook: true },
    );
    await pump.stop();
    await store.close();
    now++;
  });

  it('safely retries an update whose topic availability check failed before PATCH', async () => {
    const record = row({ target: { kind: 'update', messageId: 'om_card' }, msgType: 'interactive' });
    const transport = deps();
    transport.updateMessage.mockRejectedValueOnce(
      new TopicSendError('TOPIC_SEND_CHECK_FAILED', 'lookup unavailable'),
    );
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      { now: () => 2_000, retryDelaysMs: [500] },
    );

    expect(result).toMatchObject({
      kind: 'retry',
      visibleAt: 2_500,
      proof: 'no_side_effect',
    });
  });

  it('retries safely when authority fails before the provider call', async () => {
    const record = row();
    const transport = deps();
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      {
        now: () => 2_000,
        retryDelaysMs: [500],
        beforeEffect: async () => { throw new Error('stale Session epoch'); },
      },
    );

    expect(result).toMatchObject({
      kind: 'retry',
      visibleAt: 2_500,
      proof: 'no_side_effect',
    });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('retries an already-aborted attempt without invoking the provider', async () => {
    const record = row();
    const transport = deps();
    const controller = new AbortController();
    controller.abort();
    const result = await deliverDurableLarkOutbox(
      record,
      context(record, 1, controller.signal),
      transport,
      { now: () => 2_000, retryDelaysMs: [500] },
    );

    expect(result).toMatchObject({ kind: 'retry', proof: 'no_side_effect' });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('rechecks abort after an awaited authority fence', async () => {
    const record = row();
    const transport = deps();
    const controller = new AbortController();
    const authorityStarted = deferred<void>();
    const authorityRelease = deferred<void>();
    const delivery = deliverDurableLarkOutbox(
      record,
      context(record, 1, controller.signal),
      transport,
      {
        now: () => 2_000,
        retryDelaysMs: [500],
        beforeEffect: async () => {
          authorityStarted.resolve();
          await authorityRelease.promise;
        },
      },
    );
    await authorityStarted.promise;
    controller.abort();
    authorityRelease.resolve();

    await expect(delivery).resolves.toMatchObject({ kind: 'retry', proof: 'no_side_effect' });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('contains corrupt durable payloads as ambiguous', async () => {
    const record = row();
    const transport = deps();
    const result = await deliverDurableLarkOutbox(
      { ...record, payload: { version: 2 } },
      context(record),
      transport,
    );

    expect(result).toMatchObject({ kind: 'ambiguous' });
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(transport.replyMessage).not.toHaveBeenCalled();
    expect(transport.updateMessage).not.toHaveBeenCalled();
  });
});
