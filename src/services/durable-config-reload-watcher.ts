import type { DurableConfigInspection } from './durable-config-coordinator.js';

export interface DurableConfigReloadWatcherStatus {
  state: 'starting' | 'in_sync' | 'blocked' | 'error' | 'stopped';
  inspection?: DurableConfigInspection;
  appliedRecordRevision?: number;
  appliedFileSha256?: string;
  appliedAt?: number;
  error?: string;
}

export interface DurableConfigReloadWatcher {
  ready: Promise<void>;
  status(): DurableConfigReloadWatcherStatus;
  checkNow(): Promise<void>;
  stop(): Promise<void>;
  terminate(): void;
}

export interface DurableConfigReloadWatcherOptions {
  inspect(): Promise<DurableConfigInspection>;
  apply(inspection: DurableConfigInspection): Promise<void>;
  initialApplied?: DurableConfigInspection;
  intervalMs?: number;
  /** A single check (inspect + apply) running longer than this is published as
   *  `durable_config_reload_stalled` until it settles. */
  stallAfterMs?: number;
  /** Automatic retry cadence while the CAS is blocked or the provider fails.
   *  Explicit `checkNow()` calls bypass this delay. */
  blockedRetryMs?: number;
  now?: () => number;
  onStatus?: (status: DurableConfigReloadWatcherStatus) => void;
  onError?: (error: unknown) => void;
}

function interval(value: number | undefined): number {
  const result = value ?? 500;
  if (!Number.isSafeInteger(result) || result < 100 || result > 60_000) {
    throw new Error('durable config reload intervalMs must be an integer between 100 and 60000');
  }
  return result;
}

function blockedRetryInterval(value: number | undefined, intervalMs: number): number {
  const result = value ?? Math.max(10_000, intervalMs);
  if (!Number.isSafeInteger(result) || result < intervalMs || result > 60_000) {
    throw new Error('durable config reload blockedRetryMs must be an integer between intervalMs and 60000');
  }
  return result;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function appliedIdentity(value: DurableConfigInspection | undefined): {
  revision?: number;
  fileSha256?: string;
} {
  return value?.status === 'in_sync'
    ? { revision: value.recordRevision, fileSha256: value.fileSha256 }
    : {};
}

/**
 * Observe the shared config CAS and hot-apply every newly committed generation.
 *
 * The watcher never repairs drift and never writes configuration.  `prepared`,
 * `content_drift`, path mismatch, legacy and uninitialised states stay blocked
 * until the authoritative mutation/recovery path makes the record `in_sync`.
 */
export function startDurableConfigReloadWatcher(
  options: DurableConfigReloadWatcherOptions,
): DurableConfigReloadWatcher {
  const intervalMs = interval(options.intervalMs);
  const blockedRetryMs = blockedRetryInterval(options.blockedRetryMs, intervalMs);
  const stallAfterMs = options.stallAfterMs ?? 60_000;
  const now = options.now ?? Date.now;
  const initial = appliedIdentity(options.initialApplied);
  let appliedRecordRevision = initial.revision;
  let appliedFileSha256 = initial.fileSha256;
  let current: DurableConfigReloadWatcherStatus = {
    state: 'starting',
    ...(appliedRecordRevision === undefined ? {} : { appliedRecordRevision }),
    ...(appliedFileSha256 === undefined ? {} : { appliedFileSha256 }),
  };
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let nextAutomaticCheckAt = 0;

  const publish = (next: DurableConfigReloadWatcherStatus): void => {
    current = next;
    try { options.onStatus?.(next); } catch { /* observers cannot alter reload */ }
  };
  const report = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* observers cannot alter reload */ }
  };

  const check = async (): Promise<void> => {
    if (stopped) return;
    let inspection: DurableConfigInspection;
    try {
      inspection = await options.inspect();
    } catch (error) {
      nextAutomaticCheckAt = now() + blockedRetryMs;
      const message = errorText(error);
      publish({
        state: 'error',
        ...(appliedRecordRevision === undefined ? {} : { appliedRecordRevision }),
        ...(appliedFileSha256 === undefined ? {} : { appliedFileSha256 }),
        error: message,
      });
      report(error);
      return;
    }
    if (inspection.status !== 'in_sync' || inspection.recordRevision === undefined) {
      nextAutomaticCheckAt = now() + blockedRetryMs;
      publish({
        state: 'blocked',
        inspection,
        ...(appliedRecordRevision === undefined ? {} : { appliedRecordRevision }),
        ...(appliedFileSha256 === undefined ? {} : { appliedFileSha256 }),
        error: `durable_config_reload_${inspection.status}`,
      });
      return;
    }
    nextAutomaticCheckAt = 0;
    if (inspection.fileSha256 === appliedFileSha256) {
      // Same bytes, possibly under a later revision: a CAS commit that changed
      // nothing (path rebind, reconcile, or a write of identical content).
      // There is nothing to reload.  Re-running apply would repeat its side
      // effects (allowedUsers contact lookups) and, if one of them hangs, leave
      // the applied revision behind the committed one (Mew #30).
      appliedRecordRevision = inspection.recordRevision;
      publish({
        state: 'in_sync',
        inspection,
        appliedRecordRevision,
        appliedFileSha256,
        ...(current.appliedAt === undefined ? {} : { appliedAt: current.appliedAt }),
      });
      return;
    }
    try {
      await options.apply(inspection);
      appliedRecordRevision = inspection.recordRevision;
      appliedFileSha256 = inspection.fileSha256;
      publish({
        state: 'in_sync',
        inspection,
        appliedRecordRevision,
        appliedFileSha256,
        appliedAt: now(),
      });
    } catch (error) {
      nextAutomaticCheckAt = now() + blockedRetryMs;
      const message = errorText(error);
      publish({
        state: 'error',
        inspection,
        ...(appliedRecordRevision === undefined ? {} : { appliedRecordRevision }),
        ...(appliedFileSha256 === undefined ? {} : { appliedFileSha256 }),
        error: message,
      });
      report(error);
    }
  };

  const checkNow = (): Promise<void> => {
    if (running) return running;
    // A hung inspect/apply would otherwise keep publishing its last in_sync
    // status forever, which health reads as a generation mismatch.
    const stall = setTimeout(() => {
      publish({
        state: 'error',
        ...(current.inspection ? { inspection: current.inspection } : {}),
        ...(appliedRecordRevision === undefined ? {} : { appliedRecordRevision }),
        ...(appliedFileSha256 === undefined ? {} : { appliedFileSha256 }),
        ...(current.appliedAt === undefined ? {} : { appliedAt: current.appliedAt }),
        error: 'durable_config_reload_stalled',
      });
      report(new Error(`durable config reload check has not settled after ${stallAfterMs}ms`));
    }, stallAfterMs);
    stall.unref?.();
    running = check().finally(() => {
      clearTimeout(stall);
      running = undefined;
    });
    return running;
  };
  const ready = checkNow();
  timer = setInterval(() => {
    if (nextAutomaticCheckAt > now()) return;
    void checkNow();
  }, intervalMs);
  timer.unref?.();

  return {
    ready,
    status: () => ({ ...current }),
    checkNow,
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (running) await running;
      publish({
        state: 'stopped',
        ...(current.inspection ? { inspection: current.inspection } : {}),
        ...(appliedRecordRevision === undefined ? {} : { appliedRecordRevision }),
        ...(appliedFileSha256 === undefined ? {} : { appliedFileSha256 }),
        ...(current.appliedAt === undefined ? {} : { appliedAt: current.appliedAt }),
      });
    },
    terminate: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
