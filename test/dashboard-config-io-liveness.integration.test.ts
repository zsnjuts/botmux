import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { loopbackFetch } from '../src/core/loopback-fetch.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const DASHBOARD_ENTRY = resolve('src/index-dashboard.ts');

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  await closeServer(server);
  return port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      closed.then(() => 'closed' as const),
      new Promise<'timeout'>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout('timeout'), 5_000);
        timer.unref();
      }),
    ]);
    if (outcome === 'timeout' && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await closed;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(process.platform === 'win32')('dashboard config I/O liveness', () => {
  let child: ChildProcess | undefined;
  let root = '';

  afterEach(async () => {
    await stopChild(child);
    child = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('serves health and settings while bots.json and config.json opens remain blocked', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-dashboard-config-io-'));
    const homeDir = join(root, 'home');
    const botmuxDir = join(homeDir, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const registryDir = join(dataDir, 'dashboard-daemons');
    const botsPath = join(root, 'blocked-bots.json');
    const globalPath = join(root, 'blocked-config.json');
    mkdirSync(registryDir, { recursive: true });
    execFileSync('mkfifo', [botsPath]);
    execFileSync('mkfifo', [globalPath]);
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'dashboard-config-io-liveness-secret', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    const requestedPort = await reservePort();

    let stdout = '';
    let stderr = '';
    child = spawnTsScript(DASHBOARD_ENTRY, [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsPath,
        BOTMUX_GLOBAL_CONFIG_FILE: globalPath,
        BOTMUX_DASHBOARD_PORT: String(requestedPort),
        BOTMUX_DASHBOARD_HOST: '127.0.0.1',
        BOTMUX_DASHBOARD_PUBLIC_READONLY: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });

    const portPath = join(botmuxDir, '.dashboard-port');
    const deadline = Date.now() + 15_000;
    let port = 0;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`dashboard exited early\n${stdout}\n${stderr}`);
      }
      try {
        port = Number(readFileSync(portPath, 'utf8').trim());
        if (Number.isInteger(port) && port > 0) break;
      } catch {
      // 仍在启动
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    expect(port, `${stdout}\n${stderr}`).toBeGreaterThan(0);

    const health = await loopbackFetch(`http://127.0.0.1:${port}/__health`, {
      signal: AbortSignal.timeout(1_000),
    });
    expect(await health.json()).toEqual({ ok: true });

    // 这条路由同时读取 global 与 bot 设置；必须从内存投影取安全默认值，不能再去
    // open 两个已经阻塞的 FIFO。
    const settings = await loopbackFetch(`http://127.0.0.1:${port}/api/settings`, {
      signal: AbortSignal.timeout(1_000),
    });
    expect(settings.status, stderr).toBe(200);
    expect(await settings.json()).toMatchObject({
      authed: false,
      settings: { publicReadOnly: true },
    });
    expect(stderr).toContain('初始配置加载超过时限');
  }, 20_000);
});
