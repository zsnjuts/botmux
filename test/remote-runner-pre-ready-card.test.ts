/**
 * Remote Runner opening card before worker `ready`.
 *
 * A remote-runner worker reports `ready` only after the provider finished its
 * startup, so a new session's 「启动中」 card used to appear seconds late. The
 * opening card is now published right after the fork; `ready` and later status
 * edges keep updating that same card, and a startup failure marks it failed.
 * Other backends keep posting their first card from `ready`.
 *
 * Run:  npx vitest run --project unit test/remote-runner-pre-ready-card.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const updateMessageMock = vi.fn(async (..._args: any[]) => {});
const deleteMessageMock = vi.fn(async (..._args: any[]) => {});

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  class MessageUpdateExpiredError extends Error {}
  return {
    updateMessage: (...args: any[]) => updateMessageMock(...args),
    deleteMessage: (...args: any[]) => deleteMessageMock(...args),
    pinMessage: vi.fn(async () => undefined),
    unpinMessage: vi.fn(async () => true),
    listChatPins: vi.fn(async () => []),
    MessageWithdrawnError,
    MessageUpdateExpiredError,
  };
});

// Expose the rendered state instead of the real card JSON: the tests assert
// which card is updated and with which status, not its layout.
vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn((...args: any[]) => JSON.stringify({
    readUrl: args[2],
    status: args[5],
    label: args[19] ?? null,
  })),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Remote Runner'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(),
  getAllBots: vi.fn(() => []),
  normalizeUsageDisplay: vi.fn(() => 'off'),
  getBotClient: vi.fn(() => ({ request: vi.fn() })),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions-pre-ready-card' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: vi.fn(),
  ensureSessionWhiteboard: vi.fn(),
  rememberLastCliInput: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: undefined })),
}));

vi.mock('../src/skills/installer.js', () => ({ ensureSkills: vi.fn() }));
vi.mock('../src/adapters/cli/registry.js', () => ({ createCliAdapterSync: vi.fn() }));
vi.mock('../src/adapters/cli/claude-code.js', () => ({ claudeJsonlPathForSession: vi.fn() }));
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({ TmuxBackend: class {} }));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  initWorkerPool,
  parkPreReadyStartingCard,
  postPreReadyStartingCard,
  setActiveSessionsRegistry,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { getBot } from '../src/bot-registry.js';

const getBotMock = getBot as ReturnType<typeof vi.fn>;
const OPEN_TURN = 'om_open_turn';

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.connected = true;
  w.send = vi.fn();
  w.kill = vi.fn();
  w.pid = 4242;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

function makeDs(worker: any, backendType: 'remote-runner' | 'tmux'): DaemonSession {
  const cliId = backendType === 'remote-runner' ? 'remote-runner' : 'claude-code';
  return {
    session: {
      sessionId: `sid-pre-ready-${backendType}`,
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'New topic',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId,
      backendType,
    },
    worker,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    displayMode: 'hidden',
    currentTurnTitle: 'New topic',
  } as DaemonSession;
}

function botConfig(cliId: string, extra: Record<string, unknown> = {}) {
  return {
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId, ...extra },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  };
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

/** Fork-time state of an opening turn: the worker has not reported ready. */
function setupOpening(backendType: 'remote-runner' | 'tmux') {
  const worker = makeFakeWorker();
  const ds = makeDs(worker, backendType);
  setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  __testOnly_setupWorkerHandlers(ds, worker, {
    ready: false,
    failureNotified: false,
    initTurnId: OPEN_TURN,
  });
  return { ds, worker };
}

function cardPosts(sessionReply: ReturnType<typeof vi.fn>) {
  return sessionReply.mock.calls.filter(call => call[2] === 'interactive');
}

function patchesOf(cardId: string) {
  return updateMessageMock.mock.calls
    .filter(call => call[1] === cardId)
    .map(call => JSON.parse(call[2] as string) as { readUrl: string; status: string; label: string | null });
}

describe('Remote Runner opening card before worker ready', () => {
  let sessionReplyMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getBotMock.mockReturnValue(botConfig('remote-runner'));
    sessionReplyMock = vi.fn(async (_anchor: string, _content: string, msgType?: string) =>
      msgType === 'interactive' ? 'om_card' : 'om_text');
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });

  it('posts the starting card before ready, and ready plus status edges update that same card', async () => {
    const { ds, worker } = setupOpening('remote-runner');

    await expect(postPreReadyStartingCard(ds)).resolves.toBe(true);
    expect(cardPosts(sessionReplyMock)).toHaveLength(1);
    expect(JSON.parse(cardPosts(sessionReplyMock)[0][1])).toMatchObject({ status: 'starting', readUrl: '' });
    expect(ds.streamCardId).toBe('om_card');

    worker.emit('message', { type: 'ready', port: 9999, token: 'tok', turnId: OPEN_TURN });
    await flush();
    // Ready re-renders the same card with the now-available terminal link.
    expect(cardPosts(sessionReplyMock)).toHaveLength(1);
    expect(patchesOf('om_card').at(-1)).toMatchObject({ status: 'starting' });
    expect(patchesOf('om_card').at(-1)?.readUrl).toBeTruthy();

    worker.emit('message', { type: 'screen_update', content: '', status: 'working', turnId: OPEN_TURN });
    await flush();
    expect(cardPosts(sessionReplyMock)).toHaveLength(1);
    expect(patchesOf('om_card').at(-1)).toMatchObject({ status: 'working' });
    expect(ds.streamCardId).toBe('om_card');
  });

  it('does not post a second card when the ready-time update of the card fails', async () => {
    const { ds, worker } = setupOpening('remote-runner');
    await postPreReadyStartingCard(ds);
    updateMessageMock.mockRejectedValueOnce(new Error('transient network error'));

    worker.emit('message', { type: 'ready', port: 9999, token: 'tok', turnId: OPEN_TURN });
    await flush();
    await flush();

    expect(cardPosts(sessionReplyMock)).toHaveLength(1);
    expect(ds.streamCardId).toBe('om_card');
    worker.emit('message', { type: 'screen_update', content: '', status: 'working', turnId: OPEN_TURN });
    await flush();
    expect(patchesOf('om_card').at(-1)).toMatchObject({ status: 'working' });
  });

  it('keeps one card when ready arrives while the starting card is still posting', async () => {
    const { ds, worker } = setupOpening('remote-runner');
    const post = deferred<string>();
    sessionReplyMock.mockImplementation(async (_a: string, _c: string, msgType?: string) =>
      msgType === 'interactive' ? post.promise : 'om_text');

    const published = postPreReadyStartingCard(ds);
    await flush();
    worker.emit('message', { type: 'ready', port: 9999, token: 'tok', turnId: OPEN_TURN });
    await flush();
    expect(cardPosts(sessionReplyMock)).toHaveLength(1);

    post.resolve('om_card');
    await expect(published).resolves.toBe(true);
    await flush();
    expect(cardPosts(sessionReplyMock)).toHaveLength(1);
    expect(ds.streamCardId).toBe('om_card');
    // The card that landed after ready is brought to the ready-time state.
    expect(patchesOf('om_card').at(-1)?.readUrl).toBeTruthy();
  });

  it('marks the same card failed when the runner fails to start', async () => {
    const { ds, worker } = setupOpening('remote-runner');
    await postPreReadyStartingCard(ds);

    worker.emit('message', {
      type: 'error', message: 'remote runner did not become ready', turnId: OPEN_TURN,
    });
    await flush();
    worker.emit('exit', 1, null);
    await flush();

    expect(cardPosts(sessionReplyMock)).toHaveLength(1);
    expect(patchesOf('om_card').at(-1)).toMatchObject({ status: 'idle', label: 'failed' });
    expect(ds.streamCardId).toBe('om_card');
  });

  it('marks the card failed when the runner fails while the card is still posting', async () => {
    const { ds, worker } = setupOpening('remote-runner');
    const post = deferred<string>();
    sessionReplyMock.mockImplementation(async (_a: string, _c: string, msgType?: string) =>
      msgType === 'interactive' ? post.promise : 'om_text');

    const published = postPreReadyStartingCard(ds);
    await flush();
    worker.emit('exit', 1, null);
    await flush();
    post.resolve('om_card');
    await published;
    await flush();

    expect(cardPosts(sessionReplyMock)).toHaveLength(1);
    expect(patchesOf('om_card').at(-1)).toMatchObject({ status: 'idle', label: 'failed' });
  });

  it('a turn started before ready withdraws the pre-ready card once its own card lands', async () => {
    const { ds, worker } = setupOpening('remote-runner');
    await postPreReadyStartingCard(ds);

    // beginNewTurn for a follow-up accepted by the not-yet-ready worker.
    parkPreReadyStartingCard(ds);
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_follow_up';
    ds.streamCardTurnGeneration = 1;
    sessionReplyMock.mockImplementation(async (_a: string, _c: string, msgType?: string) =>
      msgType === 'interactive' ? 'om_follow_card' : 'om_text');

    worker.emit('message', { type: 'ready', port: 9999, token: 'tok', turnId: OPEN_TURN });
    await flush();

    expect(ds.streamCardId).toBe('om_follow_card');
    expect(deleteMessageMock).toHaveBeenCalledWith('app_test', 'om_card');
  });

  it('a turn started while the pre-ready card is still posting also withdraws it', async () => {
    const { ds, worker } = setupOpening('remote-runner');
    const post = deferred<string>();
    sessionReplyMock.mockImplementation(async (_a: string, _c: string, msgType?: string) =>
      msgType === 'interactive' ? post.promise : 'om_text');

    const published = postPreReadyStartingCard(ds);
    await flush();
    // beginNewTurn while the opening card is in flight.
    parkPreReadyStartingCard(ds);
    ds.streamCardPending = true;
    ds.streamCardPendingTurnId = 'om_follow_up';
    ds.streamCardTurnGeneration = 1;
    post.resolve('om_card');
    await published;
    sessionReplyMock.mockImplementation(async (_a: string, _c: string, msgType?: string) =>
      msgType === 'interactive' ? 'om_follow_card' : 'om_text');

    worker.emit('message', { type: 'ready', port: 9999, token: 'tok', turnId: OPEN_TURN });
    await flush();

    expect(ds.streamCardId).toBe('om_follow_card');
    expect(deleteMessageMock).toHaveBeenCalledWith('app_test', 'om_card');
  });

  it('does not post early when the bot disabled the streaming card', async () => {
    getBotMock.mockReturnValue(botConfig('remote-runner', { disableStreamingCard: true }));
    const { ds, worker } = setupOpening('remote-runner');

    await expect(postPreReadyStartingCard(ds)).resolves.toBe(false);
    worker.emit('message', { type: 'ready', port: 9999, token: 'tok', turnId: OPEN_TURN });
    await flush();
    expect(cardPosts(sessionReplyMock)).toHaveLength(0);
  });

  it('leaves other backends posting their first card from ready', async () => {
    getBotMock.mockReturnValue(botConfig('claude-code'));
    const { ds, worker } = setupOpening('tmux');

    await expect(postPreReadyStartingCard(ds)).resolves.toBe(false);
    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(ds.streamCardId).toBeUndefined();

    worker.emit('message', { type: 'ready', port: 9999, token: 'tok', turnId: OPEN_TURN });
    await flush();
    expect(cardPosts(sessionReplyMock)).toHaveLength(1);
    expect(ds.streamCardId).toBe('om_card');
  });
});
