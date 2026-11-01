import { describe, expect, it } from 'vitest';
import { larkInboxOrderingKey, resolveLarkInboxOrderingKey } from '../src/services/durable-inbox-ordering.js';
import { durableLarkMessageEvent, parseDurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';

function event(message: Record<string, unknown>) {
  return {
    sender: { sender_type: 'user' },
    message: {
      message_id: 'om_reply',
      chat_id: 'oc_topic_group',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 继续排查' }),
      ...message,
    },
  };
}

describe('durable inbox ordering key (Mew #100)', () => {
  it('keys a topic reply by its topic root and a new topic by itself', () => {
    expect(larkInboxOrderingKey({
      data: event({ root_id: 'om_root', thread_id: 'omt_topic' }),
      chatMode: 'topic',
    })).toBe('om_root');
    expect(larkInboxOrderingKey({ data: event({}), chatMode: 'topic' })).toBe('om_reply');
  });

  it('keeps every row a barrier unless the chat is known to be a topic group', () => {
    const reply = event({ root_id: 'om_root', thread_id: 'omt_topic' });
    expect(larkInboxOrderingKey({ data: reply, chatMode: 'group' })).toBeUndefined();
    expect(larkInboxOrderingKey({ data: reply, chatMode: undefined })).toBeUndefined();
    expect(larkInboxOrderingKey({
      data: event({ chat_type: 'p2p', root_id: 'om_root', thread_id: 'omt_topic' }),
      chatMode: 'topic',
    })).toBeUndefined();
  });

  it('keys a row from a stale topology and refreshes it, instead of a chat-wide barrier (Mew #104)', () => {
    const reply = event({ root_id: 'om_root', thread_id: 'omt_topic' });
    const refreshed: string[] = [];
    const resolve = (known: { mode: 'topic' | 'group'; fresh: boolean } | undefined) => resolveLarkInboxOrderingKey({
      data: reply,
      chatId: 'oc_topic_group',
      lastKnownChatMode: () => known,
      refreshChatMode: chatId => refreshed.push(chatId),
    });

    expect(resolve({ mode: 'topic', fresh: false })).toBe('om_root');
    expect(refreshed).toEqual(['oc_topic_group']);
    expect(resolve({ mode: 'topic', fresh: true })).toBe('om_root');
    expect(refreshed).toEqual(['oc_topic_group']);
    // 从没见过的群仍是屏障，只预热缓存；过期的普通群也照旧是屏障。
    expect(resolve(undefined)).toBeUndefined();
    expect(resolve({ mode: 'group', fresh: false })).toBeUndefined();
    expect(refreshed).toHaveLength(3);
  });

  it('keeps slash commands, edits and unreadable messages as group-wide barriers', () => {
    const command = event({
      root_id: 'om_root',
      thread_id: 'omt_topic',
      content: JSON.stringify({ text: '@_user_1 /grant @someone' }),
    });
    expect(larkInboxOrderingKey({ data: command, chatMode: 'topic' })).toBeUndefined();
    const postCommand = event({
      message_type: 'post',
      content: JSON.stringify({ title: '', content: [[{ tag: 'at', user_id: 'ou_bot' }, { tag: 'text', text: ' /botconfig' }]] }),
    });
    expect(larkInboxOrderingKey({ data: postCommand, chatMode: 'topic' })).toBeUndefined();
    expect(larkInboxOrderingKey({
      eventType: 'lark.im.message.updated_v1',
      data: event({ root_id: 'om_root', thread_id: 'omt_topic' }),
      chatMode: 'topic',
    })).toBeUndefined();
    expect(larkInboxOrderingKey({
      data: event({ message_type: 'image', content: '{}' }),
      chatMode: 'topic',
    })).toBeUndefined();
  });

  it('reads post text so ordinary rich-text replies still get a topic key', () => {
    const post = event({
      root_id: 'om_root',
      thread_id: 'omt_topic',
      message_type: 'post',
      content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: '请看下这个' }]] }),
    });
    expect(larkInboxOrderingKey({ data: post, chatMode: 'topic' })).toBe('om_root');
  });

  it('stores the key in the row payload without changing what consumers parse', () => {
    const data = event({ root_id: 'om_root', thread_id: 'omt_topic' });
    const keyed = durableLarkMessageEvent({
      larkAppId: 'cli_test',
      eventId: 'im.message.receive_v1:cli_test:om_reply',
      partitionKey: 'lark-message-routing:cli_test:oc_topic_group',
      data,
      orderingKey: 'om_root',
      now: 5,
    });
    expect((keyed.payload as Record<string, unknown>).orderingKey).toBe('om_root');
    const claim = { event: keyed, workerId: 'w', claimEpoch: 1, claimUntil: 10, attempts: 1 };
    expect(parseDurableLarkMessageClaim(claim)).toMatchObject({ messageId: 'om_reply', data, orderingKey: 'om_root' });
    const keyless = durableLarkMessageEvent({
      larkAppId: 'cli_test',
      eventId: 'im.message.receive_v1:cli_test:om_reply',
      partitionKey: 'lark-message-routing:cli_test:oc_topic_group',
      data,
      now: 5,
    });
    expect(keyless.payload).not.toHaveProperty('orderingKey');
    expect(parseDurableLarkMessageClaim({ ...claim, event: keyless })).not.toHaveProperty('orderingKey');
  });
});
