/**
 * Mew #28: a Remote Runner worker whose main loop is stuck in a blocking
 * syscall answers no liveness ping. The daemon kills it after the timeout and
 * re-attaches a turn it was driving; an answering worker is never touched.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ resolvedAllowedUsers: [], config: {} })),
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: vi.fn(() => []),
  loadBotConfigs: vi.fn(),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/adapters/backend/mojo-backend.js', () => ({
  cancelMojoSessionById: vi.fn(async () => ({ kind: 'cancelled' as const })),
  MojoBackend: class {},
}));

vi.mock('../src/adapters/backend/riff-backend.js', () => ({
  hashUrlForLog: vi.fn(() => 'riffhash'),
  cancelRiffTaskById: vi.fn(async () => true),
  RiffBackend: class {},
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: vi.fn(),
  sendUserMessage: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getMessageChatId: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(async () => true),
  listChatPins: vi.fn(async () => []),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
  deleteFrozenCards: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  __testOnly_setWorkerLivenessReattach,
  __testOnly_setupWorkerHandlers,
  broadcastWorkerConfigSnapshot,
  checkWorkerLiveness,
  initWorkerPool,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

type FakeWorker = EventEmitter & {
  killed: boolean;
  pid: number;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};

let dataDir: string;
let previousDataDir: string;
const reattach = vi.fn(async (_ds: DaemonSession, _providerPid: number | undefined) => {});

function createFakeWorker(): FakeWorker {
  return Object.assign(new EventEmitter(), {
    killed: false,
    pid: 4242,
    send: vi.fn(),
    kill: vi.fn(),
  });
}

function createFixture(backendType: string = 'remote-runner'): { ds: DaemonSession; worker: FakeWorker } {
  sessionStore.init('app');
  const session = sessionStore.createSession('oc_live', 'om_live', 'liveness', 'group');
  session.larkAppId = 'app';
  session.scope = 'chat';
  session.backendType = backendType as never;
  sessionStore.updateSession(session);
  const worker = createFakeWorker();
  const ds = {
    larkAppId: 'app',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'chat',
    worker,
    workerReady: true,
    session,
    initConfig: { backendType },
    localProcessAttestation: { backendType, credentialIsolated: false, cliPid: 5151 },
  } as unknown as DaemonSession;
  __testOnly_setupWorkerHandlers(ds, worker as never);
  setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  return { ds, worker };
}

const pings = (worker: FakeWorker) =>
  worker.send.mock.calls.filter(([message]) => (message as { type: string }).type === 'liveness_ping').length;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-worker-liveness-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  reattach.mockClear();
  __testOnly_setWorkerLivenessReattach(reattach);
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

afterEach(() => {
  __testOnly_setWorkerLivenessReattach();
  setActiveSessionsRegistry(new Map());
  config.session.dataDir = previousDataDir;
  sessionStore.init('test-app');
  rmSync(dataDir, { recursive: true, force: true });
});

describe('worker liveness watchdog', () => {
  it('keeps a worker that answers its pings', () => {
    const { ds, worker } = createFixture();
    const t0 = 1_000_000;

    for (let t = t0; t <= t0 + 600_000; t += 30_000) {
      checkWorkerLiveness(t);
      worker.emit('message', { type: 'liveness_pong' });
    }

    expect(pings(worker)).toBeGreaterThan(10);
    expect(worker.kill).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
  });

  it('kills a silent idle worker after the timeout without re-attaching', () => {
    const { ds, worker } = createFixture();
    const t0 = 1_000_000;

    checkWorkerLiveness(t0);
    checkWorkerLiveness(t0 + 150_000);
    expect(worker.kill).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);

    checkWorkerLiveness(t0 + 180_000);

    expect(worker.kill).toHaveBeenCalledWith('SIGKILL');
    expect(ds.worker).toBeNull();
    expect(reattach).not.toHaveBeenCalled();
  });

  it('re-attaches the turn a silent worker was driving, naming its provider', () => {
    const { ds, worker } = createFixture();
    ds.lastScreenStatus = 'working';
    const t0 = 1_000_000;

    checkWorkerLiveness(t0);
    checkWorkerLiveness(t0 + 180_000);

    expect(worker.kill).toHaveBeenCalledWith('SIGKILL');
    expect(ds.worker).toBeNull();
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(reattach).toHaveBeenCalledWith(ds, 5151);
  });

  it('measures silence from the oldest unanswered ping, not the latest', () => {
    const { worker } = createFixture();
    const t0 = 1_000_000;

    checkWorkerLiveness(t0);
    worker.emit('message', { type: 'liveness_pong' });
    checkWorkerLiveness(t0 + 30_000);
    checkWorkerLiveness(t0 + 60_000);
    checkWorkerLiveness(t0 + 209_000);
    expect(worker.kill).not.toHaveBeenCalled();

    checkWorkerLiveness(t0 + 210_000);
    expect(worker.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('pushes the reloaded config to Remote Runner workers only', () => {
    const remote = createFixture();
    const local = createFixture('tmux');
    setActiveSessionsRegistry(new Map([
      ['remote', remote.ds],
      ['local', local.ds],
    ]));

    broadcastWorkerConfigSnapshot();

    const pushed = remote.worker.send.mock.calls.map(([message]) => message as { type: string });
    expect(pushed).toEqual([expect.objectContaining({
      type: 'config_snapshot',
      botConfigSnapshot: expect.any(Array),
      globalConfigSnapshot: expect.any(Object),
    })]);
    expect(local.worker.send).not.toHaveBeenCalled();
  });

  it('leaves local CLI workers alone', () => {
    const { ds, worker } = createFixture('tmux');

    checkWorkerLiveness(1_000_000);
    checkWorkerLiveness(2_000_000);

    expect(pings(worker)).toBe(0);
    expect(worker.kill).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
  });
});
