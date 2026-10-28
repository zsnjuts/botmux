/**
 * Durable primary 下 sessionless 命令的跨副本共享状态：按 (bot, chat) 一条
 * auxiliary_state 记录，承载原本落在 Pod 本地文件里的三类状态：
 *  - grantPending：授权卡 pending / denied 冷却（原 grant-pending-<appId>.json）；
 *  - substitute：本群代答开关（原 substitute-chat-toggles.json）；
 *  - observedBots：/introduce 登记的花名册（原 observed-bots-<appId>-<chatId>.json）。
 *
 * primary 下 Pod 本地目录只属于单个副本：A 副本发出的授权卡被 B 副本收到点击时读不到
 * pending，A 上关掉的代答在 B 上仍生效。这里复用撤回墓碑同款的按 key FIFO + lease +
 * CAS facade（createDurableGroupContextRecallFacade 把读写路由到 auxiliary_state），
 * 让这些状态以 PostgreSQL 为事实源；本地文件在 primary 下只作为同步读取方的缓存。
 *
 * 只在 primary 注册（setDurableChatSessionlessState）；disabled/shadow 不注册，
 * 各 store 继续走原来的本地文件。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  DurableAuxiliaryStateStore,
  DurableJson,
  DurableSessionRecord,
} from './durable-coordination.js';
import type { DurableSessionFacade } from './durable-session-facade.js';

const RECORD_VERSION = 1;
const RECORD_TYPE = 'botmux.lark.chat-sessionless-state';
/** 单群条目上限：pending 带原始消息事件（重放用），整条记录要有界。 */
export const MAX_GRANT_PENDING_PER_CHAT = 200;
export const MAX_OBSERVED_BOTS_PER_CHAT = 500;
const MAX_MESSAGE_DATA_BYTES = 64 * 1024;
const OCCUPIED_RETRIES = 8;
const OCCUPIED_BACKOFF_MS = 150;

export interface DurableGrantPendingEntry {
  state: 'pending' | 'denied';
  nonce?: string;
  ts: number;
  quota?: number;
  durationMs?: number;
  messageData?: DurableJson;
  delivered?: boolean;
}

export interface DurableObservedBotEntry {
  name: string;
  source: 'introduce';
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface DurableChatSessionlessState {
  /** target open_id → entry */
  grantPending: Record<string, DurableGrantPendingEntry>;
  /** undefined = 从未设置（继承默认开启）；false = 本群关闭代答。 */
  substitute?: boolean;
  /** bot open_id（本 app 视角）→ entry */
  observedBots: Record<string, DurableObservedBotEntry>;
}

export interface DurableChatSessionlessStateAccess {
  read(larkAppId: string, chatId: string): Promise<DurableChatSessionlessState>;
  /**
   * 在该群记录的 lease 内读当前值、调用 mutate 原地修改、提交。mutate 返回
   * `{ changed: false }` 时不写入。mutate 必须是同步纯计算，不能做 I/O。
   */
  mutate<T>(
    larkAppId: string,
    chatId: string,
    mutate: (state: DurableChatSessionlessState) => { changed: boolean; result: T },
  ): Promise<T>;
}

let registered: DurableChatSessionlessStateAccess | undefined;

export function setDurableChatSessionlessState(access: DurableChatSessionlessStateAccess | undefined): void {
  registered = access;
}

/** primary 下返回共享状态入口；其他模式 undefined（各 store 走本地文件）。 */
export function getDurableChatSessionlessState(): DurableChatSessionlessStateAccess | undefined {
  return registered;
}

function boundedId(value: string, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${label} must contain at most 512 non-empty characters`);
  }
  return normalized;
}

export function durableChatSessionlessStateKey(larkAppId: string, chatId: string): string {
  return `auxiliary::chat-sessionless::${boundedId(larkAppId, 'larkAppId')}::${boundedId(chatId, 'chatId')}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function emptyDurableChatSessionlessState(): DurableChatSessionlessState {
  return { grantPending: {}, observedBots: {} };
}

/** 单条 pending 解析；形状不对返回 null（整条丢弃，等价于旧卡失效，不会放大授权）。 */
function parseGrantEntry(raw: unknown): DurableGrantPendingEntry | null {
  if (!isObject(raw) || !finiteNonNegative(raw.ts)) return null;
  if (raw.state === 'denied') return { state: 'denied', ts: raw.ts };
  if (raw.state !== 'pending' || typeof raw.nonce !== 'string' || !raw.nonce) return null;
  const entry: DurableGrantPendingEntry = { state: 'pending', nonce: raw.nonce, ts: raw.ts };
  if (raw.quota !== undefined) {
    if (!(Number.isSafeInteger(raw.quota) && (raw.quota as number) > 0)) return null;
    entry.quota = raw.quota as number;
  }
  if (raw.durationMs !== undefined) {
    if (!(typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs > 0)) return null;
    entry.durationMs = raw.durationMs;
  }
  if (raw.delivered === true) entry.delivered = true;
  if (isObject(raw.messageData)) entry.messageData = raw.messageData as DurableJson;
  return entry;
}

function parseObservedEntry(raw: unknown): DurableObservedBotEntry | null {
  if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name) return null;
  if (!finiteNonNegative(raw.firstSeenAt) || !finiteNonNegative(raw.lastSeenAt)) return null;
  return { name: raw.name, source: 'introduce', firstSeenAt: raw.firstSeenAt, lastSeenAt: raw.lastSeenAt };
}

export function parseDurableChatSessionlessRecord(
  record: Pick<DurableSessionRecord, 'sessionKey' | 'value'>,
  expected: { larkAppId: string; chatId: string },
): DurableChatSessionlessState {
  const raw = record.value;
  if (!isObject(raw)
      || raw.version !== RECORD_VERSION
      || raw.type !== RECORD_TYPE
      || raw.larkAppId !== expected.larkAppId
      || raw.chatId !== expected.chatId
      || !isObject(raw.grantPending)
      || !isObject(raw.observedBots)
      || (raw.substitute !== undefined && typeof raw.substitute !== 'boolean')) {
    throw new Error(`durable chat sessionless state ${record.sessionKey} has an invalid envelope`);
  }
  const state = emptyDurableChatSessionlessState();
  for (const [target, value] of Object.entries(raw.grantPending)) {
    const entry = parseGrantEntry(value);
    if (entry && target) state.grantPending[target] = entry;
  }
  for (const [openId, value] of Object.entries(raw.observedBots)) {
    const entry = parseObservedEntry(value);
    if (entry && openId) state.observedBots[openId] = entry;
  }
  if (typeof raw.substitute === 'boolean') state.substitute = raw.substitute;
  return state;
}

function messageDataFits(value: DurableJson | undefined): boolean {
  if (value === undefined) return true;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_MESSAGE_DATA_BYTES;
  } catch {
    return false;
  }
}

/** 序列化前收紧到上限：超大的重放消息只丢重放（卡照样能点），条目超限按时间淘汰最旧的。 */
function serializeState(
  larkAppId: string,
  chatId: string,
  state: DurableChatSessionlessState,
  now: number,
): DurableJson {
  const grantPending: Record<string, DurableJson> = {};
  const pending = Object.entries(state.grantPending)
    .sort(([, a], [, b]) => b.ts - a.ts)
    .slice(0, MAX_GRANT_PENDING_PER_CHAT);
  for (const [target, e] of pending) {
    grantPending[target] = e.state === 'denied'
      ? { state: 'denied', ts: e.ts }
      : {
          state: 'pending',
          nonce: e.nonce!,
          ts: e.ts,
          ...(e.quota !== undefined ? { quota: e.quota } : {}),
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
          ...(e.delivered ? { delivered: true } : {}),
          ...(e.messageData !== undefined && messageDataFits(e.messageData) ? { messageData: e.messageData } : {}),
        };
  }
  const observedBots: Record<string, DurableJson> = {};
  const observed = Object.entries(state.observedBots)
    .sort(([, a], [, b]) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_OBSERVED_BOTS_PER_CHAT);
  for (const [openId, e] of observed) {
    observedBots[openId] = { name: e.name, source: e.source, firstSeenAt: e.firstSeenAt, lastSeenAt: e.lastSeenAt };
  }
  return {
    version: RECORD_VERSION,
    type: RECORD_TYPE,
    larkAppId,
    chatId,
    grantPending,
    observedBots,
    ...(state.substitute !== undefined ? { substitute: state.substitute } : {}),
    updatedAt: now,
  };
}

/** mutate 判定无需写入时用来中止 facade 写入（builder 抛出即不提交并释放 lease）。 */
class UnchangedMutation<T> extends Error {
  constructor(readonly result: T) {
    super('durable chat sessionless state unchanged');
  }
}

export function createDurableChatSessionlessStateAccess(input: {
  facade: DurableSessionFacade;
  store: DurableAuxiliaryStateStore;
  now?: () => number;
}): DurableChatSessionlessStateAccess {
  const now = input.now ?? Date.now;
  const read = async (larkAppId: string, chatId: string): Promise<DurableChatSessionlessState> => {
    const key = durableChatSessionlessStateKey(larkAppId, chatId);
    const record = await input.store.readAuxiliaryState(key);
    return record
      ? parseDurableChatSessionlessRecord({ sessionKey: record.stateKey, value: record.value }, { larkAppId, chatId })
      : emptyDurableChatSessionlessState();
  };
  return {
    read,
    async mutate(larkAppId, chatId, mutate) {
      const key = durableChatSessionlessStateKey(larkAppId, chatId);
      for (let attempt = 0; ; attempt++) {
        let result: Awaited<ReturnType<DurableSessionFacade['writeExactFromCurrent']>>;
        let outcome: { value: unknown } | undefined;
        try {
          result = await input.facade.writeExactFromCurrent(key, current => {
            const state = current
              ? parseDurableChatSessionlessRecord(current, { larkAppId, chatId })
              : emptyDurableChatSessionlessState();
            const applied = mutate(state);
            if (!applied.changed) throw new UnchangedMutation(applied.result);
            outcome = { value: applied.result };
            return serializeState(larkAppId, chatId, state, now());
          });
        } catch (error) {
          if (error instanceof UnchangedMutation) return error.result as never;
          throw error;
        } finally {
          await input.facade.releaseLease(key).catch(() => false);
        }
        if ((result.kind === 'written' || result.kind === 'unchanged') && outcome) {
          return outcome.value as never;
        }
        // 另一个副本正持有这条记录的 lease：短暂退避后整段重读重算。
        if ((result.kind === 'occupied' || result.kind === 'conflict') && attempt < OCCUPIED_RETRIES) {
          await sleep(OCCUPIED_BACKOFF_MS * (attempt + 1));
          continue;
        }
        throw new Error(`durable chat sessionless state write did not commit: ${result.kind}`);
      }
    },
  };
}
