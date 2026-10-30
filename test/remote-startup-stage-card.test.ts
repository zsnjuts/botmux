/**
 * Daemon side of the Remote Runner startup stage (Mew #74 F1): the worker relays
 * the provider's startup_progress, and the live card must say 「启动中 · 正在创建沙箱」
 * instead of 「工作中」 until the provider acknowledged the turn (busy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn(), reply: vi.fn(), patch: vi.fn(), upload: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {
  request = mocks.request;
  im = { v1: {
    message: { create: mocks.create, reply: mocks.reply, patch: mocks.patch },
    file: { create: mocks.upload },
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) },
  } };
} }));
import {
  initWorkerPool, setActiveSessionsRegistry, getActiveSessionsRegistry, streamCardLabel,
  __testOnly_setupWorkerHandlers as setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_activeSessions as activeSessions, __testOnly_sessionReply as sessionReply } from '../src/daemon.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';

const APP = 'cli_remote_startup_stage_card';
const oldDataDir = config.session.dataDir;
const originalRegistry = getActiveSessionsRegistry();
let home: string;
let ds: DaemonSession;
let worker: EventEmitter & { killed: boolean };

beforeEach(() => {
  vi.clearAllMocks(); __testOnly_resetLarkGate();
  vi.stubEnv('BOTMUX_LARK_QPS', '100000');
  vi.stubEnv('BOTMUX_LARK_GATE_RETRY_BASE_MS', '1');
  home = mkdtempSync(join(tmpdir(), 'remote-startup-stage-card-'));
  const data = join(home, 'data'); mkdirSync(data, { mode: 0o700 });
  config.session.dataDir = data;
  activeSessions.clear(); setActiveSessionsRegistry(activeSessions);
  registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', replyCardMode: 'legacy' });
  ds = { larkAppId: APP, chatId: 'oc_rs', scope: 'chat', chatType: 'group',
    currentReplyTarget: { turnId: 'om_turn', rootMessageId: 'om_root' },
    session: { sessionId: 'sid_rs', larkAppId: APP, chatId: 'oc_rs', scope: 'chat',
      rootMessageId: 'om_root', cliId: 'claude-code', status: 'active', title: 'rs', workingDir: data },
  } as unknown as DaemonSession;
  sessionStore.init(APP);
  const stored = sessionStore.createSession('oc_rs', 'om_root', 'rs', 'group', 'chat');
  ds.session = { ...stored, ...ds.session, sessionId: stored.sessionId };
  sessionStore.updateSession(ds.session);
  activeSessions.set(activeSessionKey(ds), ds);
  mocks.request.mockReset().mockResolvedValue({ code: 0, data: { items: [] } });
  mocks.patch.mockReset().mockResolvedValue({ code: 0 });
  initWorkerPool({ sessionReply, getSessionWorkingDir: () => data, getActiveCount: () => 1, closeSession: vi.fn() });
  // A live card for the current turn, so updates take the PATCH path.
  worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(), pid: 12345,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  ds.worker = worker as any;
  ds.workerReady = true;
  ds.displayMode = 'hidden';
  ds.lastScreenStatus = 'working';
  ds.streamCardId = 'om_card';
  ds.streamCardNonce = 'nonce';
  setupWorkerHandlers(ds, worker as any);
});
afterEach(() => {
  activeSessions.clear(); setActiveSessionsRegistry(originalRegistry);
  ds.session.status = 'closed';
  sessionStore.init(APP, { owner: false });
  config.session.dataDir = oldDataDir;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs(); __testOnly_resetLarkGate();
});

async function send(msg: Record<string, unknown>): Promise<void> {
  await worker.listeners('message')[0](msg);
  await vi.waitFor(() => expect(ds.cardPatchInFlight ?? false).toBe(false));
}

function patchedHeaders(): string[] {
  return mocks.patch.mock.calls.map(([request]) => JSON.parse(request.data.content).header.title.content as string);
}

describe('remote startup stage on the live card', () => {
  it('relabels a working card until the turn is accepted', async () => {
    ds.currentTurnId = 'om_turn';
    await send({ type: 'remote_startup_progress', stage: 'sandbox_create', turnId: 'om_turn' });
    expect(streamCardLabel(ds)).toEqual({ startupStage: 'sandbox_create' });
    expect(patchedHeaders().at(-1)).toContain('启动中 · 正在创建沙箱');

    // A screen refresh under working keeps the stage.
    await send({ type: 'screen_update', content: 'screen', status: 'working', turnId: 'om_turn' });
    expect(patchedHeaders().every(header => !header.includes('工作中'))).toBe(true);

    // Same stage again: nothing to redraw.
    const patches = mocks.patch.mock.calls.length;
    await send({ type: 'remote_startup_progress', stage: 'sandbox_create', turnId: 'om_turn' });
    expect(mocks.patch.mock.calls.length).toBe(patches);

    await send({ type: 'remote_startup_progress', stage: 'cli_start', turnId: 'om_turn' });
    expect(patchedHeaders().at(-1)).toContain('启动中 · 正在启动远端 CLI');

    await send({ type: 'remote_startup_progress', stage: null, turnId: 'om_turn' });
    expect(ds.remoteStartupStage).toBeUndefined();
    expect(patchedHeaders().at(-1)).toContain('工作中');
  });

  it('drops the stage once the turn leaves working, and ignores another turn', async () => {
    ds.currentTurnId = 'om_turn';
    await send({ type: 'remote_startup_progress', stage: 'tools_prepare', turnId: 'om_turn' });
    await send({ type: 'screen_update', content: 'screen', status: 'idle', turnId: 'om_turn' });
    expect(ds.remoteStartupStage).toBeUndefined();
    expect(patchedHeaders().at(-1)).toContain('等待输入');

    ds.lastScreenStatus = 'working';
    ds.remoteStartupStage = { stage: 'cli_start', turnId: 'om_previous' };
    expect(streamCardLabel(ds)).toBeUndefined();
  });

  it('ignores a stage from a replaced worker', async () => {
    const stale = Object.assign(new EventEmitter(), {
      killed: false, send: vi.fn(), kill: vi.fn(), pid: 12346,
      stdout: new EventEmitter(), stderr: new EventEmitter(),
    });
    setupWorkerHandlers(ds, stale as any);
    await stale.listeners('message')[0]({ type: 'remote_startup_progress', stage: 'sandbox_create', turnId: 'om_turn' });
    expect(ds.remoteStartupStage).toBeUndefined();
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
