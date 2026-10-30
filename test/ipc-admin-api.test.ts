import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lark = vi.hoisted(() => ({
  directory: new Map<string, string>([['alice@example.com', 'ou_admin'], ['bob@example.com', 'ou_bob']]),
  chats: new Map<string, Array<{ openId: string; name?: string }>>(),
  profiles: new Map<string, { status: string; profile?: { name: string } }>(),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    resolveAllowedUsersWithMap: async (_app: string, raw: string[]) => {
      const map = new Map<string, string>();
      for (const entry of raw) {
        const openId = entry.startsWith('ou_') ? entry : lark.directory.get(entry);
        if (openId) map.set(entry, openId);
      }
      return { resolved: [...new Set(map.values())], map, entryStatus: new Map(), definitiveMisses: [] };
    },
    listChatUserMembers: async (_app: string, chatId: string) => {
      const members = lark.chats.get(chatId);
      if (!members) throw new Error('bot is not in this chat');
      return members;
    },
    getUserProfileStrict: async (_app: string, openId: string) =>
      lark.profiles.get(openId) ?? { status: 'ok', profile: { name: `name-${openId}` } },
  };
});

import { __testOnly_resetBotRegistry, getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { createDurableConfigCoordinator } from '../src/services/durable-config-coordinator.js';
import { setDurableConfigCoordinator } from '../src/services/durable-config-mutation.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';

const APP = 'cli_admin_api_test';
const secret = 'admin-api-test-secret';
let dir = '';
let configPath = '';
let server: IpcServerHandle | undefined;
let store: SqliteDurableCoordinationStore | undefined;
let previousBotsConfig: string | undefined;

const call = async (op: string, body: Record<string, unknown>, trusted = true) => {
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const response = trusted
    ? await fetchDaemonIpc(server!.port, `/api/admin/v1/${op}`, init, secret)
    : await fetch(`http://127.0.0.1:${server!.port}/api/admin/v1/${op}`, init);
  return { status: response.status, body: await response.json() as Record<string, any> };
};
const alice = { identity: { email: 'alice@example.com', username: 'alice' } };
const persisted = () => JSON.parse(readFileSync(configPath, 'utf8'))[0] as Record<string, unknown>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ipc-admin-api-'));
  configPath = join(dir, 'bots.json');
  previousBotsConfig = process.env.BOTS_CONFIG;
  process.env.BOTS_CONFIG = configPath;
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_admin'],
  }], null, 2));
  __testOnly_resetBotRegistry();
  loadBotConfigs().forEach((c: any) => registerBot(c));
  getBot(APP).resolvedAllowedUsers = ['ou_admin'];
  setLarkAppId(APP);
  setIpcAuthSecret(secret);
  store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'));
  setDurableConfigCoordinator(createDurableConfigCoordinator({ store, ownerId: 'config-daemon:test' }));
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  setDurableConfigCoordinator(undefined);
  await store?.close();
  setIpcAuthSecret(null);
  setLarkAppId('');
  if (previousBotsConfig === undefined) delete process.env.BOTS_CONFIG;
  else process.env.BOTS_CONFIG = previousBotsConfig;
  rmSync(dir, { recursive: true, force: true });
});

describe('admin API over daemon IPC', () => {
  it('refuses callers that are not the trusted host', async () => {
    await expect(call('whoami', alice, false)).resolves.toMatchObject({ status: 401 });
  });

  it('admits only allowedUsers members of this bot', async () => {
    await expect(call('whoami', alice)).resolves.toMatchObject({
      status: 200,
      body: { ok: true, admin: true, openId: 'ou_admin', bot: { larkAppId: APP } },
    });
    await expect(call('whoami', { identity: { email: 'bob@example.com' } }))
      .resolves.toEqual({ status: 403, body: { ok: false, error: 'not_admin' } });
    await expect(call('config-set', { identity: { email: 'bob@example.com' }, field: 'maxLiveWorkers', value: '9' }))
      .resolves.toMatchObject({ status: 403 });
    expect(persisted()).not.toHaveProperty('maxLiveWorkers');
  });

  it('writes a field through the durable CAS and attributes it to the person', async () => {
    const set = await call('config-set', { ...alice, field: 'maxLiveWorkers', value: '6' });
    expect(set).toMatchObject({ status: 200, body: { ok: true, field: 'maxLiveWorkers', new: '6' } });
    expect(persisted().maxLiveWorkers).toBe(6);

    const cas = await call('config-cas', { ...alice, scope: 'bots' });
    expect(cas.status).toBe(200);
    expect(cas.body.inspection).toMatchObject({ scope: 'bots', status: 'in_sync' });
    expect(cas.body.history.audit.at(-1)).toMatchObject({
      outcome: 'committed',
      actor: { via: 'infrabuddy', id: 'alice@example.com' },
      changedPaths: [`${APP}.maxLiveWorkers`],
    });
  });

  it('rejects invalid values without touching bots.json', async () => {
    const before = readFileSync(configPath, 'utf8');
    await expect(call('config-set', { ...alice, field: 'maxLiveWorkers', value: '0' }))
      .resolves.toMatchObject({ status: 400, body: { ok: false, error: 'invalid_number' } });
    await expect(call('config-set', { ...alice, field: 'noSuchField', value: '1' }))
      .resolves.toMatchObject({ status: 400, body: { ok: false, error: 'unknown_field' } });
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('replaces allowedUsers only with confirmation and never locks the caller out', async () => {
    await expect(call('config-set', { ...alice, field: 'allowedUsers', value: ['ou_admin', 'bob@example.com'] }))
      .resolves.toMatchObject({ status: 409, body: { error: 'confirm_required' } });
    await expect(call('config-set', { ...alice, field: 'allowedUsers', value: ['bob@example.com'], confirm: true }))
      .resolves.toMatchObject({ status: 409, body: { error: 'self_lockout' } });
    expect(persisted().allowedUsers).toEqual(['ou_admin']);

    await expect(call('config-set', { ...alice, field: 'allowedUsers', value: ['ou_admin', 'bob@example.com'], confirm: true }))
      .resolves.toMatchObject({ status: 200, body: { ok: true, resolved: 2 } });
    expect(persisted().allowedUsers).toEqual(['ou_admin', 'bob@example.com']);
    expect(getBot(APP).resolvedAllowedUsers).toEqual(['ou_admin', 'ou_bob']);
  });

  it('lists the current settings', async () => {
    const got = await call('config-get', alice);
    expect(got.status).toBe(200);
    expect(got.body.rows).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'maxLiveWorkers' })]));
  });
  describe('grants', () => {
    const team = [{ openId: 'ou_t1', name: 'T1' }, { openId: 'ou_t2', name: 'T2' }, { openId: 'ou_admin', name: 'Alice' }];
    const auditLength = async () => (await call('config-cas', { ...alice, scope: 'bots' })).body.history.audit.length as number;

    beforeEach(() => {
      lark.chats.set('oc_team', team);
      lark.profiles.clear();
    });

    it('previews a grant from a chat without writing anything', async () => {
      const before = readFileSync(configPath, 'utf8');
      const got = await call('grants-add', { ...alice, subjects: { chats: ['oc_team'] }, dryRun: true });
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({
        dryRun: true, expiresAt: null, quota: null,
        counts: { created: 2, updated: 0, unchanged: 0, skipped: 1, unresolved: 0 },
        skipped: [{ openId: 'ou_admin', reason: 'admin' }],
      });
      expect(readFileSync(configPath, 'utf8')).toBe(before);
    });

    it('grants a whole chat globally in one CAS write attributed to the admin', async () => {
      const auditBefore = await auditLength();
      const got = await call('grants-add', { ...alice, subjects: { chats: ['oc_team'], users: ['bob@example.com'] } });
      expect(got).toMatchObject({ status: 200, body: { ok: true, dryRun: false, counts: { created: 3, skipped: 1 } } });
      expect(persisted().globalGrants).toEqual(['ou_t1', 'ou_t2', 'ou_bob']);
      expect(persisted()).not.toHaveProperty('quotaState');
      expect(persisted()).not.toHaveProperty('grantExpiryState');
      expect(persisted().allowedUsers).toEqual(['ou_admin']);
      expect(getBot(APP).config.globalGrants).toEqual(['ou_t1', 'ou_t2', 'ou_bob']);

      const cas = await call('config-cas', { ...alice, scope: 'bots' });
      expect(cas.body.history.audit.length).toBe(auditBefore + 1);
      expect(cas.body.history.audit.at(-1)).toMatchObject({
        outcome: 'committed', actor: { via: 'infrabuddy', id: 'alice@example.com' },
      });

      // Running it again changes nothing and writes nothing.
      const again = await call('grants-add', { ...alice, subjects: { chats: ['oc_team'] } });
      expect(again.body.counts).toMatchObject({ created: 0, unchanged: 2 });
      expect(await auditLength()).toBe(auditBefore + 1);
    });

    it('stores a timed, metered grant when asked', async () => {
      const before = Date.now();
      const got = await call('grants-add', { ...alice, subjects: { chats: ['oc_team'] }, durationMs: 86_400_000, quota: 10 });
      expect(got.status).toBe(200);
      const expiry = (persisted().grantExpiryState as Record<string, { expiresAt: number }>)['global:ou_t1'].expiresAt;
      expect(expiry).toBeGreaterThanOrEqual(before + 86_400_000);
      expect((persisted().quotaState as Record<string, unknown>)['global:ou_t1']).toEqual({ limit: 10, used: 0 });
    });

    it('refuses open ids from another app and chats the bot cannot read', async () => {
      lark.profiles.set('ou_foreign', { status: 'cross_app' });
      const got = await call('grants-add', { ...alice, subjects: { chats: ['oc_unknown'], openIds: ['ou_foreign'] } });
      expect(got.status).toBe(200);
      expect(got.body.unresolved).toEqual([
        { input: 'oc_unknown', reason: 'chat_members_unavailable', detail: 'bot is not in this chat' },
        { input: 'ou_foreign', reason: 'cross_app_open_id' },
      ]);
      expect(persisted()).not.toHaveProperty('globalGrants');
    });

    it('lets only admins grant', async () => {
      await expect(call('grants-add', { identity: { email: 'bob@example.com' }, subjects: { chats: ['oc_team'] } }))
        .resolves.toEqual({ status: 403, body: { ok: false, error: 'not_admin' } });
      expect(persisted()).not.toHaveProperty('globalGrants');
    });

    it('lists, prunes invalid entries and removes grants in bulk', async () => {
      await call('grants-add', { ...alice, subjects: { chats: ['oc_team'] } });
      // An entry copied from another app sits in the list but never matches anyone.
      writeFileSync(configPath, JSON.stringify([{ ...persisted(), globalGrants: ['ou_t1', 'ou_t2', 'ou_foreign'] }], null, 2));
      getBot(APP).config.globalGrants = ['ou_t1', 'ou_t2', 'ou_foreign'];
      lark.profiles.set('ou_foreign', { status: 'cross_app' });

      const listed = await call('grants-list', alice);
      expect(listed.body.global).toEqual([
        { openId: 'ou_t1', name: 'name-ou_t1', status: 'ok', expiresAt: null, quota: null },
        { openId: 'ou_t2', name: 'name-ou_t2', status: 'ok', expiresAt: null, quota: null },
        { openId: 'ou_foreign', status: 'cross_app', expiresAt: null, quota: null },
      ]);
      expect(listed.body.admins).toBe(1);
    });

    it('removes grants in bulk and prunes entries that belong to another app', async () => {
      await call('grants-add', { ...alice, subjects: { chats: ['oc_team'] } });
      const removed = await call('grants-remove', { ...alice, subjects: { openIds: ['ou_t1', 'ou_never'] } });
      expect(removed.body).toMatchObject({
        removed: [{ openId: 'ou_t1' }], absent: [{ openId: 'ou_never' }],
      });
      expect(persisted().globalGrants).toEqual(['ou_t2']);

      lark.profiles.set('ou_t2', { status: 'cross_app' });
      const preview = await call('grants-prune', { ...alice, dryRun: true });
      expect(preview.body).toMatchObject({ dryRun: true, invalid: [{ openId: 'ou_t2', status: 'cross_app' }], removed: [] });
      expect(persisted().globalGrants).toEqual(['ou_t2']);
      const pruned = await call('grants-prune', alice);
      expect(pruned.body.removed).toEqual(['ou_t2']);
      expect(persisted()).not.toHaveProperty('globalGrants');
      expect(persisted().allowedUsers).toEqual(['ou_admin']);
    });
  });
});
