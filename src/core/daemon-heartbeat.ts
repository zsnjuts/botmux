/**
 * Cross-daemon busy heartbeat. botmux runs one daemon process per bot, but a
 * restart (auto-restart / auto-update) takes them all down at once — so the
 * "is anything mid-CLI-turn right now?" gate must see across processes, not
 * just the primary daemon's own sessions.
 *
 * Each daemon periodically writes `<dataDir>/heartbeats/<larkAppId>.json` with
 * its count of actively-working sessions. The primary daemon reads them all;
 * any fresh heartbeat with busyCount > 0 blocks a maintenance restart.
 * A daemon that is down leaves a stale file, which is ignored (restarting is
 * safe when a daemon isn't even running).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { LarkConnectionHealth } from '../im/lark/transport/connection.js';

export interface Heartbeat {
  schemaVersion?: 2;
  larkAppId: string;
  busyCount: number;
  at: string; // ISO 8601
  pid?: number;
  eventLoopLagMs?: number;
  larkConnection?: LarkConnectionHealth;
}

export interface HeartbeatDetails {
  pid?: number;
  eventLoopLagMs?: number;
  larkConnection?: LarkConnectionHealth;
}

/** A heartbeat older than this is treated as "daemon not reporting" → ignored.
 *  Daemons should write well within this window (≈ every 15s). */
export const HEARTBEAT_FRESH_MS = 60_000;

export function heartbeatDirIn(dir: string): string {
  return join(dir, 'heartbeats');
}

export function writeHeartbeatTo(
  dir: string,
  larkAppId: string,
  busyCount: number,
  atIso: string,
  details: HeartbeatDetails = {},
): void {
  const hbDir = heartbeatDirIn(dir);
  if (!existsSync(hbDir)) mkdirSync(hbDir, { recursive: true });
  const path = join(hbDir, `${sanitize(larkAppId)}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  const beat: Heartbeat = {
    schemaVersion: 2,
    larkAppId,
    busyCount,
    at: atIso,
    ...details,
  };
  writeFileSync(tmp, JSON.stringify(beat), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** True iff any daemon reports a fresh heartbeat with at least one busy session. */
export function anyDaemonBusyTo(dir: string, nowMs: number, freshMs: number = HEARTBEAT_FRESH_MS): boolean {
  const hbDir = heartbeatDirIn(dir);
  if (!existsSync(hbDir)) return false;
  let files: string[];
  try { files = readdirSync(hbDir); } catch { return false; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const beat = readBeat(join(hbDir, f));
    if (!beat) continue;
    const at = Date.parse(beat.at);
    if (!Number.isFinite(at)) continue;
    if (nowMs - at > freshMs) continue; // stale → ignore
    if (beat.busyCount > 0) return true;
  }
  return false;
}

function readBeat(path: string): Heartbeat | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8'));
    if (v && typeof v === 'object' && typeof v.busyCount === 'number' && typeof v.at === 'string') {
      return v as Heartbeat;
    }
  } catch {
    /* corrupt/partial write → ignore */
  }
  return null;
}

/** App ids are already filesystem-safe (cli_…), but guard against separators. */
function sanitize(larkAppId: string): string {
  return larkAppId.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---- default-dir wrappers (production wiring) ----

export function writeHeartbeat(larkAppId: string, busyCount: number, details: HeartbeatDetails = {}): void {
  writeHeartbeatTo(config.session.dataDir, larkAppId, busyCount, new Date().toISOString(), details);
}

export function anyDaemonBusy(nowMs: number = Date.now()): boolean {
  return anyDaemonBusyTo(config.session.dataDir, nowMs);
}
