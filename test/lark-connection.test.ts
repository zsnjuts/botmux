import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Lark from '@larksuiteoapi/node-sdk';
import { getLarkConnectionHealth, startLarkConnection } from '../src/im/lark/transport/connection.js';
import { logger } from '../src/utils/logger.js';

let capturedWsClientOptions: Record<string, any> | undefined;
let createdWsClients: any[] = [];
let nextStartImplementation: (() => Promise<void>) | undefined;
vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockWSClient {
    constructor(options: Record<string, any>) {
      capturedWsClientOptions = options;
      createdWsClients.push(this);
    }
    start = vi.fn(() => nextStartImplementation?.() ?? Promise.resolve());
    close = vi.fn(() => {});
    getConnectionStatus = vi.fn(() => ({ state: 'connected', reconnectAttempts: 0 }));
  }
  return {
    EventDispatcher: class {},
    WSClient: MockWSClient,
    LoggerLevel: { info: 2, warn: 3 },
  };
});

// No registry, session, card, filesystem or PTY mocks: the connection accepts an
// already registered SDK dispatcher and needs no business bootstrap.
const eventDispatcher = new Lark.EventDispatcher({});
let tick: () => void;
let intervalMs: number | undefined;
const unref = vi.fn();

beforeEach(() => {
  capturedWsClientOptions = undefined;
  createdWsClients = [];
  nextStartImplementation = undefined;
  unref.mockClear();
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay) => {
    tick = () => callback();
    intervalMs = delay;
    // Only unref is used by the connection; probes are driven explicitly.
    return { unref } as unknown as NodeJS.Timeout;
  });
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Drain the start().catch().finally() chain without advancing any real timer.
async function probeRecovery(): Promise<void> {
  tick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('startLarkConnection — lifecycle', () => {
  it.each(['feishu', 'lark'] as const)('preserves %s connection options and passes the dispatcher unchanged', (brand) => {
    vi.stubEnv('DEBUG', '');
    const client = startLarkConnection('app-test', 'secret', eventDispatcher, brand);
    expect(client).toBeInstanceOf(Lark.WSClient);
    expect(capturedWsClientOptions).toMatchObject({
      appId: 'app-test',
      appSecret: 'secret',
      domain: brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
      loggerLevel: Lark.LoggerLevel.warn,
      wsConfig: { pingTimeout: 30 },
      handshakeTimeoutMs: 15_000,
    });
    expect(createdWsClients[0].start).toHaveBeenCalledExactlyOnceWith({ eventDispatcher });
    expect(intervalMs).toBe(60_000);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('defaults to Feishu, honors DEBUG and retains connection diagnostics', () => {
    vi.stubEnv('DEBUG', '1');
    const onReady = vi.fn();
    const onReconnecting = vi.fn();
    const onReconnected = vi.fn();
    startLarkConnection('app-test', 'secret', eventDispatcher, 'feishu', {
      onReady,
      onReconnecting,
      onReconnected,
    });
    expect(capturedWsClientOptions?.domain).toBe('https://open.feishu.cn');
    expect(capturedWsClientOptions?.loggerLevel).toBe(Lark.LoggerLevel.info);
    capturedWsClientOptions?.onReconnecting();
    capturedWsClientOptions?.onReady();
    capturedWsClientOptions?.onReconnected();
    capturedWsClientOptions?.onError(new Error('offline'));
    expect(logger.warn).toHaveBeenCalledWith('[ws] app-test reconnecting…');
    expect(onReconnecting).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith('[ws] app-test reconnected');
    expect(onReconnected).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^\[ws\] app-test connecting domain=https:\/\/open\.feishu\.cn proxy=.+ runtime=.+$/));
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/^\[ws\] app-test terminal error: offline \(proxy=.+ runtime=.+\)$/));
  });

  it.each(['connected', 'connecting', 'reconnecting', 'idle'] as const)('does not restart while the SDK is %s', async (state) => {
    startLarkConnection('app-test', 'secret', eventDispatcher);
    createdWsClients[0].getConnectionStatus.mockReturnValue({ state, reconnectAttempts: 0 });
    await probeRecovery();
    expect(createdWsClients).toHaveLength(1);
    expect(createdWsClients[0].start).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a failed client generation and does not overlap pending recovery', async () => {
    const onRestarting = vi.fn();
    startLarkConnection('app-test', 'secret', eventDispatcher, 'feishu', { onRestarting });
    const first = createdWsClients[0];
    first.getConnectionStatus.mockReturnValue({ state: 'failed', reconnectAttempts: 3 });
    let finish!: () => void;
    nextStartImplementation = () => new Promise<void>(resolve => { finish = resolve; });
    await probeRecovery();
    expect(createdWsClients).toHaveLength(2);
    const second = createdWsClients[1];
    expect(first.close).toHaveBeenCalledWith({ force: true });
    expect(second.start).toHaveBeenCalledExactlyOnceWith({ eventDispatcher });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[ws\] app-test connection failed \(proxy=.+ runtime=.+\), rebuilding WSClient generation$/));
    expect(onRestarting).toHaveBeenCalledOnce();
    await probeRecovery();
    expect(createdWsClients).toHaveLength(2);
    second.getConnectionStatus.mockReturnValue({ state: 'connected', reconnectAttempts: 0 });
    nextStartImplementation = undefined;
    finish();
    await probeRecovery();
    await probeRecovery();
    expect(createdWsClients).toHaveLength(2);
    // A later terminal failure can start a new recovery round.
    second.getConnectionStatus.mockReturnValue({ state: 'failed', reconnectAttempts: 3 });
    await probeRecovery();
    expect(createdWsClients).toHaveLength(3);
  });

  it('publishes health and rebuilds a ready client that falls back to idle', async () => {
    startLarkConnection('app-test', 'secret', eventDispatcher);
    capturedWsClientOptions?.onReady();
    const first = createdWsClients[0];
    first.getConnectionStatus.mockReturnValue({
      state: 'idle', reconnectAttempts: 0, lastConnectTime: 123,
    });
    await probeRecovery();
    expect(createdWsClients).toHaveLength(2);
    expect(first.close).toHaveBeenCalledWith({ force: true });
    expect(getLarkConnectionHealth('app-test')).toMatchObject({
      generation: 2,
      state: 'connected',
      reconnectAttempts: 0,
    });
  });

  it('removes health and stops recovery after an explicit close', async () => {
    const client = startLarkConnection('app-test', 'secret', eventDispatcher);
    expect(getLarkConnectionHealth('app-test')).toBeDefined();
    client.close({ force: true });
    expect(getLarkConnectionHealth('app-test')).toBeUndefined();
    createdWsClients[0].getConnectionStatus.mockReturnValue({ state: 'failed', reconnectAttempts: 3 });
    await probeRecovery();
    expect(createdWsClients).toHaveLength(1);
  });
});

const WS_PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'NPM_CONFIG_HTTPS_PROXY',
  'npm_config_https_proxy',
  'NPM_CONFIG_PROXY',
  'npm_config_proxy',
  'NPM_CONFIG_NO_PROXY',
  'npm_config_no_proxy',
] as const;

function withWsProxyEnv(values: Partial<Record<(typeof WS_PROXY_ENV_KEYS)[number], string>>, callback: () => void): void {
  const original = Object.fromEntries(
    WS_PROXY_ENV_KEYS.map(key => [key, process.env[key]]),
  );
  for (const key of WS_PROXY_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);

  try {
    callback();
  } finally {
    for (const key of WS_PROXY_ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('startLarkConnection — WebSocket proxy', () => {
  it('uses HTTPS proxy precedence for secure WebSocket URLs', () => {
    withWsProxyEnv({
      HTTPS_PROXY: 'http://upper-proxy:8118',
      https_proxy: 'http://lower-proxy:8118',
    }, () => {
      startLarkConnection('app-test', 'secret', eventDispatcher);

      const agent = capturedWsClientOptions?.agent;
      // Must be HttpsProxyAgent, not ProxyAgent: Bun's built-in ws reads the
      // proxy URL off `agent.proxy` (the HttpsProxyAgent shape) and silently
      // ignores a ProxyAgent, so an http proxy has to arrive as HttpsProxyAgent
      // for both runtimes. proxy-from-env prefers the lowercase https_proxy.
      expect(agent?.constructor?.name).toBe('HttpsProxyAgent');
      expect((agent as { proxy?: URL })?.proxy?.href).toBe('http://lower-proxy:8118/');
    });
  });

  it('honors NO_PROXY for the WebSocket destination', () => {
    withWsProxyEnv({
      HTTPS_PROXY: 'http://proxy.example:8118',
      NO_PROXY: '.feishu.cn',
    }, () => {
      startLarkConnection('app-test', 'secret', eventDispatcher);

      // The proxy is resolved once for the bot's own Open API domain
      // (open.feishu.cn); NO_PROXY=.feishu.cn matches it, so the connection is
      // direct and no agent is attached.
      expect(capturedWsClientOptions?.agent).toBeUndefined();
    });
  });

  it('supports an ALL_PROXY fallback such as SOCKS', () => {
    withWsProxyEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080' }, () => {
      startLarkConnection('app-test', 'secret', eventDispatcher);

      const agent = capturedWsClientOptions?.agent;
      expect(agent?.getProxyForUrl('wss://msg-frontier.feishu.cn/ws', {})).toBe('socks5://127.0.0.1:1080');
    });
  });

  it('keeps the SDK default agent when no proxy is configured', () => {
    withWsProxyEnv({}, () => {
      startLarkConnection('app-test', 'secret', eventDispatcher);

      expect(capturedWsClientOptions?.agent).toBeUndefined();
    });
  });
});
