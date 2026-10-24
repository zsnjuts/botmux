import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FleetSupervisor,
  dashboardStartupTimeoutMs,
  pidAlive,
  probeDashboardStartupReadiness,
  type FleetBotSpec,
} from '../src/core/fleet-supervisor.js';
import {
  DASHBOARD_STARTUP_NONCE_ENV,
  resolveDashboardSelfNonce,
} from '../src/core/dashboard-startup-readiness.js';
import { readFleetState } from '../src/core/fleet-state-store.js';
import { resolveEntrySpawn, entryForSubcommand, ENTRY_SUBCOMMANDS } from '../src/core/self-spawn.js';
import { resolveDashboardSpec, resolveFleetMembers, DASHBOARD_PROCESS_NAME } from '../src/core/fleet-runtime.js';

/**
 * Regression guard for the dashboard launcher under the built-in supervisor
 * (replaces the pm2-era `index-dashboard-entry.test.ts` pin that asserted the
 * pm2 ecosystem `botmux-dashboard` app). The pm2→supervisor migration deleted
 * ecosystemConfig — the dashboard's ONLY launch path under pm2 — so without a
 * replacement the dashboard never starts on `botmux start`/`restart` and the
 * whole web control plane (Agent Workbench, web terminal, H5 login) is dead.
 * These pins keep the supervisor owning the dashboard as a first-class fleet
 * member with the same crash-restart / graceful-exit machinery as a bot daemon.
 */

const dirs: string[] = [];
const procs: ChildProcess[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'dash-launch-')); dirs.push(d); return d; }
afterEach(() => {
  for (const p of procs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (fn()) return true; await delay(50); }
  return fn();
}

/** Fake dist whose index-dashboard.js behaves per body, so the supervisor's real
 *  `node dist/index-dashboard.js` spawn (resolveEntrySpawn('dashboard')) runs. */
function fakeDist(root: string, dashboardBody: string): string {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index-dashboard.js'), dashboardBody);
  return dist;
}

const STAY_DASHBOARD = `
// A dashboard that stays up until SIGTERM, exiting 90 (the graceful sentinel).
console.log('dashboard pid=' + process.pid + ' idx=' + process.env.BOTMUX_BOT_INDEX);
process.on('SIGTERM', () => process.exit(90));
setInterval(() => {}, 1000);
`;

const CRASH_DASHBOARD = `
// A dashboard that crashes immediately, to exercise crash-restart.
process.exit(1);
`;

describe('dashboard launcher — wiring (pure, no HOME)', () => {
  it('resolveDashboardSpec is a dashboard-entry member named botmux-dashboard, no bot index', () => {
    const spec = resolveDashboardSpec();
    expect(spec.name).toBe('botmux-dashboard');
    expect(DASHBOARD_PROCESS_NAME).toBe('botmux-dashboard');
    expect(spec.entry).toBe('dashboard');
    expect(spec.logBaseName).toBe('dashboard');
    // Not a bot: no appId, and its index is never used (entry !== 'daemon').
    expect(spec.appId).toBe('');
  });

  it('resolveFleetMembers always includes the dashboard (mirrors pm2 always-on app)', () => {
    // resolveFleetBots is HOME-dependent (bots.json), but the dashboard is
    // appended unconditionally — so whatever the bot set, the dashboard is a
    // supervised member. This is the pin that would have caught the P0.
    const members = resolveFleetMembers();
    const dash = members.filter((m) => m.name === 'botmux-dashboard');
    expect(dash).toHaveLength(1);
    expect(dash[0].entry).toBe('dashboard');
  });

  it('resolveEntrySpawn("dashboard") targets index-dashboard.js on the Node path', () => {
    const { command, args } = resolveEntrySpawn('dashboard', '/somewhere/dist');
    expect(command).toBe(process.execPath);
    expect(args).toEqual([join('/somewhere/dist', 'index-dashboard.js')]);
  });

  it('the __dashboard self-spawn token round-trips to the dashboard entry', () => {
    expect(ENTRY_SUBCOMMANDS.has('__dashboard')).toBe(true);
    expect(entryForSubcommand('__dashboard')).toBe('dashboard');
  });

  it('bounds the configurable dashboard startup readiness timeout', () => {
    expect(dashboardStartupTimeoutMs({ BOTMUX_DASHBOARD_STARTUP_TIMEOUT_MS: '12000' })).toBe(12_000);
    expect(dashboardStartupTimeoutMs({ BOTMUX_DASHBOARD_STARTUP_TIMEOUT_MS: '9999' })).toBe(90_000);
    expect(dashboardStartupTimeoutMs({ BOTMUX_DASHBOARD_STARTUP_TIMEOUT_MS: 'oops' })).toBe(90_000);
  });

  it('uses the supervisor nonce for Dashboard self-identification and rejects malformed values', () => {
    const supplied = '0123456789abcdef0123456789abcdef';
    expect(resolveDashboardSelfNonce({ [DASHBOARD_STARTUP_NONCE_ENV]: supplied })).toBe(supplied);
    expect(resolveDashboardSelfNonce({ [DASHBOARD_STARTUP_NONCE_ENV]: 'not-a-valid-nonce' }))
      .toMatch(/^[0-9a-f]{32}$/);
  });

  it('probes the published port and requires the exact Dashboard child identity', async () => {
    const root = tmp();
    mkdirSync(join(root, '.botmux'), { recursive: true });
    const nonce = '0123456789abcdef0123456789abcdef';
    let responseBody = '{"ok":true}';
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(responseBody);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
    writeFileSync(join(root, '.botmux', '.dashboard-port'), String(address.port));
    try {
      const env = {
        HOME: root,
        BOTMUX_DASHBOARD_HOST: '0.0.0.0',
        [DASHBOARD_STARTUP_NONCE_ENV]: nonce,
      };
      // daemon IPC exposes the same { ok: true } health JSON, so that shape is
      // not proof that the exact Dashboard child reached readiness.
      await expect(probeDashboardStartupReadiness(env)).resolves.toBe(false);
      responseBody = nonce;
      await expect(probeDashboardStartupReadiness(env)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('bounds the whole readiness exchange when a service stalls mid-body', async () => {
    const root = tmp();
    mkdirSync(join(root, '.botmux'), { recursive: true });
    const nonce = 'fedcba9876543210fedcba9876543210';
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write(nonce.slice(0, 1));
      // Deliberately never end: a socket inactivity timeout is insufficient if
      // a wrong service trickles bytes, while the wall-clock deadline must win.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
    writeFileSync(join(root, '.botmux', '.dashboard-port'), String(address.port));
    const startedAt = Date.now();
    try {
      await expect(probeDashboardStartupReadiness({
        HOME: root,
        [DASHBOARD_STARTUP_NONCE_ENV]: nonce,
      })).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});

describe('FleetSupervisor manages the dashboard like a bot daemon (live)', () => {
  const dashboardSpec: FleetBotSpec = resolveDashboardSpec();

  it('spawns index-dashboard.js and records it online in fleet-state', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY_DASHBOARD), daemonEnv: {}, cwd: root, log: () => {},
    });
    sup.start([dashboardSpec]);
    const online = await waitFor(() => {
      const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
      return !!p && p.status === 'online' && pidAlive(p.pid);
    });
    expect(online).toBe(true);
    await sup.stopAll();
  });

  it('does NOT inject BOTMUX_BOT_INDEX into the dashboard (it is app-agnostic)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    // The dashboard logs its BOTMUX_BOT_INDEX; assert it is undefined, not "-1".
    const logDir = join(root, 'logs');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY_DASHBOARD), daemonEnv: {}, cwd: root, logDir, log: () => {},
    });
    sup.start([dashboardSpec]);
    await waitFor(() => {
      const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
      return !!p && p.status === 'online';
    });
    await delay(200);
    await sup.stopAll();
    // logBaseName 'dashboard' → dashboard-out.log (NOT daemon-<idx>-out.log).
    const out = readFileSync(join(logDir, 'dashboard-out.log'), 'utf-8');
    expect(out).toContain('dashboard pid=');
    expect(out).toContain('idx=undefined');
  });

  it('restarts the dashboard on a crash (same crash-restart as a bot)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, CRASH_DASHBOARD), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 50 }, log: () => {},
    });
    sup.start([dashboardSpec]);
    // A crashing dashboard accrues restarts (>=2 proves the restart loop runs).
    const restarted = await waitFor(() => {
      const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
      return (p?.restarts ?? 0) >= 2;
    });
    expect(restarted).toBe(true);
    await sup.stopAll();
  });

  it('restarts a dashboard that stays alive but never becomes reachable', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const logs: string[] = [];
    const sup = new FleetSupervisor({
      statePath,
      distDir: fakeDist(root, STAY_DASHBOARD),
      daemonEnv: {},
      cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 20 },
      dashboardStartupTimeoutMs: 100,
      dashboardReadinessPollMs: 10,
      dashboardReadinessProbe: async () => false,
      log: (message) => logs.push(message),
    });
    sup.start([dashboardSpec]);
    expect(await waitFor(() =>
      (readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard')?.restarts ?? 0) >= 1,
    2_000)).toBe(true);
    expect(logs.some((line) => line.includes('did not become reachable'))).toBe(true);
    await sup.stopAll();
  });

  it('keeps a dashboard that becomes reachable before the startup deadline', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    let probes = 0;
    const sup = new FleetSupervisor({
      statePath,
      distDir: fakeDist(root, STAY_DASHBOARD),
      daemonEnv: {},
      cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 20 },
      dashboardStartupTimeoutMs: 200,
      dashboardReadinessPollMs: 10,
      dashboardReadinessProbe: async () => ++probes >= 2,
      log: () => {},
    });
    sup.start([dashboardSpec]);
    expect(await waitFor(() => probes >= 2)).toBe(true);
    await delay(250);
    const state = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
    expect(state?.status).toBe('online');
    expect(state?.restarts).toBe(0);
    await sup.stopAll();
  });

  it('ignores an in-flight readiness result from a replaced Dashboard generation', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    let probes = 0;
    let resolveFirstProbe: ((ready: boolean) => void) | undefined;
    const sup = new FleetSupervisor({
      statePath,
      distDir: fakeDist(root, STAY_DASHBOARD),
      daemonEnv: {},
      cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 20 },
      dashboardStartupTimeoutMs: 200,
      dashboardReadinessPollMs: 10,
      dashboardReadinessProbe: async () => {
        probes += 1;
        if (probes === 1) {
          return new Promise<boolean>((resolve) => { resolveFirstProbe = resolve; });
        }
        return true;
      },
      log: () => {},
    });
    sup.start([dashboardSpec]);
    expect(await waitFor(() => probes === 1)).toBe(true);
    const first = readFleetState(statePath)!.procs.find((x) => x.name === 'botmux-dashboard')!;
    process.kill(first.pid, 'SIGKILL');
    expect(await waitFor(() => {
      const current = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
      return !!current && current.restarts === 1 && current.pid !== first.pid && probes >= 2;
    })).toBe(true);
    const replacement = readFleetState(statePath)!.procs.find((x) => x.name === 'botmux-dashboard')!;

    resolveFirstProbe?.(false);
    await delay(250);
    const afterStaleResult = readFleetState(statePath)!.procs.find((x) => x.name === 'botmux-dashboard')!;
    expect(afterStaleResult.pid).toBe(replacement.pid);
    expect(afterStaleResult.restarts).toBe(1);
    expect(pidAlive(replacement.pid)).toBe(true);
    await sup.stopAll();
  });

  it('restarts the dashboard on an unsolicited code 90 (self-heals like a bot daemon)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const beats = join(root, 'dash-launches.txt');
    const UNSOLICITED_90 = `
require('fs').appendFileSync(${JSON.stringify(beats)}, 'x');
setTimeout(() => process.exit(90), 100);
`;
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, UNSOLICITED_90), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 20 }, log: () => {},
    });
    sup.start([dashboardSpec]);
    // The child exits 90 on its own WITHOUT a supervisor-initiated stop. The
    // sentinel is no longer trusted as operator intent on an ordinary exit
    // path, so the dashboard self-heals (same contract as a bot daemon).
    const relaunched = await waitFor(() =>
      existsSync(beats) && readFileSync(beats, 'utf-8').length >= 2);
    expect(relaunched).toBe(true);
    expect(await waitFor(() =>
      (readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard')?.restarts ?? 0) >= 1)).toBe(true);
    await sup.stopAll();
    await delay(100); // let the tight crash-loop settle before tmp cleanup
  });

  it('keeps the dashboard stopped when the supervisor itself stops it (graceful sentinel honoured)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const logDir = join(root, 'logs');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY_DASHBOARD), daemonEnv: {}, cwd: root, logDir,
      policy: { maxRestarts: 10, restartDelayMs: 20 }, log: () => {},
    });
    sup.start([dashboardSpec]);
    const online = await waitFor(() => {
      const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
      return !!p && p.status === 'online' && p.pid > 1;
    });
    expect(online).toBe(true);
    const stoppedPid = readFleetState(statePath)!.procs.find((x) => x.name === 'botmux-dashboard')!.pid;

    await sup.stopAll(); // the supervisor initiates → the 90 sentinel is honoured
    await delay(250);
    const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
    expect(p?.status).toBe('stopped');
    expect(p?.restarts).toBe(0);
    expect(pidAlive(stoppedPid)).toBe(false);
  });
});
