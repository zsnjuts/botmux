import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { getDurableChatSessionlessState } from './durable-chat-sessionless-state.js';

type Store = {
  disabled: Record<string, string[]>;
};

function filePath(): string {
  return join(config.session.dataDir, 'substitute-chat-toggles.json');
}

function normalize(raw: unknown): Store {
  const disabled: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { disabled };
  const rec = raw as Record<string, unknown>;
  const d = rec.disabled;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { disabled };
  for (const [appId, chats] of Object.entries(d)) {
    if (!Array.isArray(chats)) continue;
    const ids = chats.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    if (ids.length > 0) disabled[appId] = [...new Set(ids)];
  }
  return { disabled };
}

function readStore(): Store {
  try {
    if (!existsSync(filePath())) return { disabled: {} };
    return normalize(JSON.parse(readFileSync(filePath(), 'utf-8')));
  } catch {
    return { disabled: {} };
  }
}

function writeStore(store: Store): void {
  atomicWriteFileSync(filePath(), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

export function isSubstituteEnabledForChat(larkAppId: string, chatId: string | undefined): boolean {
  if (!chatId) return true;
  return !(readStore().disabled[larkAppId] ?? []).includes(chatId);
}

export function setSubstituteEnabledForChat(larkAppId: string, chatId: string, enabled: boolean): boolean {
  const store = readStore();
  const set = new Set(store.disabled[larkAppId] ?? []);
  if (enabled) set.delete(chatId);
  else set.add(chatId);
  const next = [...set].sort();
  if (next.length > 0) store.disabled[larkAppId] = next;
  else delete store.disabled[larkAppId];
  writeStore(store);
  return enabled;
}

/**
 * 跨副本版 setSubstituteEnabledForChat：durable primary 下先写进按群共享记录（PostgreSQL），
 * 再写本副本本地文件；别的副本处理该群消息前会用 applySubstituteSnapshot 拉齐。其他模式
 * 等同 setSubstituteEnabledForChat。
 */
export async function setSubstituteEnabledForChatShared(
  larkAppId: string,
  chatId: string,
  enabled: boolean,
): Promise<boolean> {
  const durable = getDurableChatSessionlessState();
  if (durable) {
    await durable.mutate(larkAppId, chatId, state => {
      const changed = state.substitute !== enabled;
      state.substitute = enabled;
      return { changed, result: undefined };
    });
  }
  return setSubstituteEnabledForChat(larkAppId, chatId, enabled);
}

/** 共享记录里的开关同步到本地文件；undefined = 从未设置过，不动本地。 */
export function applySubstituteSnapshot(larkAppId: string, chatId: string, enabled: boolean | undefined): void {
  if (enabled === undefined || isSubstituteEnabledForChat(larkAppId, chatId) === enabled) return;
  setSubstituteEnabledForChat(larkAppId, chatId, enabled);
}
