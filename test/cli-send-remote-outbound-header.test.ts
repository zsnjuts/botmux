/**
 * Remote Runner interim sends (progress / auxiliary) are forbidden from
 * choosing a `--layout`, so without a host-supplied header they rendered
 * exactly like the turn's final reply card (Mew #81). Drive the real CLI send
 * path and inspect the card that would reach Lark.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { t } from '../src/i18n/index.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const key = { larkAppId: 'cli_test', sessionId: 'sid_remote', turnId: 'om_turn' };

function sendCard(args: string[], options: { remote?: boolean } = {}): any {
  const remote = options.remote ?? true;
  const root = mkdtempSync(join(tmpdir(), 'botmux-remote-outbound-header-'));
  const dataDir = join(root, 'data');
  try {
    const cliId = remote ? 'remote-runner' : 'codex';
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: key.larkAppId, larkAppSecret: 'test-secret', cliId,
    }]));
    seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
      sessionId: key.sessionId, status: 'active', cliId, larkAppId: key.larkAppId,
      chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
      // A host relay is trusted only as a direct child of the recorded worker.
      pid: process.pid,
      // The turn's human requester, so `--mention-back` has someone to @.
      replyTargets: { [key.turnId]: { updatedAt: new Date().toISOString(), senderOpenId: 'ou_requester',
        participants: [{ openId: 'ou_requester', isBot: false }] } },
      turnReplyContexts: { [key.turnId]: { replyTargetSenderOpenId: 'ou_requester', replyTargetSenderIsBot: false } },
    } });
    const contentFile = join(root, 'content.md');
    writeFileSync(contentFile, 'BODY');
    const result = spawnSyncTsScript(fixture, [
      'send', ...(remote ? ['--remote-runner-outbound'] : []), ...args,
      '--content-file', contentFile, '--session-id', key.sessionId,
    ], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
        BOTMUX_SESSION_ID: key.sessionId, BOTMUX_TURN_ID: key.turnId, BOTMUX_LARK_APP_ID: key.larkAppId,
        ...(remote ? { BOTMUX_HOST_RELAY_AUTHORIZED: '1' } : {}),
      },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status, String(result.stderr)).toBe(0);
    const captured = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='));
    expect(captured).toHaveLength(1);
    return JSON.parse(JSON.parse(captured[0]!.slice('CAPTURE_REPLY='.length)).body.content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Remote Runner outbound card header', () => {
  it.each([
    ['progress', '--mention-back', 'blue'],
    ['progress', '--no-mention', 'blue'],
    ['auxiliary', '--no-mention', 'grey'],
  ] as const)('marks a %s send (%s) as an interim update', (kind, mention, template) => {
    const card = sendCard(['--response-kind', kind, mention]);
    expect(card.header).toEqual({
      template,
      title: { tag: 'plain_text', content: t(`card.remote_outbound.${kind}_header`, undefined, 'zh') },
    });
    expect(JSON.stringify(card.body)).toContain('BODY');
    if (mention === '--mention-back') expect(JSON.stringify(card.body)).toContain('<at id=ou_requester>');
  });

  it('leaves the final reply headerless', () => {
    const card = sendCard(['--response-kind', 'final', '--mention-back']);
    expect(card.header).toBeUndefined();
    expect(JSON.stringify(card.body)).toContain('BODY');
  });

  it('does not add the header to an ordinary (non-remote) progress send', () => {
    const card = sendCard(['--response-kind', 'progress', '--no-mention'], { remote: false });
    expect(card.header).toBeUndefined();
  });
});
