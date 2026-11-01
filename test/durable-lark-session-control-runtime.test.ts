import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import type { InboxClaim } from '../src/services/durable-coordination.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { createDurableSessionFacade } from '../src/services/durable-session-facade.js';
import { createDurableSessionControlDispatch } from '../src/services/durable-session-control-dispatch.js';
import {
  durableDirectSessionControlEvent,
  durableInteractiveSessionControlPartition,
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
  parseDurableLarkSessionControlClaim,
  parseDurableSessionControlClaim,
} from '../src/services/durable-lark-session-control.js';
import { createDurableLarkSessionControlRuntime } from '../src/services/durable-lark-session-control-runtime.js';
import { DURABLE_REMOTE_ORPHAN_RESCAN_EPOCH_MS } from '../src/services/durable-remote-orphan-reconciler.js';
import {
  DurableActiveTakeoverUnsupportedError,
  DurableSessionControlOwnerHandoffError,
} from '../src/services/durable-session-control-errors.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import { admitDurableLarkSession, parseDurablePrimarySessionRecord } from '../src/services/durable-session-primary.js';
import { parseDurableLarkOutboxRecord } from '../src/services/durable-lark-outbox.js';

const tempDirs: string[] = [];

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    chatId: 'oc_chat',
    chatType: 'group',
    rootMessageId: 'om_root',
    scope: 'thread',
    title: 'Control Session',
    status: 'active',
    createdAt: '2026-10-09T00:00:00.000Z',
    larkAppId: 'cli_test',
    ownerOpenId: 'ou_owner',
    streamCardId: 'om_card',
    ...overrides,
  };
}

function message(): DurableLarkMessageClaim {
  return {
    eventType: 'lark.im.message.receive_v1',
    eventId: 'im.message.receive_v1:cli_test:om_turn',
    partitionKey: 'lark-message-routing:cli_test:oc_chat',
    larkAppId: 'cli_test',
    messageId: 'om_turn',
    attempts: 1,
    data: { message: { message_id: 'om_turn' } },
  };
}

function control(action: 'close' | 'resume' = 'close') {
  const data = {
    event_id: `evt_${action}`,
    action: { value: { action, session_id: 'session-1', root_id: 'om_root' } },
    operator: { open_id: 'ou_operator' },
    context: { open_message_id: 'om_card' },
  };
  const event = durableLarkSessionControlEvent({
    larkAppId: 'cli_test',
    eventId: durableLarkSessionControlEventId('cli_test', `evt_${action}`),
    partitionKey: durableInteractiveSessionControlPartition('cli_test', 'session-1'),
    data,
    now: 2,
  });
  const claim: InboxClaim = {
    event,
    workerId: 'control-worker',
    claimEpoch: 1,
    claimUntil: 60_000,
    attempts: 1,
  };
  return { data, claim, control: parseDurableLarkSessionControlClaim(claim) };
}

function displayControl(target: 'hidden' | 'screenshot' = 'screenshot') {
  const data = {
    event_id: `evt_display_${target}`,
    action: {
      value: {
        action: 'toggle_display',
        target_display_mode: target,
        session_id: 'session-1',
        root_id: 'om_root',
      },
    },
    operator: { open_id: 'ou_viewer' },
    context: { open_message_id: 'om_card' },
  };
  const event = durableLarkSessionControlEvent({
    larkAppId: 'cli_test',
    eventId: durableLarkSessionControlEventId('cli_test', `evt_display_${target}`),
    partitionKey: durableInteractiveSessionControlPartition('cli_test', 'session-1'),
    data,
    now: 2,
  });
  const claim: InboxClaim = {
    event,
    workerId: 'control-worker',
    claimEpoch: 1,
    claimUntil: 60_000,
    attempts: 1,
  };
  return { data, claim, control: parseDurableLarkSessionControlClaim(claim) };
}

function directControl(
  source: 'lark-command' | 'trusted-host',
  action: 'close' | 'resume' | 'handoff' | 'terminalize_orphan' = 'close',
  retiringOwnerId = 'retiring-owner',
) {
  const event = durableDirectSessionControlEvent({
    source,
    larkAppId: 'cli_test',
    operationId: `${source}.session-control:cli_test:session-1:1:${action}`,
    action,
    sessionId: 'session-1',
    rootId: 'om_root',
    ...(source === 'lark-command' ? { operatorOpenId: 'ou_operator' } : {}),
    ...(action === 'handoff' ? { retiringOwnerId } : {}),
    cardMessageId: 'om_card',
    now: 2,
  });
  const claim: InboxClaim = {
    event,
    workerId: 'control-worker',
    claimEpoch: 1,
    claimUntil: 60_000,
    attempts: 1,
  };
  return { claim, control: parseDurableSessionControlClaim(claim) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable Lark session control runtime', () => {
  it('directly resumes a bound closed Session on the requesting replica with durable fencing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-direct-resume-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'closed-owner' });
    const canonical = session({ status: 'closed', closedAt: '2026-10-09T01:00:00.000Z' });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();

    const facade = createDurableSessionFacade({ store, ownerId: 'schedule-owner' });
    let persisted: Session | undefined;
    let active: DaemonSession | undefined;
    const resumeSession = vi.fn(async () => {
      persisted = { ...structuredClone(canonical), status: 'active', closedAt: undefined };
      active = {
        session: persisted,
        worker: { killed: false } as any,
        workerPort: 1234,
        workerToken: 'token',
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        chatType: 'group',
        scope: 'thread',
        spawnedAt: 0,
        cliVersion: 'test',
        lastMessageAt: 0,
        hasHistory: true,
        workingDir: '/tmp',
      };
      return { ok: true as const, ds: active };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: id => active?.session.sessionId === id ? active : undefined,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: id => persisted?.sessionId === id ? persisted : undefined,
      materializeClosedSession: value => {
        persisted = structuredClone(value);
        return persisted;
      },
      canOperate: () => false,
      closeSession: vi.fn(),
      resumeSession,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: error => error,
      now: () => 20,
    });

    const input = {
      operationId: 'schedule-bound-resume:task0001:run-1:session-1',
      sessionId: 'session-1',
      rootId: 'om_root',
    };
    await expect(runtime.resumeTrustedDirect(input)).resolves.toBeUndefined();
    expect(resumeSession).toHaveBeenCalledOnce();
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({
        session: { sessionId: 'session-1', status: 'active' },
        controls: [{ source: 'trusted-host', action: 'resume', operationId: input.operationId }],
      });
    await expect(runtime.resumeTrustedDirect(input)).resolves.toBeUndefined();
    expect(resumeSession).toHaveBeenCalledOnce();
    await facade.stop();
    await store.close();
  });

  it('closes a never-started canonical remote Session from trusted host state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-unstarted-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const canonical = session({
      remoteBackendState: {
        version: 1,
        provider: 'tae-traex',
        generation: 0,
        providerState: { sessionKey: 'bmx1-never-started' },
      },
    });
    let persisted: Session | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: canonical });
    const materializeClosedSession = vi.fn((value: Session) => {
      persisted = structuredClone(value);
      return persisted;
    });
    const closeSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession,
      takeOverActiveSession: vi.fn(async () => {
        throw new Error('must not take over an unstarted remote Session');
      }),
      canOperate: () => false,
      closeSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: error => error,
      now: () => 20,
    });
    const input = directControl('trusted-host');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(materializeClosedSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      status: 'closed',
      closedAt: new Date(20).toISOString(),
    }));
    expect(closeSession).not.toHaveBeenCalled();
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({
        session: { status: 'closed' },
        controls: [{ source: 'trusted-host', action: 'close' }],
      });
    await facade.stop();
  });

  it('settles close when no replica can ever take the remote Session over (Mew #23)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-unsupported-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    // generation 1 without a remote session id: the start was attempted but the
    // sandbox was full, so nothing resumable was ever published.
    const canonical = session({
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'tae-traex',
        generation: 1,
        providerState: { sessionKey: 'bmx1-capacity-full' },
      },
    });
    let persisted: Session | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: canonical });
    const materializeClosedSession = vi.fn((value: Session) => {
      persisted = structuredClone(value);
      return persisted;
    });
    const takeOverActiveSession = vi.fn(async () => {
      throw new DurableActiveTakeoverUnsupportedError(
        'durable active takeover failed: unsupported_session '
        + '(canonical Session has no resumable Remote Runner state)',
      );
    });
    const closeSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession,
      takeOverActiveSession,
      canOperate: () => false,
      closeSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: error => error,
      now: () => 20,
    });
    const input = directControl('trusted-host');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(takeOverActiveSession).toHaveBeenCalledOnce();
    expect(materializeClosedSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      status: 'closed',
      closedAt: new Date(20).toISOString(),
    }));
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({
        session: { status: 'closed' },
        controls: [{ source: 'trusted-host', action: 'close' }],
      });
    await facade.stop();
  });

  it('retires a never-started Remote Runner when a trusted host requests handoff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-unstarted-handoff-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'retiring-owner' });
    const canonical = session({
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'tae-traex',
        generation: 0,
        providerState: { sessionKey: 'bmx1-never-started' },
      },
    });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();

    const facade = createDurableSessionFacade({ store, ownerId: 'peer-owner' });
    let persisted: Session | undefined;
    const materializeClosedSession = vi.fn((value: Session) => {
      persisted = structuredClone(value);
      return persisted;
    });
    const takeOverActiveSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession,
      takeOverActiveSession,
      canOperate: () => true,
      closeSession: vi.fn(),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: error => error,
      now: () => 20,
    });
    const input = directControl('trusted-host', 'handoff', 'retiring-owner');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(materializeClosedSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      status: 'closed',
      closedAt: new Date(20).toISOString(),
    }));
    expect(takeOverActiveSession).not.toHaveBeenCalled();
    expect(await store.readControlOperation(input.control.operationId)).toMatchObject({
      state: 'completed',
      attempts: 1,
      result: {
        action: 'handoff',
        status: 'closed',
        applied: false,
        recovery: 'never-started',
      },
    });
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({
        session: { status: 'closed' },
        controls: [{
          source: 'trusted-host',
          action: 'handoff',
          operationId: input.control.operationId,
        }],
      });
    await facade.stop();
    await store.close();
  });

  it('reconciles a legacy ambiguous handoff for a never-started Remote Runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-legacy-handoff-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'retiring-owner' });
    const canonical = session({
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'tae-traex',
        generation: 0,
        providerState: { sessionKey: 'bmx1-never-started' },
      },
    });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();

    const facade = createDurableSessionFacade({ store, ownerId: 'peer-owner' });
    const input = directControl('trusted-host', 'handoff', 'retiring-owner');
    const acquired = await store.acquireSessionLease({
      sessionKey: 'om_root::cli_test',
      ownerId: facade.ownerId,
      leaseDurationMs: 60_000,
    });
    if (acquired.kind !== 'acquired') throw new Error('expected Session lease');
    const operationPayload = {
      version: 1,
      type: 'botmux.lark.session-control-operation',
      larkAppId: 'cli_test',
      action: 'handoff',
      sessionId: 'session-1',
      rootId: 'om_root',
      operatorOpenId: 'trusted-host',
      cardMessageId: 'om_card',
      retiringOwnerId: 'retiring-owner',
    };
    await store.enqueueControlOperation({
      lease: acquired.lease,
      operation: {
        operationId: input.control.operationId,
        sessionKey: 'om_root::cli_test',
        payload: operationPayload,
        createdAt: input.claim.event.createdAt,
      },
    });
    const begun = await store.beginControlOperationAttempt({
      lease: acquired.lease,
      operationId: input.control.operationId,
    });
    if (begun.kind !== 'applied') throw new Error('expected control attempt');
    await store.markControlOperationAmbiguous({
      attempt: begun.attempt,
      error: 'legacy takeover could not reattach generation zero',
    });

    let persisted: Session | undefined;
    const takeOverActiveSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => {
        persisted = structuredClone(value);
        return persisted;
      },
      takeOverActiveSession,
      canOperate: () => true,
      closeSession: vi.fn(),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: error => error,
      now: () => 300_003,
    });
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(takeOverActiveSession).not.toHaveBeenCalled();
    expect(await store.readControlOperation(input.control.operationId)).toMatchObject({
      state: 'completed',
      attempts: 1,
      reconciliation: {
        kind: 'completed',
        attempt: 1,
        evidence: {
          source: 'session-store',
          status: 'closed',
          recovery: 'never-started',
        },
      },
      result: { action: 'handoff', status: 'closed' },
    });
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({ session: { status: 'closed' } });
    await facade.stop();
    await store.close();
  });

  it('re-authorizes typed Lark controls but trusts the HMAC-gated host source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-source-auth-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const current = session();
    await admitDurableLarkSession({ facade, message: message(), session: current });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [current],
      getPersistedSession: () => current,
      materializeClosedSession: value => value,
      canOperate: () => false,
      closeSession: vi.fn(),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: error => error,
    });

    await expect(runtime.resolve(directControl('lark-command').control, {
      claim: directControl('lark-command').claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'ignored', reason: 'operator is not allowed to control this Session' });
    await expect(runtime.resolve(directControl('trusted-host').control, {
      claim: directControl('trusted-host').claim,
      signal: new AbortController().signal,
    })).rejects.toThrow(/could not be taken over/);
    await facade.stop();
  });

  it('closes one owned Session, commits canonical state, and enqueues an idempotent card update', async () => {
    let now = 10;
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    let persisted = session();
    let active: DaemonSession | undefined = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
    } as DaemonSession;
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const closeSession = vi.fn(async () => {
      persisted = { ...persisted, status: 'closed', closedAt: '2026-10-09T00:01:00.000Z' };
      active = undefined;
      return { ok: true, outcome: 'closed' as const, alreadyClosed: false };
    });
    let operatorAllowed = true;
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active || undefined,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => operatorAllowed,
      closeSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => '{"header":{"title":"closed"}}',
      buildActiveCard: () => '{"header":{"title":"active"}}',
      buildPendingCard: action => JSON.stringify({ pending: action }),
      closeResidualText: residual => `residual:${residual.taskId}`,
      closeRefusedText: (error, taskId) => `refused:${error}:${taskId}`,
      resumeRefusedText: error => error,
      now: () => now,
    });
    const input = control();
    const resolved = await runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    });
    if (resolved.kind !== 'target') throw new Error('expected control target');
    await expect(resolved.target.commit({
      version: 1,
      type: 'botmux.lark.session-control-result',
      action: 'resume',
      sessionId: 'session-1',
      status: 'closed',
    }, new AbortController().signal)).rejects.toThrow(/result is invalid/);
    expect(await runtime.authorizeBeforeAck(input.data)).toBe(true);
    await expect(runtime.pendingCardBeforeAck(input.data)).resolves.toEqual({ pending: 'close' });
    expect(await runtime.authorizeBeforeAck({
      ...input.data,
      context: { open_message_id: 'om_stale_card' },
    })).toBe(false);
    operatorAllowed = false;
    expect(await runtime.authorizeBeforeAck(input.data)).toBe(false);
    await expect(runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'ignored',
      reason: 'operator is not allowed to control this Session',
    });
    operatorAllowed = true;
    expect(runtime.ownedPartitionKeys()).toEqual([
      'lark-session-control:cli_test:interactive:session-1',
      'lark-session-control:cli_test:session-1',
    ]);
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(closeSession).toHaveBeenCalledOnce();
    const canonical = await store.readSession('om_root::cli_test');
    expect(canonical).toBeDefined();
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'closed' },
      controls: [{ action: 'close', operationId: input.control.operationId }],
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    const output = await store.readOutbox(`control_update_${digest}`);
    expect(output).toMatchObject({ state: 'pending' });
    expect(parseDurableLarkOutboxRecord(output!)).toMatchObject({
      target: { kind: 'update', messageId: 'om_card' },
      content: '{"header":{"title":"closed"}}',
    });
    now = 11;
    expect(runtime.ownedPartitionKeys()).toEqual([
      'lark-session-control:cli_test:interactive:session-1',
    ]);
    await facade.stop();
    await store.close();
  });

  it('authorizes on the shared canonical Session when ingress and owner are different Pods', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-cross-pod-auth-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not local' }),
      resumeSession: async () => ({ ok: false, error: 'not local' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      resumeRefusedText: error => error,
    });

    expect(await runtime.authorizeBeforeAck(control().data)).toBe(true);
    expect(runtime.ownedPartitionKeys()).toEqual([]);
    await facade.stop();
    await store.close();
  });

  it('advertises an active control partition only from the replica holding its Session lease', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-active-owner-partition-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const ownerFacade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const standbyFacade = createDurableSessionFacade({ store, ownerId: 'session-standby' });
    const persisted = session();
    const active = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
    } as DaemonSession;
    await admitDurableLarkSession({ facade: ownerFacade, message: message(), session: persisted });
    const makeRuntime = (facade: ReturnType<typeof createDurableSessionFacade>) =>
      createDurableLarkSessionControlRuntime({
        larkAppId: 'cli_test',
        privateCard: false,
        store,
        facade: () => facade,
        listActiveSessions: () => [active],
        findActiveSession: () => active,
        listPersistedSessions: () => [persisted],
        getPersistedSession: () => persisted,
        materializeClosedSession: value => value,
        canOperate: () => true,
        closeSession: async () => ({ ok: false, error: 'not called' }),
        resumeSession: async () => ({ ok: false, error: 'not called' }),
        buildClosedCard: () => 'closed',
        buildActiveCard: () => 'active',
        closeResidualText: () => 'residual',
        closeRefusedText: () => 'refused',
        resumeRefusedText: () => 'resume-refused',
      });

    expect(makeRuntime(ownerFacade).ownedPartitionKeys()).toEqual([
      'lark-session-control:cli_test:interactive:session-1',
      'lark-session-control:cli_test:session-1',
    ]);
    expect(makeRuntime(standbyFacade).ownedPartitionKeys()).toEqual([]);

    await ownerFacade.stop();
    await standbyFacade.stop();
    await store.close();
  });

  it('authorizes an early display toggle from the local card owner before canonical admission', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-display-pre-admission-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = session();
    const active = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
      displayMode: 'hidden',
    } as DaemonSession;
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [active],
      findActiveSession: sessionId => (sessionId === active.session.sessionId ? active : undefined),
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => false,
      closeSession: async () => ({ ok: false, error: 'not called' }),
      resumeSession: async () => ({ ok: false, error: 'not called' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = displayControl();

    expect(await runtime.authorizeBeforeAck(input.data)).toBe(true);
    expect(await runtime.authorizeBeforeAck({
      ...input.data,
      context: { open_message_id: 'om_other_card' },
    })).toBe(false);
    expect(await runtime.authorizeBeforeAck({
      ...input.data,
      action: {
        value: {
          action: 'toggle_display',
          target_display_mode: 'screenshot',
          session_id: 'session-1',
          root_id: 'om_other_root',
        },
      },
    })).toBe(false);
    expect(await runtime.authorizeBeforeAck(control().data)).toBe(false);
    await facade.stop();
    await store.close();
  });

  it('routes an idempotent display target to the live owner and durably patches the card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-display-owner-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = session();
    const active = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
      displayMode: 'hidden',
    } as DaemonSession;
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const handlePresentationControl = vi.fn(async () => {
      active.displayMode = 'screenshot';
      return { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: 'screen' }] };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [active],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => false,
      closeSession: async () => ({ ok: false, error: 'not called' }),
      resumeSession: async () => ({ ok: false, error: 'not called' }),
      handlePresentationControl,
      buildClosedCard: () => 'closed',
      buildActiveCard: ds => JSON.stringify({ mode: ds.displayMode }),
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = displayControl();
    expect(await runtime.authorizeBeforeAck(input.data)).toBe(true);
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });
    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(handlePresentationControl).toHaveBeenCalledOnce();
    expect(active.displayMode).toBe('screenshot');
    const canonical = parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!);
    expect(canonical.controls.at(-1)).toMatchObject({
      action: 'toggle_display',
      result: { status: 'active', displayMode: 'screenshot' },
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({
        target: { kind: 'update', messageId: 'om_card' },
        msgType: 'interactive',
      });
    await facade.stop();
    await store.close();
  });

  it('routes display controls from a superseded card to the current canonical stream card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-display-current-card-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = session({ streamCardId: 'om_new_card' });
    const active = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_new_card',
      displayMode: 'hidden',
    } as DaemonSession;
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const handlePresentationControl = vi.fn(async () => {
      active.displayMode = 'screenshot';
      return { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: 'screen' }] };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [active],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => false,
      closeSession: async () => ({ ok: false, error: 'not called' }),
      resumeSession: async () => ({ ok: false, error: 'not called' }),
      handlePresentationControl,
      buildClosedCard: () => 'closed',
      buildActiveCard: ds => JSON.stringify({ mode: ds.displayMode }),
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = displayControl();
    expect(input.control.cardMessageId).toBe('om_card');
    expect(await runtime.authorizeBeforeAck(input.data)).toBe(true);
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(handlePresentationControl).toHaveBeenCalledOnce();
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({
        target: { kind: 'update', messageId: 'om_new_card' },
        msgType: 'interactive',
      });
    await facade.stop();
    await store.close();
  });

  it('drops stale cross-replica display controls after fast owner handoff retries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-stale-display-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      canOperate: () => false,
      closeSession: async () => ({ ok: false, error: 'not called' }),
      resumeSession: async () => ({ ok: false, error: 'not called' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = displayControl();

    await expect(runtime.resolve(input.control, {
      claim: { ...input.claim, attempts: 1 },
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DurableSessionControlOwnerHandoffError);
    await expect(runtime.resolve(input.control, {
      claim: { ...input.claim, attempts: 2 },
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DurableSessionControlOwnerHandoffError);
    await expect(runtime.resolve(input.control, {
      claim: { ...input.claim, attempts: 3 },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: 'ignored',
      reason: 'stale presentation control no longer has a local active target',
      settleExistingOperation: expect.any(Object),
    });
    await facade.stop();
    await store.close();
  });

  it('settles a live display control that never reaches its target mode after a bounded budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-display-budget-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    const live = {
      session: session(),
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
      displayMode: 'hidden',
    } as unknown as DaemonSession;
    const handlePresentationControl = vi.fn(async () => undefined);
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [live],
      findActiveSession: () => live,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      canOperate: () => false,
      closeSession: async () => ({ ok: false, error: 'not called' }),
      resumeSession: async () => ({ ok: false, error: 'not called' }),
      handlePresentationControl,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = displayControl();

    await expect(runtime.resolve(input.control, {
      claim: { ...input.claim, attempts: 8 },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ kind: 'target' });
    await expect(runtime.resolve(input.control, {
      claim: { ...input.claim, attempts: 9 },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: 'ignored',
      reason: 'presentation control did not converge within its retry budget',
      settleExistingOperation: expect.any(Object),
    });
    await facade.stop();
    await store.close();
  });

  it('materializes a canonical closed Session on a fresh replica before resolving resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-canonical-resume-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const canonicalClosed = session({
      status: 'closed',
      closedAt: '2026-10-09T00:01:00.000Z',
      remoteBackendState: {
        version: 1,
        provider: 'test-runner',
        generation: 2,
        agentThreadId: 'thread-1',
      },
    });
    let persisted: Session | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: canonicalClosed });
    const materializeClosedSession = vi.fn((value: Session) => {
      persisted = structuredClone(value);
      return persisted;
    });
    const resumeSession = vi.fn(async () => ({
      ok: false as const,
      error: 'anchor_occupied',
      activeSessionId: 'session-other',
    }));
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      resumeRefusedText: error => error,
    });
    expect(runtime.ownedPartitionKeys()).toEqual([]);
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(materializeClosedSession).toHaveBeenCalledOnce();
    expect(resumeSession).toHaveBeenCalledWith('session-1');
    expect(runtime.ownedPartitionKeys()).toEqual([
      'lark-session-control:cli_test:interactive:session-1',
    ]);
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'closed' },
      controls: [{ action: 'resume', result: { applied: false, error: 'anchor_occupied' } }],
    });
    await facade.stop();
    await store.close();
  });

  it('settles a safe resume refusal once and delivers a durable notice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-refusal-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = session({ status: 'closed', closedAt: '2026-10-09T00:01:00.000Z' });
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession: async () => ({
        ok: false,
        error: 'anchor_occupied',
        activeSessionId: 'session-other',
      }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: residual => `residual:${residual.taskId}`,
      closeRefusedText: (error, taskId) => `refused:${error}:${taskId}`,
      resumeRefusedText: (error, activeSessionId) => `${error}:${activeSessionId}`,
      now: () => 10,
    });
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'closed' },
      controls: [{ action: 'resume', result: { applied: false, error: 'anchor_occupied' } }],
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_notice_${digest}`))!))
      .toMatchObject({
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        content: 'anchor_occupied:session-other',
      });
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({
        target: { kind: 'update', messageId: 'om_card' },
        content: 'closed',
      });
    await facade.stop();
    await store.close();
  });

  it('waits for expected remote readiness without marking the operation ambiguous, then settles rollback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-recovery-rollback-'));
    tempDirs.push(dir);
    let now = 10;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const closed = session({
      status: 'closed',
      closedAt: '2026-10-09T00:01:00.000Z',
      remoteBackendState: {
        version: 1,
        provider: 'test-runner',
        generation: 2,
        agentThreadId: 'thread-1',
      },
    });
    let persisted = closed;
    let active: DaemonSession | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: closed });
    const resumeSession = vi.fn(async () => {
      persisted = { ...closed, status: 'active', closedAt: undefined };
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
      } as DaemonSession;
      return { ok: true as const, ds: active, recoveryPending: true as const };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      resumeRefusedText: error => error,
      resumeReadinessPollMs: 100,
      resumeReadinessStabilityMs: 0,
      resumeReadinessTimeoutMs: 1_000,
      now: () => now,
      wait: async ms => {
        now += ms;
        persisted = closed;
        active = undefined;
      },
    });
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(resumeSession).toHaveBeenCalledOnce();
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'closed' },
      controls: [{
        action: 'resume',
        result: { status: 'closed', applied: false, error: 'resume_start_failed' },
      }],
    });
    const operation = await store.readControlOperation(input.control.operationId);
    expect(operation).toMatchObject({
      state: 'completed',
      attempts: 1,
      result: { status: 'closed', applied: false, error: 'resume_start_failed' },
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_notice_${digest}`))!))
      .toMatchObject({ content: 'resume_start_failed' });
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({
        target: { kind: 'update', messageId: 'om_card' },
        content: 'closed',
      });
    await facade.stop();
    await store.close();
  });

  it('rolls an active resume projection back to the closed card when readiness flickers before 750ms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-recovery-flicker-'));
    tempDirs.push(dir);
    let now = 10;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const closed = session({
      status: 'closed',
      closedAt: '2026-10-09T00:01:00.000Z',
      remoteBackendState: {
        version: 1,
        provider: 'test-runner',
        generation: 2,
        agentThreadId: 'thread-1',
      },
    });
    let persisted = closed;
    let active: DaemonSession | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: closed });
    const resumeSession = vi.fn(async () => {
      persisted = {
        ...closed,
        status: 'active',
        closedAt: undefined,
        remoteBackendState: {
          version: 1,
          provider: 'test-runner',
          generation: 3,
          remoteSessionId: 'compute-2',
          agentThreadId: 'thread-1',
        },
      };
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
        suppressRecoveryCard: true,
        worker: { killed: false },
        workerReady: true,
      } as DaemonSession;
      return { ok: true as const, ds: active, recoveryPending: true as const };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession,
      isResumeReady: ds => !!ds.worker && !ds.worker.killed && ds.workerReady === true,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      resumeRefusedText: error => error,
      resumeReadinessPollMs: 100,
      resumeReadinessStabilityMs: 750,
      resumeReadinessTimeoutMs: 2_000,
      now: () => now,
      wait: async ms => {
        now += ms;
        if (now >= 310) {
          persisted = closed;
          active = undefined;
        }
      },
    });
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(now).toBe(310);
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({
        session: { status: 'closed' },
        controls: [{
          action: 'resume',
          result: { status: 'closed', applied: false, error: 'resume_start_failed' },
        }],
      });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({ content: 'closed' });
    await facade.stop();
    await store.close();
  });

  it('waits for host readiness after the provider generation advances, then requires stability', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-recovery-ready-'));
    tempDirs.push(dir);
    let now = 10;
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const closed = session({
      status: 'closed',
      closedAt: '2026-10-09T00:01:00.000Z',
      remoteBackendState: {
        version: 1,
        provider: 'test-runner',
        generation: 2,
        agentThreadId: 'thread-1',
      },
    });
    let persisted = closed;
    let active: DaemonSession | undefined;
    await admitDurableLarkSession({ facade, message: message(), session: closed });
    const resumeSession = vi.fn(async () => {
      persisted = { ...closed, status: 'active', closedAt: undefined };
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
        suppressRecoveryCard: true,
        worker: { killed: false },
        workerReady: false,
      } as DaemonSession;
      return { ok: true as const, ds: active, recoveryPending: true as const };
    });
    const readinessChecks: Array<{ generation: number | undefined; workerReady: boolean | undefined }> = [];
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession,
      isResumeReady: ds => {
        readinessChecks.push({
          generation: ds.session.remoteBackendState?.generation,
          workerReady: ds.workerReady,
        });
        return !!ds.worker && !ds.worker.killed && ds.workerReady === true;
      },
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      resumeRefusedText: error => error,
      resumeReadinessPollMs: 100,
      resumeReadinessStabilityMs: 200,
      resumeReadinessTimeoutMs: 1_000,
      now: () => now,
      wait: async ms => {
        now += ms;
        if (now >= 110 && active && active.session.remoteBackendState?.generation === 2) {
          persisted = {
            ...persisted,
            remoteBackendState: {
              version: 1,
              provider: 'test-runner',
              generation: 3,
              remoteSessionId: 'compute-2',
              agentThreadId: 'thread-1',
            },
          };
          active = { ...active, session: persisted };
        }
        if (now >= 310 && active && active.workerReady !== true) {
          active = { ...active, workerReady: true };
        }
      },
    });
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(resumeSession).toHaveBeenCalledOnce();
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: {
        status: 'active',
        remoteBackendState: { generation: 3, remoteSessionId: 'compute-2' },
      },
      controls: [{ action: 'resume', result: { status: 'active' } }],
    });
    const operation = await store.readControlOperation(input.control.operationId);
    expect(operation).toMatchObject({ state: 'completed', attempts: 1 });
    expect(readinessChecks).toContainEqual({ generation: 3, workerReady: false });
    expect(readinessChecks).toContainEqual({ generation: 3, workerReady: true });
    expect(now).toBe(510);
    expect(active?.suppressRecoveryCard).toBeUndefined();
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({ content: 'active' });
    await facade.stop();
    await store.close();
  });

  it('durably reports a close residual instead of rendering an ordinary closed card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-residual-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    let persisted = session();
    let active: DaemonSession | undefined = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
    } as DaemonSession;
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      canOperate: () => true,
      closeSession: async () => {
        persisted = { ...persisted, status: 'closed', closedAt: '2026-10-09T00:01:00.000Z' };
        active = undefined;
        return {
          ok: true,
          outcome: 'closed_with_residual',
          alreadyClosed: false,
          residual: { reason: 'mojo_lineage_quarantined', taskId: 'remote-9' },
        };
      },
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'must-not-render-ordinary-closed',
      buildActiveCard: () => 'active',
      closeResidualText: residual => `residual:${residual.taskId}`,
      closeRefusedText: (error, taskId) => `refused:${error}:${taskId}`,
      resumeRefusedText: error => error,
      now: () => 10,
    });
    const input = control();
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'closed' },
      controls: [{
        action: 'close',
        result: {
          residual: { reason: 'mojo_lineage_quarantined', taskId: 'remote-9' },
          noticeText: 'residual:remote-9',
        },
      }],
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_notice_${digest}`))!))
      .toMatchObject({
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        content: 'residual:remote-9',
      });
    expect(await store.readOutbox(`control_update_${digest}`)).toBeUndefined();
    await facade.stop();
    await store.close();
  });

  it('durably reports a close refusal while preserving the active Session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-refused-close-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = session();
    const active = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      streamCardId: 'om_card',
    } as DaemonSession;
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [active],
      findActiveSession: () => active,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      canOperate: () => true,
      closeSession: async () => ({
        ok: false,
        error: 'remote_cancel_unverified',
        taskId: 'remote-9',
      }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'must-not-render-ordinary-closed',
      buildActiveCard: () => 'active',
      closeResidualText: residual => `residual:${residual.taskId}`,
      closeRefusedText: (error, taskId) => `refused:${error}:${taskId}`,
      resumeRefusedText: error => error,
      now: () => 10,
    });
    const input = control();
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    const canonical = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(canonical!)).toMatchObject({
      session: { status: 'active' },
      controls: [{
        action: 'close',
        result: {
          applied: false,
          error: 'remote_cancel_unverified',
          taskId: 'remote-9',
          noticeText: 'refused:remote_cancel_unverified:remote-9',
        },
      }],
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_notice_${digest}`))!))
      .toMatchObject({
        target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
        content: 'refused:remote_cancel_unverified:remote-9',
      });
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({
        target: { kind: 'update', messageId: 'om_card' },
        content: 'active',
      });
    await facade.stop();
    await store.close();
  });

  it.each([
    'workspace_retired',
    'deferred_unmaterialized',
    'not_found',
    'not_closed',
    'resume_cancelled',
  ])('settles deterministic resume refusal %s without retrying the control operation', async error => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-deterministic-refusal-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'session-owner' });
    const persisted = session({ status: 'closed', closedAt: '2026-10-09T00:01:00.000Z' });
    await admitDurableLarkSession({ facade, message: message(), session: persisted });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [persisted],
      getPersistedSession: () => persisted,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not active' }),
      resumeSession: async () => ({ ok: false, error }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: residual => `residual:${residual.taskId}`,
      closeRefusedText: (closeError, taskId) => `refused:${closeError}:${taskId}`,
      resumeRefusedText: resumeError => `resume-refused:${resumeError}`,
      now: () => 10,
    });
    const input = control('resume');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(await store.readControlOperation(input.control.operationId)).toMatchObject({
      state: 'completed',
      attempts: 1,
      result: { applied: false, error },
    });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_notice_${digest}`))!))
      .toMatchObject({ content: `resume-refused:${error}` });
    await facade.stop();
    await store.close();
  });

  it('takes over a non-local active Session before applying close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-non-local-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    let persisted: Session | undefined;
    let active: DaemonSession | undefined;
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: session() });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'takeover-owner' });
    const takeOverActiveSession = vi.fn(async (_sessionKey: string, canonical: Session) => {
      persisted = structuredClone(canonical);
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
      } as DaemonSession;
      return persisted;
    });
    const closeSession = vi.fn(async () => {
      persisted = { ...persisted!, status: 'closed', closedAt: '2026-10-09T00:02:00.000Z' };
      active = undefined;
      return { ok: true as const, outcome: 'closed' as const, alreadyClosed: false };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      canOperate: () => true,
      closeSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });

    const input = control('close');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });
    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(takeOverActiveSession).toHaveBeenCalledWith(
      'om_root::cli_test',
      expect.objectContaining({ sessionId: 'session-1', status: 'active' }),
    );
    expect(closeSession).toHaveBeenCalledWith('session-1');
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({ session: { status: 'closed' } });
    await facade.stop();
    await store.close();
  });

  it('uses close-control mode when taking over a non-local Remote Runner for close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-remote-close-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    const canonical = session({
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'tae-traex',
        generation: 1,
        remoteSessionId: 'remote-session-1',
        providerState: {
          sessionKey: 'bmx1-' + 'a'.repeat(40),
          runtimeSubpath: 'clusters/default/sessions/bmx1-' + 'a'.repeat(40),
        },
      },
    });
    let persisted: Session | undefined;
    let active: DaemonSession | undefined;
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'takeover-owner' });
    const takeOverActiveSession = vi.fn(async (_sessionKey: string, session: Session) => {
      persisted = structuredClone(session);
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
      } as DaemonSession;
      return persisted;
    });
    const closeSession = vi.fn(async () => {
      persisted = { ...persisted!, status: 'closed', closedAt: '2026-10-09T00:02:00.000Z' };
      active = undefined;
      return { ok: true as const, outcome: 'closed' as const, alreadyClosed: false };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      canOperate: () => true,
      closeSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });

    const input = directControl('trusted-host', 'close');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });
    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(takeOverActiveSession).toHaveBeenCalledWith(
      'om_root::cli_test',
      expect.objectContaining({ sessionId: 'session-1', status: 'active' }),
      { remoteResumeMode: 'close-control' },
    );
    expect(closeSession).toHaveBeenCalledWith('session-1');
    await facade.stop();
    await store.close();
  });

  it('terminalizes a submitted canonical orphan only after provider missing proof', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-orphan-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    const canonical = session({
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'reference',
        generation: 2,
        remoteSessionId: 'remote-expired',
        agentThreadId: 'thread-existing',
        providerState: { sessionKey: 'logical-session' },
      },
    });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'orphan-owner' });
    let persisted: Session | undefined;
    let active: DaemonSession | undefined;
    const takeOverActiveSession = vi.fn(async (_key: string, value: Session) => {
      persisted = {
        ...structuredClone(value),
        remoteBackendState: {
          ...value.remoteBackendState!,
          generation: value.remoteBackendState!.generation + 1,
          remoteSessionId: undefined,
        },
      };
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
        worker: { killed: false },
        workerReady: true,
        initConfig: { remoteResumeMode: 'orphan-reconcile' },
      } as unknown as DaemonSession;
      return { session: persisted, owner: active };
    });
    const terminalizeOrphanSession = vi.fn(async () => {
      persisted = { ...persisted!, status: 'closed', closedAt: '2026-10-23T00:01:00.000Z' };
      active = undefined;
      return { ok: true as const, outcome: 'closed' as const, alreadyClosed: false };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      canOperate: () => false,
      closeSession: async () => ({ ok: false, error: 'ordinary close must not run' }),
      terminalizeOrphanSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      isResumeReady: ds => !!ds.worker && !ds.worker.killed && ds.workerReady === true,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      buildOrphanedCard: () => '{"orphan":"terminal"}',
      orphanedNoticeText: () => 'orphan terminalized',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = directControl('trusted-host', 'terminalize_orphan');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(takeOverActiveSession).toHaveBeenCalledWith(
      'om_root::cli_test',
      expect.objectContaining({ sessionId: 'session-1', status: 'active' }),
      { remoteResumeMode: 'orphan-reconcile' },
    );
    expect(terminalizeOrphanSession).toHaveBeenCalledWith('session-1');
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({
        session: { status: 'closed', remoteBackendState: { generation: 3 } },
        controls: [{
          source: 'trusted-host',
          action: 'terminalize_orphan',
          operationId: input.control.operationId,
        }],
      });
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(parseDurableLarkOutboxRecord((await store.readOutbox(`control_update_${digest}`))!))
      .toMatchObject({
        content: '{"orphan":"terminal"}',
        terminalUpdateFallback: {
          target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
          providerUuid: `bcf_${digest.slice(0, 40)}`,
        },
      });
    await facade.stop();
    await store.close();
  });

  it('settles an orphan control pinned to an older remote generation without proof', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-orphan-generation-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    await admitDurableLarkSession({
      facade: setupFacade,
      message: message(),
      session: session({
        cliId: 'remote-runner',
        backendType: 'remote-runner',
        remoteBackendState: {
          version: 1,
          provider: 'reference',
          generation: 2,
          remoteSessionId: 'remote-live',
          providerState: { sessionKey: 'logical-session' },
        },
      }),
    });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'orphan-owner' });
    const takeOverActiveSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      canOperate: () => false,
      closeSession: async () => ({ ok: false, error: 'not called' }),
      resumeSession: async () => ({ ok: false, error: 'not called' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const revision = (await store.readSession('om_root::cli_test'))!.revision;
    const resolveWith = async (operationId: string) => {
      const input = directControl('trusted-host', 'terminalize_orphan');
      const event = { ...input.claim.event, eventId: operationId, payload: {
        ...(input.claim.event.payload as Record<string, unknown>),
        operationId,
      } };
      const claim = { ...input.claim, event } as typeof input.claim;
      return runtime.resolve(parseDurableSessionControlClaim(claim), {
        claim,
        signal: new AbortController().signal,
      });
    };

    await expect(resolveWith('trusted-host.remote-orphan:cli_test:session-1:1'))
      .resolves.toMatchObject({
        kind: 'ignored',
        reason: 'canonical remote generation advanced since the orphan scan',
        settleExistingOperation: expect.any(Object),
      });
    await expect(resolveWith(`trusted-host.remote-orphan:cli_test:session-1:2:r${revision + 1}`))
      .resolves.toMatchObject({
        kind: 'ignored',
        reason: 'canonical Session changed since the orphan scan',
      });
    await expect(resolveWith(`trusted-host.remote-orphan:cli_test:session-1:2:r${revision}`))
      .resolves.toMatchObject({ kind: 'target' });
    await expect(resolveWith('trusted-host.remote-orphan:cli_test:session-1:2'))
      .resolves.toMatchObject({ kind: 'target' });
    expect(takeOverActiveSession).not.toHaveBeenCalled();
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!).session)
      .toMatchObject({ status: 'active' });
    await facade.stop();
    await store.close();
  });

  it('settles an orphan control without closing when the provider proves the Session is not an orphan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-orphan-verdict-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    const canonical = session({
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'reference',
        generation: 2,
        remoteSessionId: 'remote-paused',
        providerState: { sessionKey: 'logical-session' },
      },
    });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'orphan-owner' });
    let active: DaemonSession | undefined;
    const takeOverActiveSession = vi.fn(async (_key: string, value: Session) => {
      active = {
        session: structuredClone(value),
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
        worker: { killed: false },
        workerReady: true,
        initConfig: { remoteResumeMode: 'orphan-reconcile' },
        remoteOrphanVerdict: { verdict: 'not_orphan', reason: 'remote_resumable' },
      } as unknown as DaemonSession;
      return { session: active.session, owner: active };
    });
    const abandonOrphanTakeover = vi.fn(async () => { active = undefined; });
    const terminalizeOrphanSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      abandonOrphanTakeover,
      canOperate: () => false,
      closeSession: async () => ({ ok: false, error: 'ordinary close must not run' }),
      terminalizeOrphanSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      isResumeReady: ds => !!ds.worker && !ds.worker.killed && ds.workerReady === true,
      orphanReconciliationVerdict: ds => ds.remoteOrphanVerdict,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      buildOrphanedCard: () => '{"orphan":"terminal"}',
      orphanedNoticeText: () => 'orphan terminalized',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    // A control enqueued by an older daemon (legacy id) settles the same way.
    const input = directControl('trusted-host', 'terminalize_orphan');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(abandonOrphanTakeover).toHaveBeenCalledTimes(1);
    expect(terminalizeOrphanSession).not.toHaveBeenCalled();
    expect(await store.readControlOperation(input.control.operationId)).toMatchObject({
      state: 'completed',
      result: { status: 'active', applied: false, ignored: true, reason: 'not_orphan:remote_resumable' },
    });
    const after = parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!);
    expect(after.session).toMatchObject({
      status: 'active',
      remoteBackendState: { generation: 2, remoteSessionId: 'remote-paused' },
    });
    expect(after.controls ?? []).toEqual([]);
    const digest = createHash('sha256').update(input.control.operationId).digest('hex');
    expect(await store.readOutbox(`control_update_${digest}`)).toBeUndefined();
    await facade.stop();
    await store.close();
  });

  it('retires an orphan control from a stale scan epoch without another proof', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-orphan-epoch-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    await admitDurableLarkSession({
      facade: setupFacade,
      message: message(),
      session: session({
        cliId: 'remote-runner',
        backendType: 'remote-runner',
        remoteBackendState: {
          version: 1,
          provider: 'reference',
          generation: 2,
          remoteSessionId: 'remote-live',
          providerState: { sessionKey: 'logical-session' },
        },
      }),
    });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'orphan-owner' });
    const takeOverActiveSession = vi.fn();
    const epochMs = DURABLE_REMOTE_ORPHAN_RESCAN_EPOCH_MS;
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      canOperate: () => false,
      closeSession: async () => ({ ok: false, error: 'not called' }),
      resumeSession: async () => ({ ok: false, error: 'not called' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
      now: () => 5 * epochMs + 1,
    });
    const revision = (await store.readSession('om_root::cli_test'))!.revision;
    const resolveWith = async (epoch: number) => {
      const operationId = `trusted-host.remote-orphan:cli_test:session-1:2:r${revision}:e${epoch}`;
      const input = directControl('trusted-host', 'terminalize_orphan');
      const event = { ...input.claim.event, eventId: operationId, payload: {
        ...(input.claim.event.payload as Record<string, unknown>),
        operationId,
      } };
      const claim = { ...input.claim, event } as typeof input.claim;
      return runtime.resolve(parseDurableSessionControlClaim(claim), {
        claim,
        signal: new AbortController().signal,
      });
    };

    await expect(resolveWith(3)).resolves.toMatchObject({
      kind: 'ignored',
      reason: 'orphan control was superseded by a newer scan',
    });
    await expect(resolveWith(4)).resolves.toMatchObject({ kind: 'target' });
    await expect(resolveWith(5)).resolves.toMatchObject({ kind: 'target' });
    expect(takeOverActiveSession).not.toHaveBeenCalled();
    await facade.stop();
    await store.close();
  });

  it('retires a stranded recovered-turn owner before obtaining fresh missing proof', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-stranded-owner-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    const canonical = session({
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      lastFailedTurn: {
        turnId: 'om_recovered',
        userPrompt: 'original prompt',
        cliInput: 'original input',
        failedAt: '2026-10-23T00:01:00.000Z',
        errorCode: 'provider_takeover_failed',
        status: 'ambiguous',
        retryCount: 0,
        recoveredRemoteTurn: true,
      },
      remoteBackendState: {
        version: 1,
        provider: 'reference',
        generation: 2,
        remoteSessionId: 'remote-expired',
      },
    });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'orphan-owner' });
    let persisted: Session = structuredClone(canonical);
    let active: DaemonSession | undefined = {
      session: persisted,
      larkAppId: 'cli_test',
      chatId: 'oc_chat',
      worker: { killed: false },
      workerReady: true,
    } as unknown as DaemonSession;
    const abandonOrphanTakeover = vi.fn(() => {
      active = undefined;
      persisted = { ...persisted, status: 'closed' };
    });
    const takeOverActiveSession = vi.fn(async (_key: string, value: Session) => {
      persisted = {
        ...structuredClone(value),
        remoteBackendState: {
          ...value.remoteBackendState!,
          generation: value.remoteBackendState!.generation + 1,
          remoteSessionId: undefined,
        },
      };
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        worker: { killed: false },
        workerReady: true,
        initConfig: { remoteResumeMode: 'orphan-reconcile' },
      } as unknown as DaemonSession;
      return { session: persisted, owner: active };
    });
    const terminalizeOrphanSession = vi.fn(async () => {
      persisted.status = 'closed';
      active!.session.status = 'closed';
      return { ok: true };
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test', privateCard: false, store, facade: () => facade,
      listActiveSessions: () => active ? [active] : [], findActiveSession: () => active,
      listPersistedSessions: () => [persisted], getPersistedSession: () => persisted,
      materializeClosedSession: value => value, takeOverActiveSession, abandonOrphanTakeover,
      canOperate: () => false, closeSession: async () => ({ ok: false, error: 'not called' }),
      terminalizeOrphanSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      isResumeReady: ds => ds.workerReady === true,
      buildClosedCard: () => 'closed', buildActiveCard: () => 'active',
      buildOrphanedCard: () => '{"orphan":"terminal"}',
      closeResidualText: () => 'residual', closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = directControl('trusted-host', 'terminalize_orphan');
    const dispatch = createDurableSessionControlDispatch({
      store, sessionOwnerId: facade.ownerId, resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(abandonOrphanTakeover).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(takeOverActiveSession).toHaveBeenCalledWith(
      'om_root::cli_test',
      expect.objectContaining({ sessionId: 'session-1', status: 'active' }),
      { remoteResumeMode: 'orphan-reconcile' },
    );
    expect(terminalizeOrphanSession).toHaveBeenCalledExactlyOnceWith('session-1');
    await facade.stop();
    await store.close();
  });

  it('re-attaches instead of releasing when the provider still owns an in-flight turn', async () => {
    // #55：证明「不是孤儿」后直接放手，进行中的轮次就没人接续，卡片一直停在「工作中」。
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-orphan-turn-inflight-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    const canonical = session({
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'reference',
        generation: 2,
        remoteSessionId: 'remote-running',
        providerState: { sessionKey: 'logical-session' },
      },
    });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'orphan-owner' });
    let active: DaemonSession | undefined;
    let persisted: Session | undefined;
    const takeOverActiveSession = vi.fn(async (
      _key: string,
      value: Session,
      options?: { remoteResumeMode?: string },
    ) => {
      active = {
        session: structuredClone(value),
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
        worker: { killed: false },
        workerReady: true,
        initConfig: { remoteResumeMode: options?.remoteResumeMode },
        ...(options?.remoteResumeMode === 'orphan-reconcile'
          ? { remoteOrphanVerdict: { verdict: 'not_orphan', reason: 'remote_turn_inflight' } }
          : {}),
      } as unknown as DaemonSession;
      persisted = structuredClone(value);
      return { session: active.session, owner: active };
    });
    const abandonOrphanTakeover = vi.fn(async () => {
      active = undefined;
      persisted = undefined;
    });
    const terminalizeOrphanSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      abandonOrphanTakeover,
      canOperate: () => false,
      closeSession: async () => ({ ok: false, error: 'ordinary close must not run' }),
      terminalizeOrphanSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      isResumeReady: ds => !!ds.worker && !ds.worker.killed && ds.workerReady === true,
      orphanReconciliationVerdict: ds => ds.remoteOrphanVerdict,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      buildOrphanedCard: () => '{"orphan":"terminal"}',
      orphanedNoticeText: () => 'orphan terminalized',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = directControl('trusted-host', 'terminalize_orphan');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(abandonOrphanTakeover).toHaveBeenCalledTimes(1);
    expect(takeOverActiveSession.mock.calls.map(call => call[2]?.remoteResumeMode))
      .toEqual(['orphan-reconcile', 'reattach']);
    expect(active?.initConfig?.remoteResumeMode).toBe('reattach');
    expect(terminalizeOrphanSession).not.toHaveBeenCalled();
    expect(await store.readControlOperation(input.control.operationId)).toMatchObject({
      state: 'completed',
      result: {
        status: 'active',
        applied: false,
        ignored: true,
        reason: 'not_orphan:remote_turn_inflight',
        recovery: 'reattached',
      },
    });
    const after = parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!);
    expect(after.session).toMatchObject({
      status: 'active',
      remoteBackendState: { generation: 2, remoteSessionId: 'remote-running' },
    });
    await facade.stop();
    await store.close();
  });

  it('rejects a same-session replacement as orphan proof for another owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-orphan-owner-race-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    const canonical = session({
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'reference',
        generation: 2,
        remoteSessionId: 'remote-expired',
      },
    });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'orphan-owner' });
    const proofOwner = {
      session: {
        ...structuredClone(canonical),
        remoteBackendState: {
          ...canonical.remoteBackendState!,
          generation: 3,
          remoteSessionId: undefined,
        },
      },
      larkAppId: 'cli_test', chatId: 'oc_chat', worker: { killed: false }, workerReady: false,
      initConfig: { remoteResumeMode: 'orphan-reconcile' },
    } as unknown as DaemonSession;
    const replacement = {
      session: structuredClone(canonical),
      larkAppId: 'cli_test', chatId: 'oc_chat', worker: { killed: false }, workerReady: true,
      initConfig: { remoteResumeMode: 'reattach' },
    } as unknown as DaemonSession;
    const abandonOrphanTakeover = vi.fn();
    const terminalizeOrphanSession = vi.fn(async () => ({ ok: true as const }));
    let activeLookups = 0;
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test', privateCard: false, store, facade: () => facade,
      listActiveSessions: () => [replacement],
      findActiveSession: () => (++activeLookups === 1 ? undefined : replacement),
      listPersistedSessions: () => [], getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      takeOverActiveSession: async () => ({ session: proofOwner.session, owner: proofOwner }),
      abandonOrphanTakeover,
      canOperate: () => false, closeSession: async () => ({ ok: false, error: 'not called' }),
      terminalizeOrphanSession,
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      isResumeReady: ds => ds.workerReady === true,
      buildClosedCard: () => 'closed', buildActiveCard: () => 'active',
      closeResidualText: () => 'residual', closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = directControl('trusted-host', 'terminalize_orphan');
    const resolved = await runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    });
    if (resolved.kind !== 'target') throw new Error('expected orphan target');

    await expect(resolved.target.execute(new AbortController().signal)).resolves.toEqual({
      kind: 'not_applied',
      error: 'orphan reconciliation owner changed before proof completed',
    });
    expect(abandonOrphanTakeover).toHaveBeenCalledExactlyOnceWith('session-1', proofOwner);
    expect(terminalizeOrphanSession).not.toHaveBeenCalled();
    await facade.stop();
    await store.close();
  });

  it('leaves an unproven orphan active without committing a lifecycle result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-orphan-refused-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    const canonical = session({
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'reference',
        generation: 2,
        remoteSessionId: 'remote-live-or-unknown',
      },
    });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'orphan-owner' });
    const takeOverActiveSession = vi.fn(async () => {
      throw new Error('provider refused or could not prove missing');
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test', privateCard: false, store, facade: () => facade,
      listActiveSessions: () => [], findActiveSession: () => undefined,
      listPersistedSessions: () => [], getPersistedSession: () => undefined,
      materializeClosedSession: value => value, takeOverActiveSession,
      canOperate: () => false, closeSession: async () => ({ ok: false, error: 'not called' }),
      terminalizeOrphanSession: async () => ({ ok: false, error: 'not called' }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed', buildActiveCard: () => 'active',
      closeResidualText: () => 'residual', closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = directControl('trusted-host', 'terminalize_orphan');
    const dispatch = createDurableSessionControlDispatch({
      store, sessionOwnerId: facade.ownerId, resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).rejects.toThrow(/provider refused/);
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({ session: { status: 'active' }, controls: [] });
    await facade.stop();
    await store.close();
  });

  it('does not treat a locally abandoned row with live remote lineage as orphan proof', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-orphan-abandoned-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    const canonical = session({
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'reference',
        generation: 2,
        remoteSessionId: 'remote-live-or-unknown',
      },
    });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'orphan-owner' });
    let now = 0;
    let persisted: Session | undefined;
    let active: DaemonSession | undefined;
    const takeOverActiveSession = vi.fn(async (_key: string, value: Session) => {
      persisted = structuredClone(value);
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        worker: { killed: false },
        workerReady: false,
        initConfig: { remoteResumeMode: 'orphan-reconcile' },
      } as unknown as DaemonSession;
      return { session: persisted, owner: active };
    });
    const abandonOrphanTakeover = vi.fn(() => {
      persisted = { ...persisted!, status: 'closed' };
      active = undefined;
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test', privateCard: false, store, facade: () => facade,
      listActiveSessions: () => active ? [active] : [], findActiveSession: () => active,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted, materializeClosedSession: value => value,
      takeOverActiveSession, abandonOrphanTakeover,
      canOperate: () => false, closeSession: async () => ({ ok: false, error: 'not called' }),
      terminalizeOrphanSession: async () => ({ ok: false, error: 'not called' }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      isResumeReady: ds => ds.workerReady === true,
      buildClosedCard: () => 'closed', buildActiveCard: () => 'active',
      closeResidualText: () => 'residual', closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
      resumeReadinessTimeoutMs: 100,
      resumeReadinessPollMs: 10,
      now: () => now,
      wait: async ms => { now += ms; },
    });
    const input = directControl('trusted-host', 'terminalize_orphan');
    const resolved = await runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    });
    if (resolved.kind !== 'target') throw new Error('expected orphan target');

    await expect(resolved.target.execute(new AbortController().signal)).resolves.toMatchObject({
      kind: 'not_applied',
    });
    expect(abandonOrphanTakeover).toHaveBeenCalledOnce();
    expect(persisted).toMatchObject({
      status: 'closed',
      remoteBackendState: { remoteSessionId: 'remote-live-or-unknown' },
    });
    await expect(resolved.target.execute(new AbortController().signal)).resolves.toMatchObject({
      kind: 'not_applied',
    });
    expect(takeOverActiveSession).toHaveBeenCalledTimes(2);
    await facade.stop();
    await store.close();
  });

  it('classifies an occupied active-session takeover as an owner handoff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-owner-handoff-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'setup-owner' });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: session() });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => setupFacade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      takeOverActiveSession: async () => ({
        kind: 'retry',
        reason: 'active Session lease is still owned by exact-owner',
      }),
      canOperate: () => true,
      closeSession: async () => ({ ok: true, outcome: 'closed' }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = control('close');

    await expect(runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DurableSessionControlOwnerHandoffError);
    await setupFacade.stop();
    await store.close();
  });

  it('requeues a handoff claimed by the retiring Session owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-retiring-handoff-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'retiring-owner' });
    const canonical = session({
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'tae-traex',
        generation: 1,
        remoteSessionId: 'remote-session-1',
        providerState: { sessionKey: 'bmx1-' + 'a'.repeat(40) },
      },
    });
    await admitDurableLarkSession({ facade, message: message(), session: canonical });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      takeOverActiveSession: vi.fn(),
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not_local' }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
      now: () => 10,
    });
    const input = directControl('trusted-host', 'handoff', facade.ownerId);

    await expect(runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DurableSessionControlOwnerHandoffError);
    await facade.stop();
    await store.close();
  });

  it('settles a stale trusted handoff so newer lifecycle controls can advance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-stale-handoff-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'peer-owner' });
    const canonical = session({
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'tae-traex',
        generation: 1,
        remoteSessionId: 'remote-session-1',
        providerState: { sessionKey: 'bmx1-' + 'a'.repeat(40) },
      },
    });
    await admitDurableLarkSession({ facade, message: message(), session: canonical });
    const takeOverActiveSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not_local' }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
      now: () => 300_003,
    });
    const input = directControl('trusted-host', 'handoff', 'retiring-owner');

    await expect(runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: 'ignored',
      reason: 'stale remote handoff exceeded its recovery horizon',
      settleExistingOperation: {
        result: {
          action: 'handoff',
          status: 'active',
          applied: false,
          ignored: true,
        },
        evidence: {
          source: 'canonical-session',
          action: 'handoff',
          status: 'active',
        },
      },
    });
    expect(takeOverActiveSession).not.toHaveBeenCalled();
    await facade.stop();
    await store.close();
  });

  it('settles a control whose canonical Session never appeared (Mew #109)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-missing-session-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'peer-owner' });
    let clock = 2 + 60_000;
    const takeOverActiveSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not_local' }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
      now: () => clock,
    });
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    for (const input of [directControl('trusted-host', 'handoff'), control('close')]) {
      clock = 2 + 60_000;
      // Admission may still be committing: keep retrying for a while.
      await expect(dispatch(input.control, {
        claim: input.claim,
        signal: new AbortController().signal,
      })).rejects.toThrow('canonical Session is unavailable');

      clock = 2 + 5 * 60_000;
      await expect(runtime.resolve(input.control, {
        claim: input.claim,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        kind: 'ignored',
        reason: 'canonical Session does not exist',
        settleExistingOperation: {
          result: { action: input.control.action, status: 'missing', applied: false, ignored: true },
        },
      });
      await expect(dispatch(input.control, {
        claim: input.claim,
        signal: new AbortController().signal,
      })).resolves.toEqual({ kind: 'ignored', reason: 'canonical Session does not exist' });
      expect(await store.readControlOperation(input.control.operationId)).toBeUndefined();
    }
    expect(takeOverActiveSession).not.toHaveBeenCalled();
    await facade.stop();
    await store.close();
  });

  it('terminally ignores a control for a Session replaced at the same root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-replaced-session-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const facade = createDurableSessionFacade({ store, ownerId: 'peer-owner' });
    const successor = session({
      sessionId: 'session-2',
      status: 'closed',
      closedAt: '2026-10-09T01:00:00.000Z',
    });
    await admitDurableLarkSession({ facade, message: message(), session: successor });
    const materializeClosedSession = vi.fn((value: Session) => value);
    const takeOverActiveSession = vi.fn();
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => [],
      findActiveSession: () => undefined,
      listPersistedSessions: () => [],
      getPersistedSession: () => undefined,
      materializeClosedSession,
      takeOverActiveSession,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not_local' }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
    });
    const input = directControl('trusted-host', 'handoff', 'retiring-owner');

    await expect(runtime.resolve(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: 'ignored',
      reason: 'canonical Session was replaced',
      settleExistingOperation: {
        result: {
          action: 'handoff',
          status: 'closed',
          applied: false,
          ignored: true,
        },
        evidence: {
          source: 'canonical-session',
          action: 'handoff',
          status: 'closed',
        },
      },
    });

    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });
    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'ignored',
      reason: 'canonical Session was replaced',
    });
    expect(await store.readControlOperation(input.control.operationId)).toBeUndefined();
    expect(materializeClosedSession).not.toHaveBeenCalled();
    expect(takeOverActiveSession).not.toHaveBeenCalled();
    await facade.stop();
    await store.close();
  });

  it('proactively reattaches a handed-off Remote Runner and settles after readiness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-control-runtime-peer-handoff-'));
    tempDirs.push(dir);
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 10 });
    const setupFacade = createDurableSessionFacade({ store, ownerId: 'retiring-owner' });
    const canonical = session({
      backendType: 'remote-runner',
      remoteBackendState: {
        version: 1,
        provider: 'tae-traex',
        generation: 1,
        remoteSessionId: 'remote-session-1',
        providerState: { sessionKey: 'bmx1-' + 'a'.repeat(40) },
      },
    });
    await admitDurableLarkSession({ facade: setupFacade, message: message(), session: canonical });
    await setupFacade.stop();
    const facade = createDurableSessionFacade({ store, ownerId: 'peer-owner' });
    let persisted: Session | undefined;
    let active: DaemonSession | undefined;
    const takeOverActiveSession = vi.fn(async (_sessionKey: string, value: Session) => {
      persisted = {
        ...structuredClone(value),
        remoteBackendState: {
          ...value.remoteBackendState!,
          generation: 2,
          remoteSessionId: 'remote-session-1',
        },
      };
      active = {
        session: persisted,
        larkAppId: 'cli_test',
        chatId: 'oc_chat',
        streamCardId: 'om_card',
        worker: { killed: false },
        workerReady: true,
        suppressRecoveryCard: true,
      } as unknown as DaemonSession;
      return persisted;
    });
    const runtime = createDurableLarkSessionControlRuntime({
      larkAppId: 'cli_test',
      privateCard: false,
      store,
      facade: () => facade,
      listActiveSessions: () => active ? [active] : [],
      findActiveSession: () => active,
      listPersistedSessions: () => persisted ? [persisted] : [],
      getPersistedSession: () => persisted,
      materializeClosedSession: value => value,
      takeOverActiveSession,
      canOperate: () => true,
      closeSession: async () => ({ ok: false, error: 'not_local' }),
      resumeSession: async () => ({ ok: false, error: 'not_closed' }),
      isResumeReady: ds => !!ds.worker && !ds.worker.killed && ds.workerReady === true,
      buildClosedCard: () => 'closed',
      buildActiveCard: () => 'active',
      closeResidualText: () => 'residual',
      closeRefusedText: () => 'refused',
      resumeRefusedText: () => 'resume-refused',
      resumeReadinessStabilityMs: 0,
      now: () => 10,
    });
    const input = directControl('trusted-host', 'handoff', 'retiring-owner');
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: facade.ownerId,
      resolve: runtime.resolve,
    });

    await expect(dispatch(input.control, {
      claim: input.claim,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'settled' });
    expect(takeOverActiveSession).toHaveBeenCalledWith(
      'om_root::cli_test',
      expect.objectContaining({ sessionId: 'session-1', status: 'active' }),
      { remoteResumeMode: 'reattach' },
    );
    expect(active?.suppressRecoveryCard).toBeUndefined();
    expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!))
      .toMatchObject({
        session: {
          status: 'active',
          remoteBackendState: { generation: 2, remoteSessionId: 'remote-session-1' },
        },
        controls: [{
          source: 'trusted-host',
          action: 'handoff',
          operationId: input.control.operationId,
        }],
      });
    await facade.stop();
    await store.close();
  });
});
