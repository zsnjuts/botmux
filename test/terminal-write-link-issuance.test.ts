import { describe, expect, it } from 'vitest';
import {
  WRITE_LINK_ISSUANCE_PARAM,
  verifyWriteLinkIssuance,
  withWriteLinkIssuance,
} from '../src/core/terminal-write-link-issuance.js';

const SECRET = 'host-secret';
const OPEN_ID = 'ou_0123456789abcdef';

function issued(url = 'https://bot.example.test/s/sess-1?token=w') {
  return new URL(withWriteLinkIssuance(url, SECRET, 'sess-1', OPEN_ID, 1_700_000_000_000));
}

describe('write link issuance', () => {
  it('names the recipient on the link and keeps the write capability as is', () => {
    const url = issued();
    expect(url.searchParams.get('token')).toBe('w');
    expect(verifyWriteLinkIssuance(SECRET, 'sess-1', url.searchParams.get(WRITE_LINK_ISSUANCE_PARAM)))
      .toBe(OPEN_ID);
  });

  it('rejects a recipient that was edited, signed for another session or by another host', () => {
    const value = issued().searchParams.get(WRITE_LINK_ISSUANCE_PARAM)!;
    const forged = value.replace(OPEN_ID, 'ou_fedcba9876543210');
    expect(verifyWriteLinkIssuance(SECRET, 'sess-1', forged)).toBeUndefined();
    expect(verifyWriteLinkIssuance(SECRET, 'sess-2', value)).toBeUndefined();
    expect(verifyWriteLinkIssuance('other-secret', 'sess-1', value)).toBeUndefined();
    expect(verifyWriteLinkIssuance(SECRET, 'sess-1', null)).toBeUndefined();
    expect(verifyWriteLinkIssuance(SECRET, 'sess-1', `${value}x`)).toBeUndefined();
  });

  it('leaves the link untouched when the recipient is not an open_id', () => {
    const url = 'https://bot.example.test/s/sess-1?token=w';
    expect(withWriteLinkIssuance(url, SECRET, 'sess-1', 'someone@example.test')).toBe(url);
    expect(withWriteLinkIssuance('not a url', SECRET, 'sess-1', OPEN_ID)).toBe('not a url');
  });
});
