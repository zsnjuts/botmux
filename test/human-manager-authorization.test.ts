/**
 * `manager set|clear` 的真人授权要回读发起轮的飞书原消息，只接受明确的指令文本。
 * REST 回读里富文本编辑器的正文是 `<p>` 段落，判定必须与解析层看到的文本一致。
 *
 * Run: npx vitest run --project unit test/human-manager-authorization.test.ts
 */
import { describe, it, expect } from 'vitest';
import { authorizeHumanManager } from '../src/core/human-manager-authorization.js';

const TURN = 'om_turn1';
const CHAT = 'oc_chat';
const BOT = 'ou_bot';
const HUMAN = 'ou_human';
const ORIGIN = { capability: 'cap-1', turnId: TURN, dispatchAttempt: 1 };

function authorize(text: string, action: 'set' | 'clear' = 'set') {
  return authorizeHumanManager({
    sessionId: 'sess-1',
    appId: 'cli_app',
    chatId: CHAT,
    action,
    targetOpenId: BOT,
    claim: { originTurnId: TURN, originCapability: ORIGIN.capability, originDispatchAttempt: ORIGIN.dispatchAttempt },
    liveOrigin: () => ORIGIN,
    readMessage: async () => ({
      items: [{
        message_id: TURN,
        chat_id: CHAT,
        msg_type: 'text',
        sender: { sender_type: 'user', id_type: 'open_id', id: HUMAN },
        body: { content: JSON.stringify({ text }) },
        mentions: [{ key: '@_user_1', id: BOT, id_type: 'open_id', name: 'Bot' }],
      }],
    }),
    canOperate: () => true,
  });
}

describe('authorizeHumanManager: explicit instruction text', () => {
  it('accepts the plain live-event form', async () => {
    expect(await authorize('@_user_1 /manager set')).toMatchObject({ ok: true, requester: HUMAN });
  });

  it.each([
    ['<p>@_user_1 /manager set</p>', 'set'],
    ['<p>@_user_1 /manager clear</p>', 'clear'],
    ['<p>@_user_1 作为本群负责人</p>', 'set'],
  ] as const)('accepts the rich-text paragraph form: %s', async (text, action) => {
    expect(await authorize(text, action)).toMatchObject({ ok: true, requester: HUMAN });
  });

  it('still rejects a paragraph that is not an explicit instruction', async () => {
    expect(await authorize('<p>@_user_1 帮我看看这个群</p>')).toEqual({
      ok: false, error: 'explicit_manager_instruction_required',
    });
  });
});
