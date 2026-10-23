import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeHeartbeatTo,
  anyDaemonBusyTo,
  heartbeatDirIn,
  HEARTBEAT_FRESH_MS,
} from '../src/core/daemon-heartbeat.js';

const T0 = Date.parse('2026-06-07T04:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('daemon heartbeat / anyDaemonBusy', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-hb-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('false when there are no heartbeats at all', () => {
    expect(anyDaemonBusyTo(dir, T0)).toBe(false);
  });

  it('true when a fresh heartbeat reports busyCount > 0', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 2, iso(T0));
    expect(anyDaemonBusyTo(dir, T0 + 5_000)).toBe(true);
  });

  it('false when a fresh heartbeat reports busyCount 0 (idle daemon)', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 0, iso(T0));
    expect(anyDaemonBusyTo(dir, T0 + 5_000)).toBe(false);
  });

  it('ignores a stale heartbeat (daemon went down) — treated as not busy', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 5, iso(T0));
    expect(anyDaemonBusyTo(dir, T0 + HEARTBEAT_FRESH_MS + 1_000)).toBe(false);
  });

  it('true if ANY daemon is fresh+busy while others are idle', () => {
    writeHeartbeatTo(dir, 'cli_app_idle', 0, iso(T0));
    writeHeartbeatTo(dir, 'cli_app_busy', 1, iso(T0));
    expect(anyDaemonBusyTo(dir, T0 + 5_000)).toBe(true);
  });

  it('round-trips the busy count for a single daemon', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 3, iso(T0));
    writeHeartbeatTo(dir, 'cli_app_a', 0, iso(T0 + 1_000)); // overwrite same daemon
    expect(anyDaemonBusyTo(dir, T0 + 2_000)).toBe(false);
  });

  it('tolerates a corrupt heartbeat file (ignored, no throw)', () => {
    writeHeartbeatTo(dir, 'cli_app_busy', 1, iso(T0)); // creates the dir + a busy beat
    writeFileSync(join(heartbeatDirIn(dir), 'broken.json'), '{bad');
    expect(anyDaemonBusyTo(dir, T0 + 1_000)).toBe(true);
  });

  it('writes atomically (no .tmp leftover)', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 1, iso(T0));
    expect(readdirSync(heartbeatDirIn(dir)).filter(f => f.endsWith('.tmp'))).toEqual([]);
    expect(statSync(join(heartbeatDirIn(dir), 'cli_app_a.json')).mode & 0o777).toBe(0o600);
  });

  it('publishes process, event-loop and Lark connection health without changing the busy gate', () => {
    writeHeartbeatTo(dir, 'cli_app_a', 0, iso(T0), {
      pid: 1234,
      eventLoopLagMs: 250,
      larkConnection: {
        generation: 2,
        state: 'connected',
        observedAt: T0,
        transitionedAt: T0 - 1_000,
        startedAt: T0 - 2_000,
        reconnectAttempts: 0,
        lastConnectTime: T0 - 1_500,
      },
    });

    const beat = JSON.parse(readFileSync(join(heartbeatDirIn(dir), 'cli_app_a.json'), 'utf8'));
    expect(beat).toMatchObject({
      schemaVersion: 2,
      larkAppId: 'cli_app_a',
      busyCount: 0,
      pid: 1234,
      eventLoopLagMs: 250,
      larkConnection: { generation: 2, state: 'connected' },
    });
    expect(anyDaemonBusyTo(dir, T0 + 5_000)).toBe(false);
  });
});
