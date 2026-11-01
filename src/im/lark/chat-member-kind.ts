/**
 * 判断群里的一组 open_id 是真人还是 bot（Mew #26）。
 *
 * 通讯录（`isHumanOpenId`）只认得应用通讯录范围内的人：范围外的真人和 bot 一样返回
 * 41050 no user authority，单靠它分不出来，于是范围外的真人会被当成 bot 写进 observed
 * 花名册。群成员接口（`/im/v1/chats/:id/members`）只列真人、不受通讯录范围限制，作为
 * 第二个信号：
 *  - 通讯录查得到，或在群真人成员里 → `human`；
 *  - 群成员列表拿到了、里面没有 → `bot`；
 *  - 两边都不能确认 → `unknown`，由调用方决定怎么降级（自动登记应当跳过）。
 */
import { isHumanOpenId, listChatMemberOpenIds } from './client.js';
import { logger } from '../../utils/logger.js';

export type ChatMemberKind = 'human' | 'bot' | 'unknown';

export async function classifyChatMembers(
  larkAppId: string,
  chatId: string,
  openIds: readonly string[],
): Promise<ChatMemberKind[]> {
  if (openIds.length === 0) return [];
  const inContact = await Promise.all(openIds.map(id => isHumanOpenId(larkAppId, id).catch(() => false)));
  if (inContact.every(Boolean)) return openIds.map(() => 'human');
  let members: Set<string> | undefined;
  try {
    members = new Set(await listChatMemberOpenIds(larkAppId, chatId));
  } catch (err) {
    logger.warn(`[${larkAppId}] chat member lookup for ${chatId} failed; unconfirmed targets stay unknown: ${err}`);
  }
  return openIds.map((id, i): ChatMemberKind => {
    if (inContact[i] || members?.has(id)) return 'human';
    return members ? 'bot' : 'unknown';
  });
}
