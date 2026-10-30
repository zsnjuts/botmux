/**
 * 文字 `/close` 是否「恰好是发给本 bot 的关闭」——durable-primary 下只有命中它的
 * 消息才进持久关闭通道，判错就会落到本地关闭的拒绝分支。
 *
 * Run: npx vitest run --project unit test/exact-close-command.test.ts
 */
import { describe, it, expect } from 'vitest';
import { isExactTextCloseCommand } from '../src/im/lark/exact-close-command.js';

const SELF = { larkAppId: 'cli_self', botOpenId: 'ou_self' };
const SELF_MENTION = { key: '@_user_1', name: 'SelfBot', id: { open_id: 'ou_self' }, id_type: 'open_id' };
const OTHER_MENTION = { key: '@_user_2', name: 'Someone', id: { open_id: 'ou_other' }, id_type: 'open_id' };

function textMessage(text: string, mentions: unknown[] = [SELF_MENTION]) {
  return { message_type: 'text', content: JSON.stringify({ text }), mentions };
}

describe('isExactTextCloseCommand', () => {
  it.each([
    '@_user_1 /close',
    '/close @_user_1',
    '/CLOSE',
  ])('accepts the plain live-event form: %s', text => {
    expect(isExactTextCloseCommand(textMessage(text), SELF)).toBe(true);
  });

  // 富文本编辑器把 text 正文存成 <p> 段落；不解包时剥掉 @ 后剩 `<p> /close</p>`。
  it.each([
    '<p>@_user_1 /close</p>',
    '<p>/close @_user_1</p>',
    '<p>@_user_1</p><p>/close</p>',
  ])('accepts the rich-text paragraph form: %s', text => {
    expect(isExactTextCloseCommand(textMessage(text), SELF)).toBe(true);
  });

  it('recognises this bot addressed by app_id as well', () => {
    const appIdMention = { key: '@_user_1', name: 'SelfBot', id: { app_id: 'cli_self' }, id_type: 'app_id' };
    expect(isExactTextCloseCommand(textMessage('<p>@_user_1 /close</p>', [appIdMention]), SELF)).toBe(true);
  });

  it.each([
    ['an argument', '<p>@_user_1 /close wt</p>', [SELF_MENTION]],
    ['another member mentioned', '<p>@_user_1 /close @_user_2</p>', [SELF_MENTION, OTHER_MENTION]],
    ['only another member mentioned', '<p>@_user_2 /close</p>', [OTHER_MENTION]],
    ['extra prose around the paragraphs', '<p>@_user_1 /close</p> 谢谢', [SELF_MENTION]],
  ])('rejects %s', (_label, text, mentions) => {
    expect(isExactTextCloseCommand(textMessage(text as string, mentions as unknown[]), SELF)).toBe(false);
  });

  it('rejects non-text messages and malformed bodies', () => {
    expect(isExactTextCloseCommand({ ...textMessage('/close'), message_type: 'post' }, SELF)).toBe(false);
    expect(isExactTextCloseCommand({ message_type: 'text', content: 'not json', mentions: [] }, SELF)).toBe(false);
    expect(isExactTextCloseCommand(undefined, SELF)).toBe(false);
  });
});
