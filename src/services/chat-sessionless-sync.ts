/**
 * durable primary：处理某群的消息前，把该群的共享 sessionless 状态（代答开关、花名册）
 * 拉齐到本副本的本地缓存。读取方（dispatcher 的代答判定、client.ts 拼 <available_bots>
 * 等）都是同步读本地文件，别的副本写入的变更要靠这一步可见；授权卡 pending 不走这里，
 * 用到时直接读共享记录（见 grant-pending.ts 的 grantPendingStore）。
 *
 * 未注册共享状态（disabled/shadow）时什么都不做。读失败只告警、沿用本地缓存，不阻断消息。
 */
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getDurableChatSessionlessState } from './durable-chat-sessionless-state.js';
import { applyObservedBotsSnapshot } from './observed-bots-store.js';
import { applySubstituteSnapshot } from './substitute-chat-toggle-store.js';

export async function hydrateChatSessionlessState(larkAppId: string, chatId: string): Promise<void> {
  const durable = getDurableChatSessionlessState();
  if (!durable) return;
  try {
    const state = await durable.read(larkAppId, chatId);
    applySubstituteSnapshot(larkAppId, chatId, state.substitute);
    applyObservedBotsSnapshot(config.session.dataDir, larkAppId, chatId, state.observedBots);
  } catch (err) {
    logger.warn(
      `[chat-sessionless:${larkAppId}] hydrate ${chatId.substring(0, 12)} failed, using local cache: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
