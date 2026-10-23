import * as Lark from '@larksuiteoapi/node-sdk';
import { describeLarkWsProxy, describeWsRuntime, larkWsAgentFor, resolveLarkWsProxy } from '../ws-proxy-agent.js';
import { logger } from '../../../utils/logger.js';
import { type Brand, sdkDomain } from '../lark-hosts.js';

type SdkConnectionStatus = ReturnType<Lark.WSClient['getConnectionStatus']>;
type SdkConnectionState = SdkConnectionStatus['state'];

export interface LarkConnectionHealth {
  generation: number;
  state: SdkConnectionState | 'closed';
  observedAt: number;
  transitionedAt: number;
  startedAt: number;
  reconnectAttempts: number;
  lastConnectTime?: number;
  nextConnectTime?: number;
}

type HealthReader = () => LarkConnectionHealth;
const healthReaders = new Map<string, HealthReader>();

/** Current process-local transport health for the daemon heartbeat. */
export function getLarkConnectionHealth(larkAppId: string): LarkConnectionHealth | undefined {
  const read = healthReaders.get(larkAppId);
  return read ? { ...read() } : undefined;
}

/**
 * Start the SDK connection and its failed/idle-state recovery watchdog.
 * The caller owns event registration and business dispatch; this module only
 * passes the supplied dispatcher to the SDK.
 *
 * The returned Proxy keeps the historical WSClient-shaped API while forwarding
 * every operation to the current generation. Recovery always creates a fresh
 * SDK client: reusing a terminal or internally wedged client keeps its socket,
 * listeners and state machine in the same failure domain.
 */
export function startLarkConnection(
  larkAppId: string,
  larkAppSecret: string,
  eventDispatcher: Lark.EventDispatcher,
  brand: Brand = 'feishu',
  lifecycle: {
    onReady?: () => void;
    onReconnecting?: () => void;
    onReconnected?: () => void;
    onRestarting?: () => void;
  } = {},
): Lark.WSClient {
  // Proxy for the long connection: resolved once, logged once, and echoed in
  // every ws failure line so "did it go through the proxy?" is answerable from
  // the log alone. See ws-proxy-agent.ts for why the agent shape matters on Bun.
  const wsProxy = resolveLarkWsProxy(sdkDomain(brand));
  const wsProxyDesc = describeLarkWsProxy(wsProxy);
  logger.info(`[ws] ${larkAppId} connecting domain=${sdkDomain(brand)} proxy=${wsProxyDesc} runtime=${describeWsRuntime()}`);
  let generation = 0;
  let currentClient: Lark.WSClient;
  let currentHealth: LarkConnectionHealth;
  let everReady = false;
  let closed = false;
  let reviving = false;

  const record = (state: LarkConnectionHealth['state'], status?: SdkConnectionStatus): LarkConnectionHealth => {
    const now = Date.now();
    if (currentHealth.state !== state) currentHealth.transitionedAt = now;
    currentHealth = {
      ...currentHealth,
      state,
      observedAt: now,
      reconnectAttempts: status?.reconnectAttempts ?? currentHealth.reconnectAttempts,
      ...(status?.lastConnectTime === undefined ? {} : { lastConnectTime: status.lastConnectTime }),
      ...(status?.nextConnectTime === undefined ? {} : { nextConnectTime: status.nextConnectTime }),
    };
    return currentHealth;
  };

  const createClient = (): Lark.WSClient => {
    const clientGeneration = ++generation;
    const now = Date.now();
    currentHealth = {
      generation: clientGeneration,
      state: 'connecting',
      observedAt: now,
      transitionedAt: now,
      startedAt: now,
      reconnectAttempts: 0,
    };
    return new Lark.WSClient({
      appId: larkAppId,
      appSecret: larkAppSecret,
      // brand → 长连接域名。国际版租户必须连 larksuite.com，否则收不到任何事件。
      domain: sdkDomain(brand),
      // Evaluated against the HTTPS form of the domain so HTTPS_PROXY / NO_PROXY
      // apply exactly as they do to the SDK's preceding Axios bootstrap request.
      agent: larkWsAgentFor(wsProxy),
      // Default to warn — the SDK is chatty at info ("client ready", reconnect
      // heartbeats, etc.) and floods pm2 error.log when stderr is the only sink.
      // DEBUG=1 widens the level back to info for troubleshooting.
      loggerLevel: process.env.DEBUG ? Lark.LoggerLevel.info : Lark.LoggerLevel.warn,
      // 主机长断网（夜间合盖睡眠、Wi-Fi 切换、VPN 重连）后，SDK 重连要先用 HTTPS 去
      // 飞书换 ws 接入点，这步会 ENOTFOUND / 15s 超时；重连次数由服务端下发且有限。
      // pingTimeout 负责半开连接；外层 generation watchdog 负责 SDK 已永久放弃或
      // ready 后异常退回 idle 的状态。
      wsConfig: { pingTimeout: 30 },
      handshakeTimeoutMs: 15_000,
      onReady: () => {
        if (clientGeneration !== generation || closed) return;
        everReady = true;
        record('connected');
        lifecycle.onReady?.();
      },
      onReconnecting: () => {
        if (clientGeneration !== generation || closed) return;
        record('reconnecting');
        logger.warn(`[ws] ${larkAppId} reconnecting…`);
        lifecycle.onReconnecting?.();
      },
      onReconnected: () => {
        if (clientGeneration !== generation || closed) return;
        record('connected');
        logger.info(`[ws] ${larkAppId} reconnected`);
        lifecycle.onReconnected?.();
      },
      onError: (err) => {
        if (clientGeneration !== generation || closed) return;
        record('failed');
        logger.error(`[ws] ${larkAppId} terminal error: ${err.message} (proxy=${wsProxyDesc} runtime=${describeWsRuntime()})`);
      },
    });
  };

  const startClient = (client: Lark.WSClient, clientGeneration: number): Promise<void> => Promise.resolve(
    client.start({ eventDispatcher }),
  ).catch((error) => {
    if (clientGeneration !== generation || closed) return;
    record('failed');
    logger.error(
      `[ws] ${larkAppId} connection start failed: `
      + `${error instanceof Error ? error.message : String(error)} `
      + `(proxy=${wsProxyDesc} runtime=${describeWsRuntime()})`,
    );
  });

  const observe = (): LarkConnectionHealth => {
    if (closed) return record('closed');
    try {
      const status = currentClient.getConnectionStatus();
      return record(status.state, status);
    } catch (error) {
      logger.error(`[ws] ${larkAppId} connection status probe failed: ${error instanceof Error ? error.message : String(error)}`);
      return record('failed');
    }
  };

  currentClient = createClient();
  healthReaders.set(larkAppId, observe);
  void startClient(currentClient, generation);
  logger.info('Daemon WSClient started');

  // SDK reconnect exhaustion is terminal. A client that was ready and later
  // becomes idle is equally non-serving: no reconnect loop owns it. In either
  // case retire the whole client generation and build a fresh object. Do not
  // disturb connected/connecting/reconnecting states — the SDK owns them.
  const reviveTimer = setInterval(() => {
    if (closed || reviving) return;
    const health = observe();
    if (health.state !== 'failed' && !(everReady && health.state === 'idle')) return;
    reviving = true;
    logger.warn(`[ws] ${larkAppId} connection ${health.state} (proxy=${wsProxyDesc} runtime=${describeWsRuntime()}), rebuilding WSClient generation`);
    lifecycle.onRestarting?.();
    try { currentClient.close({ force: true }); } catch { /* best effort */ }
    currentClient = createClient();
    void startClient(currentClient, generation).finally(() => { reviving = false; });
  }, 60_000);
  reviveTimer.unref();

  const initialClient = currentClient;
  const managedClient = new Proxy(initialClient, {
    get(_target, property) {
      if (property === 'close') {
        return (params: { force?: boolean } = {}) => {
          if (closed) return;
          closed = true;
          clearInterval(reviveTimer);
          try { currentClient.close(params); } finally {
            record('closed');
            if (healthReaders.get(larkAppId) === observe) healthReaders.delete(larkAppId);
          }
        };
      }
      const value = Reflect.get(currentClient as object, property, currentClient);
      return typeof value === 'function' ? value.bind(currentClient) : value;
    },
    set(_target, property, value) {
      return Reflect.set(currentClient as object, property, value, currentClient);
    },
  });

  return managedClient;
}
