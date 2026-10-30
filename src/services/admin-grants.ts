/**
 * 管理员批量全局对话授权（`infrabuddy grants`，经 person-authenticated admin API）。
 *
 * 选人方式有三种：群成员（`chats`，机器人须在群里）、邮箱 / union_id（`users`）、
 * 字面 open_id（`openIds`）。三种都**用本 bot 自己的飞书应用**解析成 open_id——open_id
 * 按应用隔离，别的应用里的 ou_ 在这里无效（见 CLAUDE.md「飞书 owner 身份边界」）。
 * 所以字面 open_id 在授权前会用本应用查一次，跨应用的直接拒绝。
 *
 * 写入走 grant-store 的批量函数：一批人一次 CAS，操作人记进 CAS 审计。只动
 * `globalGrants`（talk-only），从不碰 `allowedUsers`。
 */
import { getBot, getBotOpenId } from '../bot-registry.js';
import type { ChatUserMember, UserProfileLookup } from '../im/lark/client.js';
import { ADMIN_ACTOR_VIA, type AdminIdentity } from './admin-api.js';
import { withConfigActor } from './durable-config-mutation.js';
import { MAX_GRANT_QUOTA } from './grant-policy.js';
import {
  addGlobalGrants,
  classifyGlobalGrant,
  globalGrantState,
  removeGlobalGrants,
  type GlobalGrantChange,
} from './grant-store.js';

const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/;
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;
const UNION_ID = /^on_[A-Za-z0-9_-]{1,128}$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** 一次请求最多的选人条目数（群成员展开后另有上限，见 MAX_SUBJECTS）。 */
const MAX_SELECTOR_ENTRIES = 2000;
const MAX_CHATS = 20;
/** 一次写入最多的人数：与群成员列表的分页上限（2000）对齐。 */
const MAX_SUBJECTS = 2000;
const MIN_DURATION_MS = 60_000;
const MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000;
const LOOKUP_CONCURRENCY = 8;

export interface GrantSelectors {
  chats: string[];
  users: string[];
  openIds: string[];
}

export interface GrantResolveDeps {
  listChatMembers: (larkAppId: string, chatId: string) => Promise<ChatUserMember[]>;
  resolveUsers: (larkAppId: string, raw: string[]) => Promise<{
    map: Map<string, string>;
    definitiveMisses: string[];
    errored?: boolean;
  }>;
  lookupProfile: (larkAppId: string, openId: string) => Promise<UserProfileLookup>;
  now: () => number;
}

// 飞书客户端在调用时才加载：本模块在 dashboard-ipc-server 的静态导入图里，很多测试用
// 只列出部分导出的工厂函数 mock 了 client.js，静态具名导入会让它们在加载时就失败。
let larkClient: Promise<typeof import('../im/lark/client.js')> | undefined;
const lark = () => (larkClient ??= import('../im/lark/client.js'));

export const defaultGrantResolveDeps: GrantResolveDeps = {
  listChatMembers: async (larkAppId, chatId) => (await lark()).listChatUserMembers(larkAppId, chatId),
  resolveUsers: async (larkAppId, raw) => (await lark()).resolveAllowedUsersWithMap(larkAppId, raw),
  lookupProfile: async (larkAppId, openId) => (await lark()).getUserProfileStrict(larkAppId, openId, 'open_id'),
  now: Date.now,
};

export interface ResolvedSubject {
  openId: string;
  name?: string;
  /** 这个人是从哪些条件选出来的，如 `chat:oc_x`、`user:a@b.com`、`openId:ou_x`。 */
  sources: string[];
}

export interface UnresolvedSelector {
  input: string;
  reason: 'chat_members_unavailable' | 'user_not_found' | 'lookup_failed' | 'cross_app_open_id' | 'invalid_open_id';
  detail?: string;
}

type Failure = { ok: false; status: number; error: string; detail?: unknown };

function stringList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some(v => typeof v !== 'string')) return undefined;
  return [...new Set((raw as string[]).map(v => v.trim()).filter(Boolean))];
}

export function parseGrantSelectors(raw: unknown): { ok: true; selectors: GrantSelectors } | Failure {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'subjects_required' };
  }
  const obj = raw as Record<string, unknown>;
  const chats = stringList(obj.chats);
  const users = stringList(obj.users);
  const openIds = stringList(obj.openIds);
  if (!chats || !users || !openIds) return { ok: false, status: 400, error: 'invalid_subjects' };
  if (chats.length + users.length + openIds.length === 0) return { ok: false, status: 400, error: 'subjects_required' };
  if (chats.length > MAX_CHATS || chats.length + users.length + openIds.length > MAX_SELECTOR_ENTRIES) {
    return { ok: false, status: 400, error: 'too_many_subjects' };
  }
  const badChat = chats.find(v => !CHAT_ID.test(v));
  if (badChat) return { ok: false, status: 400, error: 'invalid_chat_id', detail: badChat };
  const badUser = users.find(v => !EMAIL.test(v) && !UNION_ID.test(v));
  if (badUser) {
    // ou_ 放进 users 多半是从别处复制来的：单独提示用 openIds，并且会先经本应用校验。
    return { ok: false, status: 400, error: OPEN_ID.test(badUser) ? 'open_id_in_users' : 'invalid_user', detail: badUser };
  }
  const badOpenId = openIds.find(v => !OPEN_ID.test(v));
  if (badOpenId) return { ok: false, status: 400, error: 'invalid_open_id', detail: badOpenId };
  return { ok: true, selectors: { chats, users, openIds } };
}

/** 有效期与额度：缺省 / `permanent` = 永久，缺省 / `unlimited` = 不限额度。 */
export function parseGrantLimits(body: Record<string, unknown>):
  { ok: true; durationMs?: number; quota?: number } | Failure {
  let durationMs: number | undefined;
  const d = body.durationMs;
  if (d !== undefined && d !== null && d !== 'permanent') {
    if (typeof d !== 'number' || !Number.isSafeInteger(d) || d < MIN_DURATION_MS || d > MAX_DURATION_MS) {
      return { ok: false, status: 400, error: 'invalid_duration', detail: { minMs: MIN_DURATION_MS, maxMs: MAX_DURATION_MS } };
    }
    durationMs = d;
  }
  let quota: number | undefined;
  const q = body.quota;
  if (q !== undefined && q !== null && q !== 'unlimited') {
    if (typeof q !== 'number' || !Number.isSafeInteger(q) || q < 1 || q > MAX_GRANT_QUOTA) {
      return { ok: false, status: 400, error: 'invalid_quota', detail: { max: MAX_GRANT_QUOTA } };
    }
    quota = q;
  }
  return { ok: true, ...(durationMs !== undefined ? { durationMs } : {}), ...(quota !== undefined ? { quota } : {}) };
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * 把选人条件解析成本应用下的 open_id。`verifyOpenIds` 为真时，字面 open_id 先用本应用
 * 查一次：跨应用、无效的拒绝，查询失败的也不放行（授权宁缺勿滥）；撤销时不校验，
 * 这样连无效条目也能按原样删掉。
 */
export async function resolveGrantSubjects(
  larkAppId: string,
  selectors: GrantSelectors,
  deps: GrantResolveDeps,
  opts: { verifyOpenIds: boolean },
): Promise<{ subjects: ResolvedSubject[]; unresolved: UnresolvedSelector[] }> {
  const byId = new Map<string, ResolvedSubject>();
  const unresolved: UnresolvedSelector[] = [];
  const add = (openId: string, source: string, name?: string) => {
    const cur = byId.get(openId);
    if (cur) {
      if (!cur.sources.includes(source)) cur.sources.push(source);
      if (!cur.name && name) cur.name = name;
    } else {
      byId.set(openId, { openId, ...(name ? { name } : {}), sources: [source] });
    }
  };

  for (const chatId of selectors.chats) {
    try {
      for (const member of await deps.listChatMembers(larkAppId, chatId)) add(member.openId, `chat:${chatId}`, member.name);
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      unresolved.push({ input: chatId, reason: 'chat_members_unavailable', detail });
    }
  }

  if (selectors.users.length > 0) {
    const result = await deps.resolveUsers(larkAppId, selectors.users);
    for (const user of selectors.users) {
      const openId = result.map.get(user);
      if (openId) add(openId, `user:${user}`);
      else unresolved.push({
        input: user,
        reason: result.errored && !result.definitiveMisses.includes(user) ? 'lookup_failed' : 'user_not_found',
      });
    }
  }

  if (opts.verifyOpenIds) {
    const lookups = await mapPool(selectors.openIds, LOOKUP_CONCURRENCY, id => deps.lookupProfile(larkAppId, id));
    selectors.openIds.forEach((openId, i) => {
      const r = lookups[i];
      if (r.status === 'ok') add(openId, `openId:${openId}`, r.profile.name);
      // 41050：本应用下有效，只是不在通讯录范围（或是机器人），照样能授权。
      else if (r.status === 'not_visible') add(openId, `openId:${openId}`);
      else unresolved.push({
        input: openId,
        reason: r.status === 'cross_app' ? 'cross_app_open_id' : r.status === 'invalid_id' ? 'invalid_open_id' : 'lookup_failed',
      });
    });
  } else {
    for (const openId of selectors.openIds) add(openId, `openId:${openId}`);
  }

  return { subjects: [...byId.values()], unresolved };
}

export interface GrantAddResult {
  ok: true;
  dryRun: boolean;
  expiresAt: number | null;
  quota: number | null;
  subjects: Array<ResolvedSubject & { change: GlobalGrantChange }>;
  skipped: Array<ResolvedSubject & { reason: 'self' | 'admin' }>;
  unresolved: UnresolvedSelector[];
  counts: Record<GlobalGrantChange | 'skipped' | 'unresolved', number>;
}

function actorOf(identity: AdminIdentity) {
  return { via: ADMIN_ACTOR_VIA, id: identity.email };
}

function failureFromStore(reason: string): Failure {
  return { ok: false, status: reason === 'bot_not_registered' ? 404 : 409, error: reason };
}

/** 批量全局授权。`dryRun` 只返回将要发生的变化，不写入。 */
export async function adminGrantsAdd(input: {
  larkAppId: string;
  identity: AdminIdentity;
  body: Record<string, unknown>;
}, deps: GrantResolveDeps = defaultGrantResolveDeps): Promise<GrantAddResult | Failure> {
  const parsed = parseGrantSelectors(input.body.subjects);
  if (!parsed.ok) return parsed;
  const limits = parseGrantLimits(input.body);
  if (!limits.ok) return limits;
  let bot;
  try { bot = getBot(input.larkAppId); } catch { return { ok: false, status: 404, error: 'bot_not_registered' }; }

  const { subjects, unresolved } = await resolveGrantSubjects(input.larkAppId, parsed.selectors, deps, { verifyOpenIds: true });
  const selfOpenId = getBotOpenId(input.larkAppId);
  const admins = new Set(bot.resolvedAllowedUsers);
  const skipped: GrantAddResult['skipped'] = [];
  const grantable: ResolvedSubject[] = [];
  for (const s of subjects) {
    // 管理员本来就能在任何地方用（还能做管理操作），不必再占一条全局授权。
    if (s.openId === selfOpenId) skipped.push({ ...s, reason: 'self' });
    else if (admins.has(s.openId)) skipped.push({ ...s, reason: 'admin' });
    else grantable.push(s);
  }
  if (grantable.length > MAX_SUBJECTS) return { ok: false, status: 400, error: 'too_many_subjects', detail: { max: MAX_SUBJECTS } };

  const expiresAt = limits.durationMs !== undefined ? deps.now() + limits.durationMs : undefined;
  const dryRun = input.body.dryRun === true;
  // 先按内存里的现状预判。全都没变就不发起写入：每次 CAS 变更（哪怕没改内容）都会占
  // 一条只保留 64 条的审计记录，反复执行同一条授权命令不该把真正的历史挤掉。真要写时
  // 仍以 RMW 里读到的磁盘快照为准。
  const planned: Record<string, GlobalGrantChange> = Object.fromEntries(
    grantable.map(s => [s.openId, classifyGlobalGrant(bot.config, s.openId, limits.quota, expiresAt)]));
  let changes = planned;
  if (!dryRun && Object.values(planned).some(c => c !== 'unchanged')) {
    const written = await withConfigActor(actorOf(input.identity), () =>
      addGlobalGrants(input.larkAppId, grantable.map(s => s.openId), { quota: limits.quota, expiresAt }));
    if (!written.ok) return failureFromStore(written.reason);
    changes = written.changes;
  }
  const withChange = grantable.map(s => ({ ...s, change: changes[s.openId] ?? 'unchanged' as GlobalGrantChange }));
  const count = (c: GlobalGrantChange) => withChange.filter(s => s.change === c).length;
  return {
    ok: true,
    dryRun,
    expiresAt: expiresAt ?? null,
    quota: limits.quota ?? null,
    subjects: withChange,
    skipped,
    unresolved,
    counts: {
      created: count('created'),
      updated: count('updated'),
      unchanged: count('unchanged'),
      skipped: skipped.length,
      unresolved: unresolved.length,
    },
  };
}

export interface GrantRemoveResult {
  ok: true;
  dryRun: boolean;
  removed: ResolvedSubject[];
  absent: ResolvedSubject[];
  unresolved: UnresolvedSelector[];
}

/** 批量撤销全局授权。字面 open_id 不校验，便于删掉无效条目。 */
export async function adminGrantsRemove(input: {
  larkAppId: string;
  identity: AdminIdentity;
  body: Record<string, unknown>;
}, deps: GrantResolveDeps = defaultGrantResolveDeps): Promise<GrantRemoveResult | Failure> {
  const parsed = parseGrantSelectors(input.body.subjects);
  if (!parsed.ok) return parsed;
  let bot;
  try { bot = getBot(input.larkAppId); } catch { return { ok: false, status: 404, error: 'bot_not_registered' }; }
  const { subjects, unresolved } = await resolveGrantSubjects(input.larkAppId, parsed.selectors, deps, { verifyOpenIds: false });
  const dryRun = input.body.dryRun === true;
  // 同 adminGrantsAdd：名单里一个都没有就不写，免得空写占审计记录。
  let removedIds = new Set(subjects.filter(s => globalGrantState(bot.config, s.openId).granted).map(s => s.openId));
  if (!dryRun && removedIds.size > 0) {
    const written = await withConfigActor(actorOf(input.identity), () =>
      removeGlobalGrants(input.larkAppId, subjects.map(s => s.openId)));
    if (!written.ok) return failureFromStore(written.reason);
    removedIds = new Set(written.removed);
  }
  return {
    ok: true,
    dryRun,
    removed: subjects.filter(s => removedIds.has(s.openId)),
    absent: subjects.filter(s => !removedIds.has(s.openId)),
    unresolved,
  };
}

export type GrantEntryStatus = UserProfileLookup['status'] | 'unchecked';

export interface GrantListEntry {
  openId: string;
  name?: string;
  /** 用本应用查这个 open_id 的结果：cross_app / invalid_id 是无效条目，可用 prune 清掉。 */
  status: GrantEntryStatus;
  expiresAt: number | null;
  quota: { limit: number; used: number } | null;
}

async function describeGlobalGrants(
  larkAppId: string, deps: GrantResolveDeps, opts: { names: boolean },
): Promise<GrantListEntry[]> {
  const config = getBot(larkAppId).config;
  const ids: string[] = Array.isArray(config.globalGrants) ? [...config.globalGrants] : [];
  const lookups = opts.names
    ? await mapPool(ids, LOOKUP_CONCURRENCY, id => deps.lookupProfile(larkAppId, id))
    : [];
  return ids.map((openId, i) => {
    const state = globalGrantState(config, openId);
    const quota = config.quotaState?.[`global:${openId}`];
    const lookup = lookups[i];
    return {
      openId,
      ...(lookup?.status === 'ok' ? { name: lookup.profile.name } : {}),
      status: lookup ? lookup.status : 'unchecked',
      expiresAt: state.expiresAt ?? null,
      quota: quota && typeof quota.limit === 'number' ? { limit: quota.limit, used: quota.used ?? 0 } : null,
    };
  });
}

export async function adminGrantsList(
  larkAppId: string, opts: { names: boolean }, deps: GrantResolveDeps = defaultGrantResolveDeps,
): Promise<{
  ok: true;
  global: GrantListEntry[];
  wholeChats: string[];
  chatGrants: Array<{ chatId: string; count: number }>;
  admins: number;
} | Failure> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, status: 404, error: 'bot_not_registered' }; }
  const chatGrants = Object.entries(bot.config.chatGrants ?? {})
    .filter(([, ids]) => Array.isArray(ids) && ids.length > 0)
    .map(([chatId, ids]) => ({ chatId, count: (ids as string[]).length }));
  return {
    ok: true,
    global: await describeGlobalGrants(larkAppId, deps, opts),
    wholeChats: [...(bot.config.allowedChatGroups ?? [])],
    chatGrants,
    admins: bot.resolvedAllowedUsers.length,
  };
}

/**
 * 清理无效的全局授权：本应用确定判为跨应用（99992361）或无效 id 的条目，它们永远
 * 不会命中任何发送者。41050（不在通讯录范围、或是机器人）不算无效，查询失败也不动。
 */
export async function adminGrantsPrune(input: {
  larkAppId: string;
  identity: AdminIdentity;
  body: Record<string, unknown>;
}, deps: GrantResolveDeps = defaultGrantResolveDeps): Promise<{
  ok: true;
  dryRun: boolean;
  invalid: GrantListEntry[];
  removed: string[];
} | Failure> {
  try { getBot(input.larkAppId); } catch { return { ok: false, status: 404, error: 'bot_not_registered' }; }
  const entries = await describeGlobalGrants(input.larkAppId, deps, { names: true });
  const invalid = entries.filter(e => e.status === 'cross_app' || e.status === 'invalid_id');
  const dryRun = input.body.dryRun === true;
  if (dryRun || invalid.length === 0) return { ok: true, dryRun, invalid, removed: [] };
  const written = await withConfigActor(actorOf(input.identity), () =>
    removeGlobalGrants(input.larkAppId, invalid.map(e => e.openId)));
  if (!written.ok) return failureFromStore(written.reason);
  return { ok: true, dryRun, invalid, removed: written.removed };
}
