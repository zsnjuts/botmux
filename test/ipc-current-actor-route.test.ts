import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/identity-cache.js', () => ({
  resolveVerifiedUserIdentity: vi.fn(async (_app: string, openId: string) => ({
    openId, type: 'user', email: 'current.user@example.com',
  })),
}));

import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import * as workerPool from '../src/core/worker-pool.js';

let ipc: IpcServerHandle | null = null;

afterEach(async () => {
  if (ipc) await ipc.close();
  ipc = null;
  vi.restoreAllMocks();
});

function activeSession(): any {
  return {
    session: {
      sessionId: 's-actor',
      status: 'active',
      workerGeneration: 7,
      ownerOpenId: 'ou_controller',
      ownerUnionId: 'on_controller',
    },
    chatId: 'oc_chat',
    larkAppId: 'cli_app',
    workerGeneration: 7,
    ownerOpenId: 'ou_controller',
    worker: { pid: process.pid, killed: false },
    localProcessAttestation: {
      backendType: 'pty',
      credentialIsolated: false,
      cliPid: process.pid,
      cliProcStart: readProcessStartIdentity(process.pid),
      workerGeneration: 7,
    },
    managedTurnOrigin: {
      capability: 'ca'.repeat(32),
      turnId: 'om_turn',
      callerOpenId: 'ou_current',
      preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`],
    },
    activeInteractiveTurn: {
      turnId: 'om_turn',
      caller: {
        requestUserOpenId: 'ou_current',
        requestLarkAppId: 'cli_app',
        senderType: 'user',
      },
      controller: {
        requestUserOpenId: 'ou_controller',
        requestUserUnionId: 'on_controller',
        requestLarkAppId: 'cli_app',
        senderType: 'user',
      },
    },
    initConfig: { apiOnly: false },
  };
}

const SCHEDULED_TURN_ID = 'schedule:abcdef12:12345678-1234-1234-1234-123456789abc';

describe('POST /api/current-actor', () => {
  it.skipIf(process.platform !== 'linux')('returns only the daemon-resolved actor for a live CLI descendant', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(activeSession());
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const response = await fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-actor', callerOpenId: 'ou_forged' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: 'botmux.current-actor.v2',
      status: 'verified',
      actor: { email: 'current.user@example.com' },
    });
  });

  it('fails closed when daemon live-turn state has no human caller', async () => {
    const ds = activeSession();
    delete ds.managedTurnOrigin.callerOpenId;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const response = await fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-actor' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      schema: 'botmux.current-actor.v2',
      status: 'blocked',
      error: 'current_actor_unverified',
    });
  });

  it.skipIf(process.platform !== 'linux')('binds an expected scheduled turn to daemon liveness', async () => {
    const ds = activeSession();
    ds.managedTurnOrigin.turnId = SCHEDULED_TURN_ID;
    ds.scheduledTurnCallers = new Map([[SCHEDULED_TURN_ID, {
      requestUserOpenId: 'ou_current',
      requestLarkAppId: 'cli_app',
      source: 'schedule_creator',
      taskId: 'abcdef12',
    }]]);
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

    const accepted = await fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's-actor', expectedScheduledTurnId: SCHEDULED_TURN_ID,
      }),
    });
    expect(accepted.status).toBe(200);

    ds.scheduledTurnCallers = undefined;
    const rejected = await fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's-actor', expectedScheduledTurnId: SCHEDULED_TURN_ID,
      }),
    });
    expect(rejected.status).toBe(403);
  });
});

describe('POST /api/controller-bound-schedule-authority', () => {
  it.skipIf(process.platform !== 'linux')('returns caller plus stable controller only to the exact live turn process', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(activeSession());
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const response = await fetch(
      `http://127.0.0.1:${ipc.port}/api/controller-bound-schedule-authority`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-actor' }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: 'botmux.controller-bound-schedule-authority.v1',
      status: 'verified',
      authority: {
        sessionId: 's-actor',
        turnId: 'om_turn',
        workerGeneration: 7,
        larkAppId: 'cli_app',
        callerOpenId: 'ou_current',
        controllerOpenId: 'ou_controller',
        controllerUnionId: 'on_controller',
      },
    });
  });

  it.skipIf(process.platform !== 'linux')('fails closed when the active authority controller differs from the stable owner', async () => {
    const ds = activeSession();
    ds.activeInteractiveTurn.controller.requestUserOpenId = 'ou_other';
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const response = await fetch(
      `http://127.0.0.1:${ipc.port}/api/controller-bound-schedule-authority`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-actor' }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      status: 'blocked',
      error: 'controller_bound_schedule_authority_unverified',
    });
  });
});
