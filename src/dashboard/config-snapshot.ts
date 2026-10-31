import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  parseBotConfigsFromText,
  type BotConfig,
} from '../bot-registry.js';
import {
  normalizeGlobalConfig,
  parseGlobalConfigFromText,
  type CodexNotifierGlobalConfig,
  type DashboardGlobalConfig,
  type GlobalConfig,
  type HostOverloadAlertGlobalConfig,
  type MaintenanceConfig,
} from '../global-config.js';
import { assertDurableConfigMutationAllowed } from '../services/durable-config-mutation.js';
import { writeRawConfigAtomic } from '../services/config-store.js';
import { withFileLock } from '../utils/file-lock.js';

const DEFAULT_REFRESH_INTERVAL_MS = 2_000;
const DEFAULT_READ_BUDGET_MS = 1_000;
const FAILURE_LOG_INTERVAL_MS = 60_000;

type RefreshResult = 'updated' | 'failed' | 'timed_out' | 'disabled';

interface GlobalMutationState {
  raw: Record<string, unknown>;
  config: GlobalConfig;
  dirty: boolean;
}

interface BotsMutationState {
  raw: any[];
  dirty: boolean;
}

export interface DashboardConfigSnapshotOptions {
  botsPath: string;
  globalPath: string;
  initialBots?: BotConfig[];
  botsFileEnabled?: boolean;
  refreshIntervalMs?: number;
  readBudgetMs?: number;
  readText?: (path: string) => Promise<string>;
  parseBots?: (text: string) => BotConfig[];
  onBotsSnapshotReady?: (path: string) => void;
  log?: Pick<Console, 'warn'>;
}

/**
 * Dashboard 自有、与存储后端解耦的配置投影。
 *
 * 请求处理只调用 {@link readBots} / {@link readGlobal}；所有文件 open 都走下面的
 * 异步 reader。hard-mount NFS 变慢时最多占住 libuv worker，不会把 HTTP event loop
 * 一起挂住。每份文档最多允许一个 in-flight 读取，挂死的挂载点也不会制造无上限的
 * 阻塞 open 队列。
 *
 * 快照只是投影，不是权威：写入仍经过 durable CAS 和带锁的异步 mutation；读取失败
 * 时继续保留 last-known-good generation。
 */
export class DashboardConfigSnapshotStore {
  readonly botsPath: string;
  readonly globalPath: string;

  private readonly botsFileEnabled: boolean;
  private readonly refreshIntervalMs: number;
  private readonly readBudgetMs: number;
  private readonly readText: (path: string) => Promise<string>;
  private readonly parseBots: (text: string) => BotConfig[];
  private readonly onBotsSnapshotReady?: (path: string) => void;
  private readonly log: Pick<Console, 'warn'>;
  private readonly globalMutation = new AsyncLocalStorage<GlobalMutationState>();
  private readonly botsMutation = new AsyncLocalStorage<BotsMutationState>();

  private botsSnapshot: BotConfig[];
  private rawBotsSnapshot: any[];
  private globalSnapshot: GlobalConfig = {};
  private rawGlobalSnapshot: Record<string, unknown> = {};
  private botsInFlight: Promise<RefreshResult> | null = null;
  private globalInFlight: Promise<RefreshResult> | null = null;
  private botsTimeoutReported = false;
  private globalTimeoutReported = false;
  private lastBotsFailure: { message: string; at: number } | null = null;
  private lastGlobalFailure: { message: string; at: number } | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private globalGeneration = 0;
  private botsGeneration = 0;

  constructor(options: DashboardConfigSnapshotOptions) {
    this.botsPath = options.botsPath;
    this.globalPath = options.globalPath;
    this.botsSnapshot = options.initialBots ?? [];
    this.rawBotsSnapshot = cloneJson(this.botsSnapshot);
    this.botsFileEnabled = options.botsFileEnabled !== false;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.readBudgetMs = options.readBudgetMs ?? DEFAULT_READ_BUDGET_MS;
    this.readText = options.readText ?? (path => fsp.readFile(path, 'utf8'));
    this.parseBots = options.parseBots ?? parseBotConfigsFromText;
    this.onBotsSnapshotReady = options.onBotsSnapshotReady;
    this.log = options.log ?? console;
  }

  readBots = (): BotConfig[] => this.botsSnapshot;

  readRawBots = (path: string): any[] => {
    this.assertBotsPath(path);
    return cloneJson(this.botsMutation.getStore()?.raw ?? this.rawBotsSnapshot);
  };

  readGlobal = (): GlobalConfig => this.globalMutation.getStore()?.config ?? this.globalSnapshot;

  readRawGlobal = (): Record<string, unknown> => cloneJson(
    this.globalMutation.getStore()?.raw ?? this.rawGlobalSnapshot,
  );

  /** 有界启动：存储可以继续阻塞，但 Dashboard 启动不能被它无限拖住。 */
  async prime(timeoutMs = this.readBudgetMs): Promise<{
    bots: RefreshResult;
    global: RefreshResult;
  }> {
    const [bots, global] = await Promise.all([
      this.refreshBots(timeoutMs),
      this.refreshGlobal(timeoutMs),
    ]);
    return { bots, global };
  }

  start(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refreshBots();
      void this.refreshGlobal();
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  refreshBots = (timeoutMs = this.readBudgetMs): Promise<RefreshResult> => {
    if (!this.botsFileEnabled) return Promise.resolve('disabled');
    if (!this.botsInFlight) {
      const observedGeneration = this.botsGeneration;
      this.botsTimeoutReported = false;
      const operation = (async (): Promise<RefreshResult> => {
        try {
          const text = await this.readText(this.botsPath);
          const raw = parseRawBots(text);
          const parsed = this.parseBots(text);
          if (this.botsGeneration === observedGeneration) {
            this.rawBotsSnapshot = raw;
            this.botsSnapshot = parsed;
            this.onBotsSnapshotReady?.(this.botsPath);
          }
          this.lastBotsFailure = null;
          return 'updated';
        } catch (error) {
          this.logRefreshFailure('bots', errorMessage(error));
          return 'failed';
        }
      })();
      const tracked = operation.finally(() => {
        if (this.botsInFlight === tracked) this.botsInFlight = null;
        this.botsTimeoutReported = false;
      });
      this.botsInFlight = tracked;
    }
    return boundedRefresh(this.botsInFlight, timeoutMs, () => {
      if (!this.botsTimeoutReported) {
        this.botsTimeoutReported = true;
        this.log.warn('[dashboard-config] Bot 配置刷新超过时限，HTTP 继续使用最近一次有效快照');
      }
    });
  };

  refreshGlobal = (timeoutMs = this.readBudgetMs): Promise<RefreshResult> => {
    if (!this.globalInFlight) {
      const observedGeneration = this.globalGeneration;
      this.globalTimeoutReported = false;
      const operation = (async (): Promise<RefreshResult> => {
        try {
          let text: string;
          try {
            text = await this.readText(this.globalPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            text = '{}\n';
          }
          const parsed = parseGlobalConfigFromText(text);
          // 写入前启动的读取可能在写入后才带着旧字节返回，不能让它回滚快照。
          if (this.globalGeneration === observedGeneration) {
            this.rawGlobalSnapshot = parsed.raw;
            this.globalSnapshot = parsed.config;
          }
          this.lastGlobalFailure = null;
          return 'updated';
        } catch (error) {
          this.logRefreshFailure('global', errorMessage(error));
          return 'failed';
        }
      })();
      const tracked = operation.finally(() => {
        if (this.globalInFlight === tracked) this.globalInFlight = null;
        this.globalTimeoutReported = false;
      });
      this.globalInFlight = tracked;
    }
    return boundedRefresh(this.globalInFlight, timeoutMs, () => {
      if (!this.globalTimeoutReported) {
        this.globalTimeoutReported = true;
        this.log.warn('[dashboard-config] 全局配置刷新超过时限，HTTP 继续使用最近一次有效快照');
      }
    });
  };

  /**
   * 以异步 I/O + 跨进程文件锁执行一次全局配置事务。调用方持有外层 durable CAS
   * lease；本层保留未知 JSON 字段，只在原子 rename 成功后发布新的内存投影。
   */
  async runGlobalMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
    if (this.globalMutation.getStore()) return mutation();
    assertDurableConfigMutationAllowed('global');
    return withFileLock(this.globalPath, async () => {
      const raw = await this.readGlobalDocument();
      const state: GlobalMutationState = {
        raw,
        config: normalizeGlobalConfig(raw),
        dirty: false,
      };
      return this.globalMutation.run(state, async () => {
        const result = await mutation();
        if (state.dirty) await this.commitGlobalMutation(state);
        return result;
      });
    });
  }

  /** Dashboard onboarding / recovery 使用的异步 bots.json 事务。 */
  async runBotsMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
    if (this.botsMutation.getStore()) return mutation();
    assertDurableConfigMutationAllowed('bots');
    return withFileLock(this.botsPath, async () => {
      const state: BotsMutationState = {
        raw: await this.readBotsDocument(),
        dirty: false,
      };
      return this.botsMutation.run(state, async () => {
        const result = await mutation();
        if (state.dirty) await this.commitBotsMutation(state);
        return result;
      });
    });
  }

  writeRawBots = (path: string, bots: any[]): void => {
    this.assertBotsPath(path);
    const state = this.botsMutation.getStore();
    if (!state) throw new Error('dashboard_bots_config_mutation_required');
    state.raw = cloneJson(bots);
    state.dirty = true;
  };

  mergeGlobalConfig = (
    patch: Partial<Record<keyof GlobalConfig, GlobalConfig[keyof GlobalConfig] | null>>,
  ): void => {
    const state = this.requireGlobalMutation();
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete state.raw[key];
      else state.raw[key] = value;
    }
    this.updateMutationProjection(state);
  };

  mergeDashboardConfig = (patch: DashboardGlobalConfig): DashboardGlobalConfig => {
    const state = this.requireGlobalMutation();
    const existing = objectRecord(state.raw.dashboard);
    this.mergeGlobalConfig({ dashboard: { ...existing, ...patch } as DashboardGlobalConfig });
    return this.requireGlobalMutation().config.dashboard ?? {};
  };

  mergeMaintenanceConfig = (patch: MaintenanceConfig): MaintenanceConfig => {
    const state = this.requireGlobalMutation();
    const existing = objectRecord(state.raw.maintenance);
    this.mergeGlobalConfig({ maintenance: { ...existing, ...patch } as MaintenanceConfig });
    return this.requireGlobalMutation().config.maintenance ?? {};
  };

  setGlobalLocale = (locale: 'zh' | 'en' | null): void => {
    this.mergeGlobalConfig({ lang: locale });
  };

  writeCodexNotifierConfig = (config: CodexNotifierGlobalConfig): void => {
    const state = this.requireGlobalMutation();
    const existing = { ...objectRecord(state.raw.codexNotifier) };
    delete existing.enabled;
    delete existing.targetBotAppId;
    delete existing.notifyWhen;
    this.mergeGlobalConfig({ codexNotifier: { ...existing, ...config } as CodexNotifierGlobalConfig });
  };

  writeHostOverloadAlertConfig = (config: HostOverloadAlertGlobalConfig): void => {
    const state = this.requireGlobalMutation();
    const existing = { ...objectRecord(state.raw.hostOverloadAlert) };
    delete existing.enabled;
    delete existing.targetBotAppId;
    delete existing.enterLoadRatio;
    delete existing.enterMemUsedFrac;
    this.mergeGlobalConfig({ hostOverloadAlert: { ...existing, ...config } as HostOverloadAlertGlobalConfig });
  };

  private requireGlobalMutation(): GlobalMutationState {
    const state = this.globalMutation.getStore();
    if (!state) throw new Error('dashboard_global_config_mutation_required');
    return state;
  }

  private updateMutationProjection(state: GlobalMutationState): void {
    state.config = normalizeGlobalConfig(state.raw);
    state.dirty = true;
  }

  private async readGlobalDocument(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await this.readText(this.globalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {};
    }
    return parseGlobalConfigFromText(text).raw;
  }

  private async readBotsDocument(): Promise<any[]> {
    let text: string;
    try {
      text = await this.readText(this.botsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
    return parseRawBots(text);
  }

  private async commitBotsMutation(state: BotsMutationState): Promise<void> {
    const text = JSON.stringify(state.raw);
    const parsed = this.parseBots(text);
    await writeRawConfigAtomic(this.botsPath, state.raw);
    this.botsGeneration += 1;
    this.rawBotsSnapshot = cloneJson(state.raw);
    this.botsSnapshot = parsed;
    this.onBotsSnapshotReady?.(this.botsPath);
  }

  private async commitGlobalMutation(state: GlobalMutationState): Promise<void> {
    await fsp.mkdir(dirname(this.globalPath), { recursive: true });
    const tmp = `${this.globalPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, `${JSON.stringify(state.raw, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fsp.rename(tmp, this.globalPath);
    } catch (error) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw error;
    }
    this.globalGeneration += 1;
    this.rawGlobalSnapshot = cloneJson(state.raw);
    this.globalSnapshot = state.config;
  }

  private assertBotsPath(path: string): void {
    if (resolve(path) !== resolve(this.botsPath)) {
      throw new Error('dashboard_bots_config_path_mismatch');
    }
  }

  private logRefreshFailure(kind: 'bots' | 'global', message: string): void {
    const now = Date.now();
    const previous = kind === 'bots' ? this.lastBotsFailure : this.lastGlobalFailure;
    if (previous?.message === message && now - previous.at < FAILURE_LOG_INTERVAL_MS) return;
    const next = { message, at: now };
    if (kind === 'bots') this.lastBotsFailure = next;
    else this.lastGlobalFailure = next;
    const label = kind === 'bots' ? 'Bot 配置' : '全局配置';
    this.log.warn(`[dashboard-config] ${label}刷新失败，继续使用最近一次有效快照：${message}`);
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRawBots(text: string): any[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Bot config file must contain a JSON array');
  return parsed;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function boundedRefresh(
  operation: Promise<RefreshResult>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<RefreshResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<'timed_out'>(resolve => {
        timer = setTimeout(() => {
          onTimeout();
          resolve('timed_out');
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
