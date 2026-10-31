import { describe, expect, it } from 'vitest';
import {
  buildTurnTerminalFooterPatch,
  buildTurnTerminalReceiptCard,
} from '../src/im/lark/card-builder.js';
import { parseApiMessage } from '../src/im/lark/message-parser.js';

const COMPLETED_ZH = "<font color='green'>**✅ 本轮已完成 · 等待输入**</font>";
const SILENT_ZH = "<font color='grey'>**✓ 本轮已结束（AI 判断无需回复） · 等待输入**</font>";

function footerCard(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: '2.0', body: { elements: [
    { tag: 'markdown', content: 'answer body' },
    { tag: 'markdown', element_id: 'botmux_reply_footer', text_size: 'notation', content, ...extra },
  ] } });
}

describe('buildTurnTerminalReceiptCard', () => {
  it.each([
    ['completed', COMPLETED_ZH],
    ['silent', SILENT_ZH],
  ] as const)('renders a normal-size %s card', (kind, expected) => {
    const card = JSON.parse(buildTurnTerminalReceiptCard(kind, 'zh'));
    expect(card).toMatchObject({
      schema: '2.0',
      config: { width_mode: 'default' },
      body: {
        padding: '8px 12px 8px 12px',
        elements: [{ tag: 'markdown', content: expected }],
      },
    });
    expect(card.body.elements[0].text_size).toBeUndefined();
    expect(card.header).toBeUndefined();
  });

  it('localizes the label', () => {
    const card = JSON.parse(buildTurnTerminalReceiptCard('completed', 'en'));
    expect(card.body.elements[0].content).toBe("<font color='green'>**✅ Turn completed · Awaiting input**</font>");
  });
});

describe('buildTurnTerminalFooterPatch', () => {
  it('returns only footer content even when the provider readback has normalized the body', () => {
    const body = '- item**Next heading**\n- another item';
    const card = { schema: '2.0', body: { elements: [
      { tag: 'markdown', content: body },
      { tag: 'column_set', columns: [{ tag: 'column', elements: [{
        tag: 'markdown', element_id: 'botmux_reply_footer', content: 'brand · 发送给：<at id=ou_user></at>',
      }] }] },
      { tag: 'button', value: { action: 'feedback' } },
    ] } };
    const input = JSON.stringify(card);
    const patch = buildTurnTerminalFooterPatch(input, 'completed', 'zh');
    expect(patch).toEqual({ content: `brand · 发送给：<at id=ou_user></at> ${COMPLETED_ZH}` });
    expect(JSON.stringify(card)).toBe(input);
    expect(JSON.stringify(patch)).not.toContain(body);
    expect(buildTurnTerminalFooterPatch(JSON.stringify({ schema: '2.0', body: { elements: [{
      tag: 'markdown', element_id: 'botmux_reply_footer', ...patch,
    }] } }), 'completed', 'zh')).toEqual(patch);
  });

  it('puts the label outside the grey footer font so it is not rendered as grey chrome', () => {
    const footer = "<font color='grey'>botmux · 发送给：<at id=ou_user></at></font>";
    const patch = buildTurnTerminalFooterPatch(footerCard(footer), 'completed', 'zh');
    expect(patch).toEqual({ content: `${footer} ${COMPLETED_ZH}` });
    // A retry reads back the already-patched card: the same content again.
    expect(buildTurnTerminalFooterPatch(footerCard(patch!.content), 'completed', 'zh')).toEqual(patch);
    // A later kind replaces the earlier label instead of stacking a second one.
    expect(buildTurnTerminalFooterPatch(footerCard(patch!.content), 'silent', 'zh'))
      .toEqual({ content: `${footer} ${SILENT_ZH}` });
  });

  it('tolerates a readback that dropped the quotes or bold markers of the label', () => {
    const footer = "<font color='grey'>botmux · 发送给：<at id=ou_user></at></font>";
    for (const readback of [
      `${footer} <font color="green">**✅ 本轮已完成 · 等待输入**</font>`,
      `${footer} <font color=green>✅ 本轮已完成 · 等待输入</font>`,
    ]) {
      expect(buildTurnTerminalFooterPatch(footerCard(readback), 'completed', 'zh'))
        .toEqual({ content: `${footer} ${COMPLETED_ZH}` });
    }
  });

  it.each([
    ['inside the grey footer font', "<font color='grey'>botmux · 发送给：<at id=ou_user></at> · ✓ 本轮已结束 · 等待输入</font>"],
    ['inside, silent wording', "<font color='grey'>botmux · 发送给：<at id=ou_user></at> · ✓ 本轮已结束（AI 判断无需回复） · 等待输入</font>"],
    ['inside, English wording', "<font color='grey'>botmux · 发送给：<at id=ou_user></at> · ✓ Turn ended · Awaiting input</font>"],
  ])('strips a legacy grey label (%s) on re-patch', (_name, legacy) => {
    expect(buildTurnTerminalFooterPatch(footerCard(legacy), 'completed', 'zh')).toEqual({
      content: `<font color='grey'>botmux · 发送给：<at id=ou_user></at></font> ${COMPLETED_ZH}`,
    });
  });

  it('strips a legacy grey label appended after an uncoloured footer', () => {
    const legacy = "brand · 发送给：<at id=ou_user></at> · <font color='grey'>✓ 本轮已结束 · 等待输入</font>";
    expect(buildTurnTerminalFooterPatch(footerCard(legacy), 'completed', 'zh')).toEqual({
      content: `brand · 发送给：<at id=ou_user></at> ${COMPLETED_ZH}`,
    });
  });

  it.each(['not json', '{}', JSON.stringify({ schema: '2.0', body: { elements: [] } }),
    JSON.stringify({ schema: '2.0', body: { elements: [{ element_id: 'botmux_reply_footer', content: '' }] } }),
  ])('declines a missing or invalid footer: %s', input => {
    expect(buildTurnTerminalFooterPatch(input, 'completed', 'zh')).toBeUndefined();
  });
});

describe('patched footer stays recognizable as botmux chrome', () => {
  // Signed footer: brand + invisible marker + recipient, exactly as md-card emits it.
  const footer = "<font color='grey'>botmux ·\u2063\u2063\u2063\u2063 发送给：<at id=ou_user></at></font>";
  const patched = () => buildTurnTerminalFooterPatch(footerCard(footer), 'completed', 'zh')!.content;
  const apiMessage = (content: string) => ({
    message_id: 'om_card', msg_type: 'interactive', create_time: '1',
    sender: { id: 'cli_bot', sender_type: 'app' }, body: { content },
  });

  it('drops the footer and label from a schema 2.0 card', () => {
    const parsed = parseApiMessage(apiMessage(footerCard(patched()))).content;
    expect(parsed).toBe('answer body');
  });

  it('drops the footer line and label from a provider-rendered card', () => {
    const parsed = parseApiMessage(apiMessage(`<card>\nanswer body\n${patched()}\n</card>`)).content;
    expect(parsed).toBe('answer body');
  });
});
