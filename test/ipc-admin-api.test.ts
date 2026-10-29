import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lark = vi.hoisted(() => ({
  directory: new Map<string, string>([['alice@example.com', 'ou_admin'], ['bob@example.com', 'ou_bob']]),
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
});
