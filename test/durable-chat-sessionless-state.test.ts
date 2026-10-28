/**
 * durable primary 下 sessionless 状态的跨副本共享：两个副本各自一个 facade、共用同一个
 * 协调 store（SQLite 参考实现），验证 A 写入的授权卡 pending / 代答开关 / 花名册在 B 上可见。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDurableChatSessionlessStateAccess,
  durableChatSessionlessStateKey,
  setDurableChatSessionlessState,
  type DurableChatSessionlessStateAccess,
} from '../src/services/durable-chat-sessionless-state.js';
import { createDurableGroupContextRecallFacade } from '../src/services/durable-group-context-recall.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { grantPendingStore, _resetForTest as resetPending } from '../src/im/lark/grant-pending.js';
import { hydrateChatSessionlessState } from '../src/services/chat-sessionless-sync.js';
import {
  isSubstituteEnabledForChat,
  setSubstituteEnabledForChatShared,
} from '../src/services/substitute-chat-toggle-store.js';
import { listObservedBots, recordObservedBotsShared } from '../src/services/observed-bots-store.js';

const APP = 'cli_shared';
const CHAT = 'oc_shared';
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

/** 一个协调库 + 两个副本（各自的 facade 与本地数据目录）。 */
function cluster() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-chat-sessionless-'));
  dirs.push(root);
  const store = new SqliteDurableCoordinationStore(join(root, 'coordination.db'));
  const replica = (name: string) => {
    const facade = createDurableGroupContextRecallFacade({ store, ownerId: `chat-sessionless-${name}` });
    const access = createDurableChatSessionlessStateAccess({ facade, store });
    cleanups.push(async () => { await facade.stop(); });
    const dataDir = join(root, `pod-${name}`);
    mkdirSync(dataDir);
    return { access, dataDir };
  };
  cleanups.push(async () => { await store.close(); });
  return { store, a: replica('a'), b: replica('b') };
}

/** 切换「当前进程」所在副本：共享状态入口 + 本地数据目录。 */
function onReplica(replica: { access: DurableChatSessionlessStateAccess; dataDir: string }): void {
  setDurableChatSessionlessState(replica.access);
  vi.stubEnv('SESSION_DATA_DIR', replica.dataDir);
  resetPending();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_800_000_000_000);
});

afterEach(async () => {
  setDurableChatSessionlessState(undefined);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable chat sessionless state', () => {
  it('skips the write when the mutation reports no change', async () => {
    const { store, a } = cluster();
    await a.access.mutate(APP, CHAT, state => {
      state.substitute = false;
      return { changed: true, result: undefined };
    });
    const key = durableChatSessionlessStateKey(APP, CHAT);
    expect(await store.readAuxiliaryState(key)).toMatchObject({ revision: 1 });
    await expect(a.access.mutate(APP, CHAT, () => ({ changed: false, result: 'same' }))).resolves.toBe('same');
    expect(await store.readAuxiliaryState(key)).toMatchObject({ revision: 1 });
    await expect(a.access.read(APP, CHAT)).resolves.toMatchObject({ substitute: false });
  });

  it('lets another replica check and claim a grant card opened on this replica, exactly once', async () => {
    const { a, b } = cluster();
    onReplica(a);
    const nonce = await grantPendingStore.open(APP, CHAT, ['ou_x', 'ou_y'], 5, { message: { message_id: 'om_1' } }, 60_000);
    await grantPendingStore.markDelivered(APP, CHAT, ['ou_x', 'ou_y'], nonce);

    onReplica(b);
    expect(await grantPendingStore.check(APP, CHAT, ['ou_x', 'ou_y'], nonce)).toBe(true);
    expect(await grantPendingStore.check(APP, CHAT, ['ou_x', 'ou_y'], 'other-nonce')).toBe(false);
    const claim = await grantPendingStore.claim(APP, CHAT, ['ou_x', 'ou_y'], nonce);
    expect(claim).toMatchObject({ ok: true, quota: 5, durationMs: 60_000, messageData: { message: { message_id: 'om_1' } } });

    onReplica(a);
    await expect(grantPendingStore.claim(APP, CHAT, ['ou_x', 'ou_y'], nonce)).resolves.toEqual({ ok: false, reason: 'stale' });
    expect(await grantPendingStore.isThrottled(APP, CHAT, 'ou_x')).toBe(false);
  });

  it('restores a claimed card when the grant could not be stored, without overriding a newer card', async () => {
    const { a } = cluster();
    onReplica(a);
    const nonce = await grantPendingStore.open(APP, CHAT, ['ou_x', 'ou_y'], undefined, undefined, undefined);
    const claim = await grantPendingStore.claim(APP, CHAT, ['ou_x', 'ou_y'], nonce);
    if (!claim.ok) throw new Error('expected claim');
    const newer = await grantPendingStore.open(APP, CHAT, ['ou_y'], undefined, undefined, undefined);
    await claim.restore();
    expect(await grantPendingStore.check(APP, CHAT, ['ou_x'], nonce)).toBe(true);
    expect(await grantPendingStore.check(APP, CHAT, ['ou_y'], newer)).toBe(true);
    expect(await grantPendingStore.check(APP, CHAT, ['ou_y'], nonce)).toBe(false);
  });

  it('shares deny cooldown across replicas and keeps it distinct from pending', async () => {
    const { a, b } = cluster();
    onReplica(a);
    const nonce = await grantPendingStore.open(APP, CHAT, ['ou_x'], undefined, undefined, undefined);
    await grantPendingStore.markDelivered(APP, CHAT, ['ou_x'], nonce);
    onReplica(b);
    expect(await grantPendingStore.throttleReason(APP, CHAT, 'ou_x')).toBe('pending');
    expect(await grantPendingStore.deny(APP, CHAT, ['ou_x'])).toBe(true);
    onReplica(a);
    expect(await grantPendingStore.throttleReason(APP, CHAT, 'ou_x')).toBe('denied');
    expect(await grantPendingStore.check(APP, CHAT, ['ou_x'], nonce)).toBe(false);
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    expect(await grantPendingStore.throttleReason(APP, CHAT, 'ou_x')).toBeNull();
  });

  it('stops throttling an undelivered pending left behind by a crash after a short window', async () => {
    const { a } = cluster();
    onReplica(a);
    await grantPendingStore.open(APP, CHAT, ['ou_x'], undefined, undefined, undefined);
    expect(await grantPendingStore.isThrottled(APP, CHAT, 'ou_x')).toBe(true);
    // 卡未送达时不提示申请人「在等管理员处理」。
    expect(await grantPendingStore.claimThrottleNotice(APP, CHAT, 'ou_x')).toBeNull();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    expect(await grantPendingStore.isThrottled(APP, CHAT, 'ou_x')).toBe(false);
  });

  it('reuses a stable nonce when the same Inbox event re-opens its card', async () => {
    const { a } = cluster();
    onReplica(a);
    const first = await grantPendingStore.open(APP, CHAT, ['ou_x'], undefined, undefined, undefined, 'stable-nonce');
    const retry = await grantPendingStore.open(APP, CHAT, ['ou_x'], undefined, undefined, undefined, 'stable-nonce');
    expect(first).toBe('stable-nonce');
    expect(retry).toBe('stable-nonce');
    expect(await grantPendingStore.check(APP, CHAT, ['ou_x'], 'stable-nonce')).toBe(true);
  });

  it('fails a card update closed as unsaved when the shared record cannot be written', async () => {
    const failing: DurableChatSessionlessStateAccess = {
      read: async () => { throw new Error('database unavailable'); },
      mutate: async () => { throw new Error('database unavailable'); },
    };
    setDurableChatSessionlessState(failing);
    await expect(grantPendingStore.claim(APP, CHAT, ['ou_x'], 'n')).resolves.toEqual({ ok: false, reason: 'unsaved' });
    await expect(grantPendingStore.updateLimits(APP, CHAT, ['ou_x'], 'n', { quota: 1 })).resolves.toBe('unsaved');
    await expect(grantPendingStore.deny(APP, CHAT, ['ou_x'])).resolves.toBe(false);
    await expect(grantPendingStore.check(APP, CHAT, ['ou_x'], 'n')).resolves.toBe(false);
  });

  it('makes a /substitute toggle on one replica effective on another after hydration', async () => {
    const { a, b } = cluster();
    onReplica(a);
    await setSubstituteEnabledForChatShared(APP, CHAT, false);
    expect(isSubstituteEnabledForChat(APP, CHAT)).toBe(false);

    onReplica(b);
    expect(isSubstituteEnabledForChat(APP, CHAT)).toBe(true);
    await hydrateChatSessionlessState(APP, CHAT);
    expect(isSubstituteEnabledForChat(APP, CHAT)).toBe(false);

    await setSubstituteEnabledForChatShared(APP, CHAT, true);
    onReplica(a);
    await hydrateChatSessionlessState(APP, CHAT);
    expect(isSubstituteEnabledForChat(APP, CHAT)).toBe(true);
  });

  it('makes an /introduce roster recorded on one replica visible on another after hydration', async () => {
    const { a, b } = cluster();
    onReplica(a);
    await recordObservedBotsShared(a.dataDir, APP, CHAT, [{ openId: 'ou_bot_1', name: 'Codex' }]);

    onReplica(b);
    expect(listObservedBots(b.dataDir, APP, CHAT)).toEqual([]);
    await hydrateChatSessionlessState(APP, CHAT);
    expect(listObservedBots(b.dataDir, APP, CHAT)).toEqual([
      expect.objectContaining({ openId: 'ou_bot_1', name: 'Codex' }),
    ]);

    // 同名 bot 换了 open_id（重建应用）：两边都以新的为准。
    vi.setSystemTime(Date.now() + 1_000);
    await recordObservedBotsShared(b.dataDir, APP, CHAT, [{ openId: 'ou_bot_2', name: 'Codex' }]);
    onReplica(a);
    await hydrateChatSessionlessState(APP, CHAT);
    expect(listObservedBots(a.dataDir, APP, CHAT).map(bot => bot.openId)).toEqual(['ou_bot_2']);
  });

  it('leaves local files untouched when no shared state is registered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-chat-sessionless-local-'));
    dirs.push(root);
    vi.stubEnv('SESSION_DATA_DIR', root);
    await hydrateChatSessionlessState(APP, CHAT);
    expect(existsSync(join(root, 'substitute-chat-toggles.json'))).toBe(false);
    await setSubstituteEnabledForChatShared(APP, CHAT, false);
    expect(JSON.parse(readFileSync(join(root, 'substitute-chat-toggles.json'), 'utf8'))).toEqual({
      disabled: { [APP]: [CHAT] },
    });
  });
});
