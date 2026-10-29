import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  durableInboxExhaustedNotice,
  durableInboxRetryNotice,
  enqueueDurableInboxExhaustedNotice,
  enqueueDurableInboxRetryNotice,
  MESSAGE_QUOTA_INFRASTRUCTURE_RETRY,
  MESSAGE_QUOTA_RETRY_NOTICE_ZH,
} from '../src/services/durable-inbox-retry-notice.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function claim(eventType: DurableLarkMessageClaim['eventType'] = 'lark.im.message.receive_v1'):
DurableLarkMessageClaim {
  return {
    eventType,
    eventId: 'im.message.receive_v1:cli_demo:om_demo',
    partitionKey: 'lark-message-routing:cli_demo:oc_demo',
    larkAppId: 'cli_demo',
    messageId: 'om_demo',
    attempts: 1,
    data: {},
  };
}

describe('durable Inbox retry notice', () => {
  it('uses one stable provider UUID and a bounded Chinese explanation', () => {
    const first = durableInboxRetryNotice(claim(), {
      kind: 'retry',
      reason: MESSAGE_QUOTA_INFRASTRUCTURE_RETRY,
    });
    const second = durableInboxRetryNotice(claim(), {
      kind: 'retry',
      reason: MESSAGE_QUOTA_INFRASTRUCTURE_RETRY,
    });
    expect(first).toEqual(second);
    expect(first?.anchor).toBe('om_demo');
    expect(first?.providerUuid).toMatch(/^retry_[0-9a-f]{40}$/);
    expect(first?.content).toBe(MESSAGE_QUOTA_RETRY_NOTICE_ZH);
    expect(first?.content).toContain('消息不会丢失');
  });

  it('does not warn for unrelated retries or edited-message events', () => {
    expect(durableInboxRetryNotice(claim(), { kind: 'retry', reason: 'owner_busy' }))
      .toBeUndefined();
    expect(durableInboxRetryNotice(claim('lark.im.message.updated_v1'), {
      kind: 'retry',
      reason: MESSAGE_QUOTA_INFRASTRUCTURE_RETRY,
    })).toBeUndefined();
  });

  it('enqueues exactly one durable Outbox row across repeated Inbox retries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'botmux-retry-notice-'));
    tempDirs.push(directory);
    const store = new SqliteDurableCoordinationStore(join(directory, 'coordination.db'), {
      now: () => 10,
    });
    const message = claim();
    const result = { kind: 'retry' as const, reason: MESSAGE_QUOTA_INFRASTRUCTURE_RETRY };
    expect(await enqueueDurableInboxRetryNotice({
      store, message, result, ownerId: 'notice-owner', now: 10,
    })).toBe('accepted');
    expect(await enqueueDurableInboxRetryNotice({
      store, message, result, ownerId: 'notice-owner', now: 20,
    })).toBe('accepted');
    const notice = durableInboxRetryNotice(message, result)!;
    const row = await store.readOutbox(`out_${notice.providerUuid}`);
    expect(row).toMatchObject({
      messageId: `out_${notice.providerUuid}`,
      state: 'pending',
      attempts: 0,
      sessionKey: `retry-notice:${notice.providerUuid}`,
    });
    store.close();
  });

  it('tells the sender once that a message dropped at the retry limit was not executed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'botmux-dropped-notice-'));
    tempDirs.push(directory);
    const store = new SqliteDurableCoordinationStore(join(directory, 'coordination.db'), {
      now: () => 10,
    });
    const message = claim();
    for (const now of [10, 20]) {
      expect(await enqueueDurableInboxExhaustedNotice({
        store, message, ownerId: 'notice-owner', now,
      })).toBe('accepted');
    }
    const notice = durableInboxExhaustedNotice(message)!;
    expect(notice.anchor).toBe('om_demo');
    expect(notice.providerUuid).toMatch(/^drop_[0-9a-f]{40}$/);
    expect(notice.providerUuid).not.toBe(durableInboxRetryNotice(message, {
      kind: 'retry',
      reason: MESSAGE_QUOTA_INFRASTRUCTURE_RETRY,
    })!.providerUuid);
    expect(await store.readOutbox(`out_${notice.providerUuid}`)).toMatchObject({
      state: 'pending',
      attempts: 0,
    });
    expect(durableInboxExhaustedNotice(claim('lark.im.message.updated_v1'))).toBeUndefined();
    store.close();
  });
});
