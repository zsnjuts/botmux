import { mentionAppId, mentionOpenId, unwrapRichTextParagraphs } from './message-parser.js';

/**
 * Whether a Lark `text` message is exactly `/close` addressed to this bot:
 * once every mention of this bot is removed (`@Bot /close`, `/close @Bot`, or a
 * bare `/close`), nothing but `/close` may remain. A mention of anyone else or
 * any argument keeps the message outside the exact shape. Rich-text paragraph
 * bodies (`{"text":"<p>@_user_1 /close</p>"}`) are unwrapped first, exactly as
 * the message parser does, so they are judged like the plain live-event form.
 */
export function isExactTextCloseCommand(
  message: { message_type?: unknown; content?: unknown; mentions?: unknown } | null | undefined,
  self: { larkAppId: string; botOpenId?: string },
): boolean {
  if (message?.message_type !== 'text' || typeof message.content !== 'string') return false;
  let body: unknown;
  try { body = JSON.parse(message.content || '{}'); } catch { return false; }
  if (!body || typeof body !== 'object' || typeof (body as { text?: unknown }).text !== 'string') {
    return false;
  }
  let text = unwrapRichTextParagraphs((body as { text: string }).text);
  const mentions: any[] = Array.isArray(message.mentions) ? message.mentions : [];
  for (const mention of mentions) {
    const isSelf = (!!self.botOpenId && mentionOpenId(mention) === self.botOpenId)
      || mentionAppId(mention) === self.larkAppId;
    const key = typeof mention?.key === 'string' ? mention.key : '';
    if (!isSelf || !key) continue;
    text = text.split(key).join('');
  }
  return text.trim().toLowerCase() === '/close';
}
