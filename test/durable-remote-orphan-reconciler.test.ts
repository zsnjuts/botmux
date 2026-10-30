import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../src/types.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { createDurableSessionFacade } from '../src/services/durable-session-facade.js';
import {
  durableDirectSessionControlEvent,
  durableInteractiveSessionControlPartition,
  durableLarkSessionControlPartition,
  durableRemoteOrphanControlPartition,
} from '../src/services/durable-lark-session-control.js';
import { admitDurableLarkSession } from '../src/services/durable-session-primary.js';
import {
  durableRemoteOrphanOperationId,
  parseDurableRemoteOrphanOperationId,
  scanDurableRemoteOrphans,
} from '../src/services/durable-remote-orphan-reconciler.js';

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
    const revision = (await store.readSession('om_root::cli_test'))!.revision;
    expect(claim?.event).toMatchObject({
      eventId: `trusted-host.remote-orphan:cli_test:session-orphan:2:r${revision}`,
      payload: {
        source: 'trusted-host',
        action: 'terminalize_orphan',
        sessionId: 'session-orphan',
      },
    });
    await facade.stop();
    await store.close();
  });

  it('does not let a legacy ordinary-partition orphan backoff block a later explicit close', async () => {
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
    const legacyOrphan = durableDirectSessionControlEvent({
      source: 'trusted-host',
      larkAppId: 'cli_test',
      operationId: 'trusted-host.remote-orphan:cli_test:session-orphan:2',
      action: 'terminalize_orphan',
      sessionId: 'session-orphan',
      rootId: 'om_root',
      cardMessageId: 'om_card',
      now: clock,
    });
    legacyOrphan.partitionKey = durableLarkSessionControlPartition('cli_test', 'session-orphan');
    await store.enqueueInbox(legacyOrphan);
    const orphan = await store.claimNextInbox({
      workerId: 'orphan-worker',
      lane: 'session-control',
      partitionKeys: [durableLarkSessionControlPartition('cli_test', 'session-orphan')],
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
      partitionKeys: [durableInteractiveSessionControlPartition('cli_test', 'session-orphan')],
      leaseDurationMs: 100,
    });
    expect(close?.event.eventId).toBe('lark-command.session-control:cli_test:om_close');
    expect(close?.attempts).toBe(1);
    expect(await store.claimNextInbox({
      workerId: 'orphan-too-early',
      lane: 'session-control',
      partitionKeys: [durableLarkSessionControlPartition('cli_test', 'session-orphan')],
      leaseDurationMs: 100,
    })).toBeUndefined();
    await facade.stop();
    await store.close();
  });

  it('isolates a legacy partition conflict and continues scanning later Sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-orphan-legacy-conflict-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'seed-owner' });

    const legacySession = canonical();
    legacySession.sessionId = 'session-legacy-conflict';
    legacySession.rootMessageId = 'om_a_root';
    const laterSession = canonical();
    laterSession.sessionId = 'session-later';
    laterSession.rootMessageId = 'om_b_root';
    for (const [messageId, session] of [
      ['om_a_turn', legacySession],
      ['om_b_turn', laterSession],
    ] as const) {
      await admitDurableLarkSession({
        facade,
        message: {
          eventType: 'lark.im.message.receive_v1',
          eventId: `im.message.receive_v1:cli_test:${messageId}`,
          partitionKey: 'lark-message-routing:cli_test:oc_chat',
          larkAppId: 'cli_test',
          messageId,
          attempts: 1,
          data: {},
        },
        session,
      });
      await facade.releaseLease(`${session.rootMessageId}::cli_test`);
    }

    const legacyOperationId = durableRemoteOrphanOperationId({
      larkAppId: 'cli_test',
      sessionId: 'session-legacy-conflict',
      generation: 2,
      revision: (await store.readSession('om_a_root::cli_test'))!.revision,
    });
    const legacyEvent = durableDirectSessionControlEvent({
      source: 'trusted-host',
      larkAppId: 'cli_test',
      operationId: legacyOperationId,
      action: 'terminalize_orphan',
      sessionId: 'session-legacy-conflict',
      rootId: 'om_a_root',
      cardMessageId: 'om_card',
      now: 9,
    });
    // Simulate the durable row shape written before orphan partition isolation.
    legacyEvent.partitionKey = durableLarkSessionControlPartition(
      'cli_test',
      'session-legacy-conflict',
    );
    await expect(store.enqueueInbox(legacyEvent)).resolves.toEqual({ kind: 'inserted' });

    const errors: unknown[] = [];
    await expect(scanDurableRemoteOrphans({
      store,
      larkAppId: 'cli_test',
      ownerId: 'orphan-owner',
      hasLocalOwner: () => false,
      onError: error => errors.push(error),
      now: () => 10,
    })).resolves.toMatchObject({
      scanned: 2,
      candidates: 2,
      enqueued: 1,
      duplicates: 0,
      invalid: 1,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(expect.objectContaining({
      message: `durable orphan reconciliation conflict ${legacyOperationId}`,
    }));

    const later = await store.claimNextInbox({
      workerId: 'later-worker',
      lane: 'session-control',
      partitionKeys: [durableRemoteOrphanControlPartition('cli_test', 'session-later')],
      leaseDurationMs: 100,
    });
    expect(later?.event.eventId).toBe(durableRemoteOrphanOperationId({
      larkAppId: 'cli_test',
      sessionId: 'session-later',
      generation: 2,
      revision: (await store.readSession('om_b_root::cli_test'))!.revision,
    }));

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
  it('parses both pinned and legacy orphan operation ids', () => {
    expect(parseDurableRemoteOrphanOperationId('trusted-host.remote-orphan:cli_a:s-1:3:r17'))
      .toEqual({ generation: 3, revision: 17 });
    expect(parseDurableRemoteOrphanOperationId('trusted-host.remote-orphan:cli_a:s-1:3'))
      .toEqual({ generation: 3 });
    expect(parseDurableRemoteOrphanOperationId('trusted-host.session-control:cli_a:s-1:1:close'))
      .toBeUndefined();
    expect(parseDurableRemoteOrphanOperationId('trusted-host.remote-orphan:cli_a:s-1:x:r1'))
      .toBeUndefined();
  });
});
