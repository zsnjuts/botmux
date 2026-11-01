/**
 * Ordering key for one durable Lark message row (Mew #100).
 *
 * The inbox partition is the whole chat, so a follow-up waiting on one topic
 * (busy turn, pending provider receipt) used to hold back every other topic of
 * the same group. Rows that carry different ordering keys no longer wait for
 * each other; rows without a key stay barriers for the whole partition.
 *
 * A key is only assigned where the routing is certain to be per topic: a
 * receive event in a chat known to be a 话题群, whose text is not a slash
 * command (group-level commands such as /grant must keep their place in the
 * group). Everything else returns `undefined` and keeps the old whole-chat FIFO.
 */
import type { ChatMode } from '../im/lark/client.js';
import type { DurableLarkMessageEventType } from './durable-inbox-shadow.js';

const MAX_ORDERING_KEY_LENGTH = 256;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function plainText(messageType: unknown, content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  const body = record(parsed);
  if (!body) return undefined;
  if (messageType === 'text') return typeof body.text === 'string' ? body.text : undefined;
  if (messageType === 'post') {
    const post = record(body.content) ? body : record(body.zh_cn) ?? record(body.en_us) ?? body;
    const blocks = Array.isArray(post?.content) ? post.content : [];
    const parts: string[] = [];
    for (const line of blocks) {
      if (!Array.isArray(line)) continue;
      for (const item of line) {
        const node = record(item);
        if (node?.tag === 'text' && typeof node.text === 'string') parts.push(node.text);
      }
    }
    return parts.join('');
  }
  return undefined;
}

/** Whether the visible text starts with a slash command once @mentions are removed. */
function looksLikeCommand(text: string): boolean {
  const withoutMentions = text.replace(/@_user_\d+/g, '').replace(/<at\b[^>]*>.*?<\/at>/g, '');
  return withoutMentions.trimStart().startsWith('/');
}

export function larkInboxOrderingKey(input: {
  eventType?: DurableLarkMessageEventType;
  data: unknown;
  chatMode: ChatMode | undefined;
}): string | undefined {
  if ((input.eventType ?? 'lark.im.message.receive_v1') !== 'lark.im.message.receive_v1') return undefined;
  if (input.chatMode !== 'topic') return undefined;
  const data = record(input.data);
  const message = record(data?.message) ?? record(record(data?.event)?.message);
  if (!message || message.chat_type !== 'group') return undefined;
  const messageType = message.message_type;
  // Only text we can read is classified; anything else stays a barrier.
  if (messageType !== 'text' && messageType !== 'post') return undefined;
  const text = plainText(messageType, message.content);
  if (text === undefined || looksLikeCommand(text)) return undefined;
  const rootId = message.root_id;
  const threadId = message.thread_id;
  const anchor = typeof rootId === 'string' && rootId && typeof threadId === 'string' && threadId
    ? rootId
    : message.message_id;
  return typeof anchor === 'string' && anchor.startsWith('om_') && anchor.length <= MAX_ORDERING_KEY_LENGTH
    ? anchor
    : undefined;
}

/**
 * Ordering key for a newly ingested message, from this process's chat-topology
 * cache. A missing topology leaves the row a whole-chat barrier, so a stale one
 * is still used: a chat almost never switches between topic and flat mode,
 * while every first message after a restart or a quiet spell used to become a
 * barrier that a failing row could hold for its whole retry budget (Mew #104).
 * A missing or stale entry is refreshed in the background for the next row.
 */
export function resolveLarkInboxOrderingKey(input: {
  eventType?: DurableLarkMessageEventType;
  data: unknown;
  chatId: string | undefined;
  lastKnownChatMode: (chatId: string) => { mode: ChatMode; fresh: boolean } | undefined;
  refreshChatMode: (chatId: string) => void;
}): string | undefined {
  if (!input.chatId) return undefined;
  const known = input.lastKnownChatMode(input.chatId);
  if (!known?.fresh) input.refreshChatMode(input.chatId);
  return larkInboxOrderingKey({ eventType: input.eventType, data: input.data, chatMode: known?.mode });
}
