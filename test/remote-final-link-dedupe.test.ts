import { describe, expect, it } from 'vitest';
import {
  RemoteFinalLinkLedger,
  dedupeRemoteFinalLinks,
  outboundLinksReachedRequester,
  outboundMessageLinkUrls,
  type RemoteFinalLinkHints,
} from '../src/services/remote-final-link-dedupe.js';

const AUTH = 'https://accounts.example.com/oauth/device/verify?flow_id=f1&user_code=ABCD-EFGH';
const DOC = 'https://docs.example.com/wiki/Plan';

const hints: RemoteFinalLinkHints = {
  bare: '<SENT>',
  labeled: label => `${label}<SENT>`,
};

function dedupe(finalText: string, delivered: string[] = [AUTH]): string {
  return dedupeRemoteFinalLinks(finalText, new Set(delivered), hints);
}

describe('dedupeRemoteFinalLinks', () => {
  it('replaces a bare URL that was already delivered to the requester', () => {
    expect(dedupe(`请打开 ${AUTH} 完成授权`)).toBe('请打开 <SENT> 完成授权');
  });

  it('keeps trailing punctuation outside the replaced URL', () => {
    expect(dedupe(`授权链接：${AUTH}。`)).toBe('授权链接：<SENT>。');
    expect(dedupe(`Open ${AUTH}.`)).toBe('Open <SENT>.');
    expect(dedupe(`（见 ${AUTH}）`)).toBe('（见 <SENT>）');
    expect(dedupe(`(see ${AUTH})`)).toBe('(see <SENT>)');
  });

  it('keeps the label of a Markdown link and drops only the destination', () => {
    expect(dedupe(`请点击[授权链接](${AUTH})后回复我`)).toBe('请点击授权链接<SENT>后回复我');
    expect(dedupe(`[授权](<${AUTH}> "飞书授权")`)).toBe('授权<SENT>');
  });

  it('uses the bare hint when the Markdown label is the URL itself', () => {
    expect(dedupe(`[${AUTH}](${AUTH})`)).toBe('<SENT>');
  });

  it('handles balanced parentheses inside a Markdown destination', () => {
    const url = 'https://en.example.org/wiki/Foo_(bar)';
    expect(dedupe(`[Foo](${url}) 已更新`, [url])).toBe('Foo<SENT> 已更新');
  });

  it('replaces a <url> autolink together with its brackets', () => {
    expect(dedupe(`链接 <${AUTH}> 已发`)).toBe('链接 <SENT> 已发');
  });

  it('leaves fenced code blocks and inline code untouched', () => {
    const fenced = ['```', `curl ${AUTH}`, '```'].join('\n');
    expect(dedupe(fenced)).toBe(fenced);
    const inline = `运行 \`open ${AUTH}\` 即可`;
    expect(dedupe(inline)).toBe(inline);
    expect(dedupe(`${fenced}\n然后打开 ${AUTH}`)).toBe(`${fenced}\n然后打开 <SENT>`);
  });

  it('keeps URLs that were not delivered, including near-identical ones', () => {
    const text = `新文档 ${DOC}，授权 ${AUTH}&retry=1`;
    expect(dedupe(text)).toBe(text);
    expect(dedupe(`文档 ${DOC} 与授权 ${AUTH}`)).toBe(`文档 ${DOC} 与授权 <SENT>`);
  });

  it('leaves Markdown images alone', () => {
    const image = `![截图](${AUTH})`;
    expect(dedupe(image)).toBe(image);
  });

  it('returns the original text when there is nothing to compare against', () => {
    const text = `授权 ${AUTH}`;
    expect(dedupeRemoteFinalLinks(text, undefined, hints)).toBe(text);
    expect(dedupeRemoteFinalLinks(text, new Set(), hints)).toBe(text);
  });

  it('fails open when the rewrite would leave nothing visible', () => {
    const empty: RemoteFinalLinkHints = { bare: '', labeled: () => ' ' };
    expect(dedupeRemoteFinalLinks(AUTH, new Set([AUTH]), empty)).toBe(AUTH);
    expect(dedupeRemoteFinalLinks(`[授权](${AUTH})`, new Set([AUTH]), empty)).toBe(`[授权](${AUTH})`);
  });
});

describe('outboundMessageLinkUrls', () => {
  it('collects bare and Markdown destinations once each, without trailing punctuation', () => {
    expect(outboundMessageLinkUrls(
      `请点击[授权](${AUTH})。备用：${AUTH}，文档 ${DOC}.`,
    )).toEqual([AUTH, DOC]);
  });

  it('reads the destination, not the label, of a URL-labelled Markdown link', () => {
    expect(outboundMessageLinkUrls(`[${DOC}](${AUTH})`)).toEqual([AUTH]);
  });
});

describe('outboundLinksReachedRequester', () => {
  const delivered = { outcome: 'delivered' as const, messageId: 'om_1' };

  it('counts only a delivered non-final message that mentioned the requester', () => {
    expect(outboundLinksReachedRequester({ responseKind: 'progress', mention: 'requester' }, delivered)).toBe(true);
    expect(outboundLinksReachedRequester({ responseKind: 'auxiliary', mention: 'requester' }, delivered)).toBe(true);
    expect(outboundLinksReachedRequester({ responseKind: 'progress', mention: 'none' }, delivered)).toBe(false);
    expect(outboundLinksReachedRequester({ responseKind: 'progress', mention: 'explicit' }, delivered)).toBe(false);
    expect(outboundLinksReachedRequester({ responseKind: 'final', mention: 'requester' }, delivered)).toBe(false);
    expect(outboundLinksReachedRequester(
      { responseKind: 'progress', mention: 'requester' },
      { outcome: 'unknown', code: 'outbound_delivery_unknown', message: 'x' },
    )).toBe(false);
    expect(outboundLinksReachedRequester(
      { responseKind: 'progress', mention: 'requester' },
      { outcome: 'rejected', code: 'outbound_rejected', message: 'x' },
    )).toBe(false);
  });
});

describe('RemoteFinalLinkLedger', () => {
  it('scopes links to the exact turn and dispatch attempt', () => {
    const ledger = new RemoteFinalLinkLedger();
    ledger.record('om_turn', 1, `授权 ${AUTH}`);
    expect([...ledger.deliveredUrls('om_turn', 1) ?? []]).toEqual([AUTH]);
    expect(ledger.deliveredUrls('om_turn', 2)).toBeUndefined();
    expect(ledger.deliveredUrls('om_turn', undefined)).toBeUndefined();
    expect(ledger.deliveredUrls('om_other', 1)).toBeUndefined();
    ledger.clear('om_turn', 1);
    expect(ledger.deliveredUrls('om_turn', 1)).toBeUndefined();
  });

  it('accumulates across sends of one turn and ignores link-free messages', () => {
    const ledger = new RemoteFinalLinkLedger();
    ledger.record('om_turn', undefined, '先说一句，没有链接');
    expect(ledger.deliveredUrls('om_turn', undefined)).toBeUndefined();
    ledger.record('om_turn', undefined, `授权 ${AUTH}`);
    ledger.record('om_turn', undefined, `文档 ${DOC}`);
    expect([...ledger.deliveredUrls('om_turn', undefined) ?? []]).toEqual([AUTH, DOC]);
  });

  it('stays bounded in turns (oldest first) and in links per turn', () => {
    const ledger = new RemoteFinalLinkLedger(2, 1);
    ledger.record('om_a', 1, AUTH);
    ledger.record('om_b', 1, AUTH);
    ledger.record('om_c', 1, `${AUTH} ${DOC}`);
    expect(ledger.deliveredUrls('om_a', 1)).toBeUndefined();
    expect(ledger.deliveredUrls('om_b', 1)?.size).toBe(1);
    expect([...ledger.deliveredUrls('om_c', 1) ?? []]).toEqual([AUTH]);
  });
});
