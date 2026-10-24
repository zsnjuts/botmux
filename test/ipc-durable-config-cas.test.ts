import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { setDurableConfigCoordinator } from '../src/services/durable-config-mutation.js';

let server: IpcServerHandle | undefined;
let dir = '';
const secret = 'durable-config-cas-test-secret';
const inspect = vi.fn();
const reconcile = vi.fn();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-config-cas-ipc-'));
  process.env.BOTMUX_GLOBAL_CONFIG_FILE = join(dir, 'config.json');
  writeFileSync(process.env.BOTMUX_GLOBAL_CONFIG_FILE, '{}\n');
  setLarkAppId('cli_configcas');
  setIpcAuthSecret(secret);
  inspect.mockResolvedValue({
    scope: 'global',
    status: 'content_drift',
    committedSha256: 'a'.repeat(64),
    fileSha256: 'b'.repeat(64),
    pathMatches: true,
  });
  reconcile.mockResolvedValue({
    scope: 'global',
    status: 'in_sync',
    committedSha256: 'b'.repeat(64),
    fileSha256: 'b'.repeat(64),
    pathMatches: true,
  });
  setDurableConfigCoordinator({ inspect, reconcile, run: vi.fn() } as any);
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  setIpcAuthSecret(null);
  setLarkAppId('');
  setDurableConfigCoordinator(undefined);
  inspect.mockReset();
  reconcile.mockReset();
  delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('durable config CAS IPC', () => {
  it('returns hash-only inspection through trusted host IPC', async () => {
    const response = await fetchDaemonIpc(
      server!.port,
      '/api/durable-config-cas?scope=global',
      { method: 'GET' },
      secret,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      inspection: expect.objectContaining({
        scope: 'global',
        status: 'content_drift',
        committedSha256: 'a'.repeat(64),
        fileSha256: 'b'.repeat(64),
      }),
    });
    expect(inspect).toHaveBeenCalledWith({
      scope: 'global',
      path: process.env.BOTMUX_GLOBAL_CONFIG_FILE,
    });
  });

  it('requires trusted host auth and two expected hashes for reconcile', async () => {
    const unsigned = await fetch(
      `http://127.0.0.1:${server!.port}/api/durable-config-cas?scope=global`,
      { method: 'GET' },
    );
    expect(unsigned.status).toBe(401);

    const missing = await fetchDaemonIpc(
      server!.port,
      '/api/durable-config-cas?scope=global',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      secret,
    );
    expect(missing.status).toBe(400);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('reconciles only the explicitly confirmed hash pair', async () => {
    const expectedCommittedSha256 = 'a'.repeat(64);
    const expectedFileSha256 = 'b'.repeat(64);
    const response = await fetchDaemonIpc(
      server!.port,
      '/api/durable-config-cas?scope=global',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedCommittedSha256, expectedFileSha256 }),
      },
      secret,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      inspection: { status: 'in_sync', committedSha256: expectedFileSha256 },
    });
    expect(reconcile).toHaveBeenCalledWith({
      scope: 'global',
      path: process.env.BOTMUX_GLOBAL_CONFIG_FILE,
      expectedCommittedSha256,
      expectedFileSha256,
    });
  });
});
