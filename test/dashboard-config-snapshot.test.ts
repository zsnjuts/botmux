import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardConfigSnapshotStore } from '../src/dashboard/config-snapshot.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';
import { installBotsJsonSnapshotStore, readBotsJsonOrEmpty, writeBotsJsonAtomic } from '../src/setup/bots-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-dashboard-config-snapshot-'));
  roots.push(root);
  return root;
}

describe('DashboardConfigSnapshotStore', () => {
  it('keeps health/event-loop work responsive when both config reads never settle', async () => {
    const log = { warn: vi.fn() };
    const store = new DashboardConfigSnapshotStore({
      botsPath: '/blocked/bots.json',
      globalPath: '/blocked/config.json',
      readBudgetMs: 20,
      readText: () => new Promise<string>(() => undefined),
      log,
    });

    // 启动 Dashboard 引导期同款的两个后台读取；两个存储 Promise 都永不结束。
    const prime = store.prime();
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bots: store.readBots().length }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as import('node:net').AddressInfo).port;

    try {
      const response = await loopbackFetch(`http://127.0.0.1:${port}/__health`, {
        signal: AbortSignal.timeout(500),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, bots: 0 });
      await expect(prime).resolves.toEqual({ bots: 'timed_out', global: 'timed_out' });
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 继续'));
    } finally {
      server.close();
      await once(server, 'close');
      store.stop();
    }
  });

  it('serves the seeded global config until a read completes, and keeps it while reads hang', async () => {
    const store = new DashboardConfigSnapshotStore({
      botsPath: '/blocked/bots.json',
      globalPath: '/blocked/config.json',
      readBudgetMs: 20,
      initialGlobal: { lang: 'en' },
      readText: () => new Promise<string>(() => undefined),
    });

    expect(store.readGlobal()).toEqual({ lang: 'en' });
    await expect(store.refreshGlobal()).resolves.toBe('timed_out');
    expect(store.readGlobal()).toEqual({ lang: 'en' });
  });

  it('allows only one blocked read per document instead of exhausting the worker pool', async () => {
    const calls = new Map<string, number>();
    const store = new DashboardConfigSnapshotStore({
      botsPath: '/blocked/bots.json',
      globalPath: '/blocked/config.json',
      readBudgetMs: 5,
      readText: path => {
        calls.set(path, (calls.get(path) ?? 0) + 1);
        return new Promise<string>(() => undefined);
      },
      log: { warn: vi.fn() },
    });

    await Promise.all([
      store.refreshBots(),
      store.refreshBots(),
      store.refreshGlobal(),
      store.refreshGlobal(),
    ]);

    expect(calls).toEqual(new Map([
      ['/blocked/bots.json', 1],
      ['/blocked/config.json', 1],
    ]));
  });

  it('keeps last-known-good snapshots after later read or parse failures', async () => {
    let fail = false;
    const store = new DashboardConfigSnapshotStore({
      botsPath: '/memory/bots.json',
      globalPath: '/memory/config.json',
      readText: async path => {
        if (fail) throw new Error('storage unavailable');
        if (path.endsWith('bots.json')) {
          return JSON.stringify([{ larkAppId: 'cli_test', larkAppSecret: 'secret', cliId: 'codex' }]);
        }
        return JSON.stringify({ lang: 'zh', dashboard: { publicReadOnly: true } });
      },
      log: { warn: vi.fn() },
    });

    await expect(store.prime()).resolves.toEqual({ bots: 'updated', global: 'updated' });
    expect(store.readBots().map(bot => bot.larkAppId)).toEqual(['cli_test']);
    expect(store.readGlobal()).toMatchObject({ lang: 'zh', dashboard: { publicReadOnly: true } });

    fail = true;
    await expect(store.refreshBots()).resolves.toBe('failed');
    await expect(store.refreshGlobal()).resolves.toBe('failed');
    expect(store.readBots().map(bot => bot.larkAppId)).toEqual(['cli_test']);
    expect(store.readGlobal()).toMatchObject({ lang: 'zh', dashboard: { publicReadOnly: true } });
  });

  it('writes global config asynchronously while preserving unknown fields and publishing one committed snapshot', async () => {
    const root = tempRoot();
    const globalPath = join(root, 'config.json');
    writeFileSync(globalPath, JSON.stringify({
      futureTopLevel: { keep: true },
      dashboard: { futureDashboardField: 'keep', publicReadOnly: false },
      codexNotifier: { futureNotifierField: 7, enabled: false },
    }));
    const store = new DashboardConfigSnapshotStore({
      botsPath: join(root, 'bots.json'),
      globalPath,
      botsFileEnabled: false,
      log: { warn: vi.fn() },
    });
    await store.prime();

    const previousMode = process.env.BOTMUX_COORDINATION_MODE;
    delete process.env.BOTMUX_COORDINATION_MODE;
    try {
      await store.runGlobalMutation(async () => {
        store.mergeDashboardConfig({ publicReadOnly: true });
        store.writeCodexNotifierConfig({ enabled: true, targetBotAppId: 'cli_test' });
        expect(store.readGlobal()).toMatchObject({
          dashboard: { publicReadOnly: true },
          codexNotifier: { enabled: true, targetBotAppId: 'cli_test' },
        });
      });
    } finally {
      if (previousMode === undefined) delete process.env.BOTMUX_COORDINATION_MODE;
      else process.env.BOTMUX_COORDINATION_MODE = previousMode;
    }

    const persisted = JSON.parse(readFileSync(globalPath, 'utf8'));
    expect(persisted).toEqual({
      futureTopLevel: { keep: true },
      dashboard: { futureDashboardField: 'keep', publicReadOnly: true },
      codexNotifier: { futureNotifierField: 7, enabled: true, targetBotAppId: 'cli_test' },
    });
    expect(statSync(globalPath).mode & 0o777).toBe(0o600);
    expect(store.readGlobal()).toMatchObject({
      dashboard: { publicReadOnly: true },
      codexNotifier: { enabled: true, targetBotAppId: 'cli_test' },
    });
  });

  it('adapts legacy synchronous bots.json callers to one async locked transaction', async () => {
    const root = tempRoot();
    const botsPath = join(root, 'bots.json');
    const initial = [{
      larkAppId: 'cli_test',
      larkAppSecret: 'secret',
      cliId: 'codex',
      futureField: { keep: true },
    }];
    writeFileSync(botsPath, JSON.stringify(initial));
    const store = new DashboardConfigSnapshotStore({
      botsPath,
      globalPath: join(root, 'config.json'),
      log: { warn: vi.fn() },
    });
    await store.prime();
    const dispose = installBotsJsonSnapshotStore({
      read: store.readRawBots,
      write: store.writeRawBots,
    });

    const previousMode = process.env.BOTMUX_COORDINATION_MODE;
    delete process.env.BOTMUX_COORDINATION_MODE;
    try {
      await store.runBotsMutation(async () => {
        const raw = readBotsJsonOrEmpty(botsPath);
        raw[0].displayName = 'Snapshot Bot';
        writeBotsJsonAtomic(botsPath, raw);
        // 旧同步接口立即看到事务草稿；异步 callback 成功前，文件仍未提交。
        expect(readBotsJsonOrEmpty(botsPath)[0].displayName).toBe('Snapshot Bot');
        expect(JSON.parse(readFileSync(botsPath, 'utf8'))[0].displayName).toBeUndefined();
      });
    } finally {
      dispose();
      if (previousMode === undefined) delete process.env.BOTMUX_COORDINATION_MODE;
      else process.env.BOTMUX_COORDINATION_MODE = previousMode;
    }

    expect(JSON.parse(readFileSync(botsPath, 'utf8'))).toEqual([{
      ...initial[0],
      displayName: 'Snapshot Bot',
    }]);
    expect(store.readBots()[0]).toMatchObject({
      larkAppId: 'cli_test',
      displayName: 'Snapshot Bot',
    });
  });
});
