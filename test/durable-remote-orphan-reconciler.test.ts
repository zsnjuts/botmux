import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../src/types.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { createDurableSessionFacade } from '../src/services/durable-session-facade.js';
import {
  durableDirectSessionControlEvent,
  durableLarkSessionControlPartition,
  durableRemoteOrphanControlPartition,
} from '../src/services/durable-lark-session-control.js';
import { admitDurableLarkSession } from '../src/services/durable-session-primary.js';
import { scanDurableRemoteOrphans } from '../src/services/durable-remote-orphan-reconciler.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function canonical(): Session {
  return {
    sessionId: 'session-orphan',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    scope: 'thread',
    title: 'submitted remote turn',
    status: 'active',
    createdAt: '2026-10-23T00:00:00.000Z',
    larkAppId: 'cli_test',
    cliId: 'remote-runner',
    backendType: 'remote-runner',
    streamCardId: 'om_card',
    remoteBackendState: {
      version: 1,
      provider: 'reference',
      generation: 2,
      remoteSessionId: 'remote-expired',
      agentThreadId: 'thread-existing',
      providerState: { sessionKey: 'logical-session' },
    },
  };
}

describe('durable Remote Runner orphan reconciler', () => {
  it('enqueues one stable trusted-host control and deduplicates periodic scans', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-orphan-reconcile-'));
    tempDirs.push(dir);
    let clock = 10;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), {
      now: () => clock,
    });
    const facade = createDurableSessionFacade({ store, ownerId: 'seed-owner' });
    await admitDurableLarkSession({
      facade,
      message: {
        eventType: 'lark.im.message.receive_v1',
        eventId: 'im.message.receive_v1:cli_test:om_turn',
        partitionKey: 'lark-message-routing:cli_test:oc_chat',
        larkAppId: 'cli_test',
        messageId: 'om_turn',
        attempts: 1,
        data: {},
      },
      session: canonical(),
    });
    await facade.releaseLease('om_root::cli_test');

    const first = await scanDurableRemoteOrphans({
      store,
      larkAppId: 'cli_test',
      ownerId: 'orphan-owner',
      hasLocalOwner: () => false,
      now: () => clock,
    });
    expect(first).toMatchObject({ scanned: 1, candidates: 1, enqueued: 1, duplicates: 0 });

    clock += 1;
    const second = await scanDurableRemoteOrphans({
      store,
      larkAppId: 'cli_test',
      ownerId: 'orphan-owner',
      hasLocalOwner: () => false,
      now: () => clock,
    });
    expect(second).toMatchObject({ scanned: 1, candidates: 1, enqueued: 0, duplicates: 1 });

    const claim = await store.claimNextInbox({
      workerId: 'control-worker',
      lane: 'session-control',
      partitionKeys: [durableRemoteOrphanControlPartition('cli_test', 'session-orphan')],
      leaseDurationMs: 60_000,
    });
    expect(claim?.event).toMatchObject({
      eventId: 'trusted-host.remote-orphan:cli_test:session-orphan:2',
      payload: {
        source: 'trusted-host',
        action: 'terminalize_orphan',
        sessionId: 'session-orphan',
      },
    });
    await facade.stop();
    await store.close();
  });

  it('does not let an orphan proof backoff block a later explicit close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-orphan-close-bypass-'));
    tempDirs.push(dir);
    let clock = 10;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), {
      now: () => clock,
    });
    const facade = createDurableSessionFacade({ store, ownerId: 'seed-owner' });
    await admitDurableLarkSession({
      facade,
      message: {
        eventType: 'lark.im.message.receive_v1',
        eventId: 'im.message.receive_v1:cli_test:om_turn',
        partitionKey: 'lark-message-routing:cli_test:oc_chat',
        larkAppId: 'cli_test',
        messageId: 'om_turn',
        attempts: 1,
        data: {},
      },
      session: canonical(),
    });
    await facade.releaseLease('om_root::cli_test');
    await scanDurableRemoteOrphans({
      store,
      larkAppId: 'cli_test',
      ownerId: 'orphan-owner',
      hasLocalOwner: () => false,
      now: () => clock,
    });
    const orphan = await store.claimNextInbox({
      workerId: 'orphan-worker',
      lane: 'session-control',
      partitionKeys: [durableRemoteOrphanControlPartition('cli_test', 'session-orphan')],
      leaseDurationMs: 100,
    });
    expect(orphan).toBeDefined();
    await store.retryInboxClaim({ claim: orphan!, visibleAt: 1_000 });

    clock = 11;
    await store.enqueueInbox(durableDirectSessionControlEvent({
      source: 'lark-command',
      larkAppId: 'cli_test',
      operationId: 'lark-command.session-control:cli_test:om_close',
      action: 'close',
      sessionId: 'session-orphan',
      rootId: 'om_root',
      operatorOpenId: 'ou_operator',
      cardMessageId: 'om_close',
      now: clock,
    }));
    const close = await store.claimNextInbox({
      workerId: 'close-worker',
      lane: 'session-control',
      partitionKeys: [durableLarkSessionControlPartition('cli_test', 'session-orphan')],
      leaseDurationMs: 100,
    });
    expect(close?.event.eventId).toBe('lark-command.session-control:cli_test:om_close');
    expect(close?.attempts).toBe(1);
    expect(await store.claimNextInbox({
      workerId: 'orphan-too-early',
      lane: 'session-control',
      partitionKeys: [durableRemoteOrphanControlPartition('cli_test', 'session-orphan')],
      leaseDurationMs: 100,
    })).toBeUndefined();
    await facade.stop();
    await store.close();
  });

  it('leaves a valid local owner and an occupied cross-replica lease untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-orphan-owned-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'live-owner' });
    await admitDurableLarkSession({
      facade,
      message: {
        eventType: 'lark.im.message.receive_v1',
        eventId: 'im.message.receive_v1:cli_test:om_turn',
        partitionKey: 'lark-message-routing:cli_test:oc_chat',
        larkAppId: 'cli_test',
        messageId: 'om_turn',
        attempts: 1,
        data: {},
      },
      session: canonical(),
    });

    await expect(scanDurableRemoteOrphans({
      store,
      larkAppId: 'cli_test',
      ownerId: 'other-owner',
      hasLocalOwner: () => true,
    })).resolves.toMatchObject({ candidates: 0, occupied: 0, enqueued: 0 });
    await expect(scanDurableRemoteOrphans({
      store,
      larkAppId: 'cli_test',
      ownerId: 'other-owner',
      hasLocalOwner: () => false,
    })).resolves.toMatchObject({ candidates: 1, occupied: 1, enqueued: 0 });
    await facade.stop();
    await store.close();
  });

  it('does not let a stranded recovered-turn owner suppress provider reconciliation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-orphan-stranded-owner-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'seed-owner' });
    const stranded = canonical();
    stranded.lastFailedTurn = {
      turnId: 'om_recovered',
      userPrompt: 'original prompt',
      cliInput: 'original input',
      failedAt: '2026-10-23T00:01:00.000Z',
      errorCode: 'provider_takeover_failed',
      status: 'ambiguous',
      retryCount: 0,
      recoveredRemoteTurn: true,
    };
    await admitDurableLarkSession({
      facade,
      message: {
        eventType: 'lark.im.message.receive_v1',
        eventId: 'im.message.receive_v1:cli_test:om_turn',
        partitionKey: 'lark-message-routing:cli_test:oc_chat',
        larkAppId: 'cli_test',
        messageId: 'om_turn',
        attempts: 1,
        data: {},
      },
      session: stranded,
    });
    await facade.releaseLease('om_root::cli_test');

    await expect(scanDurableRemoteOrphans({
      store,
      larkAppId: 'cli_test',
      ownerId: 'orphan-owner',
      hasLocalOwner: () => true,
    })).resolves.toMatchObject({ candidates: 1, enqueued: 1 });

    await facade.stop();
    await store.close();
  });
});
