import { describe, expect, it, vi } from 'vitest';
import { startDurableConfigReloadWatcher } from '../src/services/durable-config-reload-watcher.js';
import {
  DURABLE_CONFIG_SCOPES,
  type DurableConfigInspection,
  type DurableConfigScope,
} from '../src/services/durable-config-coordinator.js';

function inspection(
  revision: number,
  fileSha256: string,
  status: DurableConfigInspection['status'] = 'in_sync',
  scope: DurableConfigScope = 'bots',
): DurableConfigInspection {
  return {
    scope,
    status,
    fileSha256,
    recordRevision: revision,
    recordVersion: 2,
    phase: status === 'prepared' ? 'prepared' : 'committed',
    committedSha256: fileSha256,
    currentPathSha256: 'f'.repeat(64),
    pathMatches: true,
  };
}

describe('durable config reload watcher', () => {
  it.each(DURABLE_CONFIG_SCOPES)('observes the complete %s runtime config authority', async scope => {
    const current = inspection(1, 'a'.repeat(64), 'in_sync', scope);
    const apply = vi.fn(async () => undefined);
    const watcher = startDurableConfigReloadWatcher({
      inspect: async () => current,
      apply,
      intervalMs: 60_000,
    });
    await watcher.ready;
    expect(apply).toHaveBeenCalledWith(current);
    expect(watcher.status()).toMatchObject({
      state: 'in_sync',
      appliedRecordRevision: 1,
      appliedFileSha256: 'a'.repeat(64),
    });
    await watcher.stop();
  });

  it('skips the already-applied generation and hot-applies a later commit once', async () => {
    const one = inspection(1, 'a'.repeat(64));
    const two = inspection(2, 'b'.repeat(64));
    let current = one;
    const apply = vi.fn(async () => undefined);
    const watcher = startDurableConfigReloadWatcher({
      inspect: async () => current,
      apply,
      initialApplied: one,
      intervalMs: 60_000,
      now: () => 123,
    });
    await watcher.ready;
    expect(apply).not.toHaveBeenCalled();
    current = two;
    await watcher.checkNow();
    await watcher.checkNow();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(two);
    expect(watcher.status()).toMatchObject({
      state: 'in_sync',
      appliedRecordRevision: 2,
      appliedFileSha256: 'b'.repeat(64),
      appliedAt: 123,
    });
    await watcher.stop();
  });

  it.each(['content_drift', 'prepared', 'path_mismatch', 'legacy', 'uninitialized'] as const)(
    'never applies a blocked %s generation',
    async status => {
      const blocked = inspection(2, 'b'.repeat(64), status);
      const apply = vi.fn(async () => undefined);
      const watcher = startDurableConfigReloadWatcher({
        inspect: async () => blocked,
        apply,
        intervalMs: 60_000,
      });
      await watcher.ready;
      expect(apply).not.toHaveBeenCalled();
      expect(watcher.status()).toMatchObject({
        state: 'blocked',
        error: `durable_config_reload_${status}`,
      });
      await watcher.stop();
    },
  );

  it('advances the applied revision without reloading when a later commit keeps the same bytes', async () => {
    // No-op CAS commits (rebind, reconcile, identical writes) moved default's
    // committed revision 99 → 111 while every Pod stayed at 99 (Mew #30).
    const applied = inspection(99, 'a'.repeat(64));
    const later = inspection(111, 'a'.repeat(64));
    let current = applied;
    const apply = vi.fn(async () => undefined);
    const watcher = startDurableConfigReloadWatcher({
      inspect: async () => current,
      apply,
      initialApplied: applied,
      intervalMs: 60_000,
    });
    await watcher.ready;
    current = later;
    await watcher.checkNow();
    expect(apply).not.toHaveBeenCalled();
    expect(watcher.status()).toMatchObject({
      state: 'in_sync',
      appliedRecordRevision: 111,
      appliedFileSha256: 'a'.repeat(64),
    });
    await watcher.stop();
  });

  it('reports a check that has not settled as stalled until it finishes', async () => {
    vi.useFakeTimers();
    try {
      const next = inspection(2, 'b'.repeat(64));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const errors: unknown[] = [];
      const watcher = startDurableConfigReloadWatcher({
        inspect: async () => next,
        apply: async () => gate,
        initialApplied: inspection(1, 'a'.repeat(64)),
        intervalMs: 60_000,
        stallAfterMs: 5_000,
        onError: error => errors.push(error),
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(watcher.status()).toMatchObject({
        state: 'error',
        error: 'durable_config_reload_stalled',
        appliedRecordRevision: 1,
      });
      expect(errors).toHaveLength(1);
      release();
      await watcher.ready;
      expect(watcher.status()).toMatchObject({ state: 'in_sync', appliedRecordRevision: 2 });
      await watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries the same generation after a local reload failure', async () => {
    const next = inspection(3, 'c'.repeat(64));
    const apply = vi.fn()
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce(undefined);
    const errors: string[] = [];
    const watcher = startDurableConfigReloadWatcher({
      inspect: async () => next,
      apply,
      intervalMs: 60_000,
      onError: error => errors.push((error as Error).message),
    });
    await watcher.ready;
    expect(watcher.status()).toMatchObject({ state: 'error', error: 'reload failed' });
    await watcher.checkNow();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(errors).toEqual(['reload failed']);
    expect(watcher.status()).toMatchObject({ state: 'in_sync', appliedRecordRevision: 3 });
    await watcher.stop();
  });

  it('serializes concurrent checks', async () => {
    const next = inspection(4, 'd'.repeat(64));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const apply = vi.fn(async () => gate);
    const watcher = startDurableConfigReloadWatcher({
      inspect: async () => next,
      apply,
      intervalMs: 60_000,
    });
    const first = watcher.ready;
    const second = watcher.checkNow();
    expect(second).toBe(first);
    release();
    await first;
    expect(apply).toHaveBeenCalledTimes(1);
    await watcher.stop();
  });

  it('backs off automatic polling while a generation is blocked', async () => {
    vi.useFakeTimers();
    let now = 0;
    const blocked = inspection(5, 'e'.repeat(64), 'path_mismatch');
    const inspect = vi.fn(async () => blocked);
    const watcher = startDurableConfigReloadWatcher({
      inspect,
      apply: async () => undefined,
      intervalMs: 100,
      blockedRetryMs: 1_000,
      now: () => now,
    });
    try {
      await watcher.ready;
      expect(inspect).toHaveBeenCalledTimes(1);
      now = 900;
      await vi.advanceTimersByTimeAsync(900);
      expect(inspect).toHaveBeenCalledTimes(1);
      now = 1_000;
      await vi.advanceTimersByTimeAsync(100);
      expect(inspect).toHaveBeenCalledTimes(2);
      await watcher.checkNow();
      expect(inspect).toHaveBeenCalledTimes(3);
    } finally {
      await watcher.stop();
      vi.useRealTimers();
    }
  });

  it('backs off automatic inspection errors and resumes at the deadline', async () => {
    vi.useFakeTimers();
    let now = 0;
    const recovered = inspection(6, 'f'.repeat(64));
    const inspect = vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValue(recovered);
    const apply = vi.fn(async () => undefined);
    const watcher = startDurableConfigReloadWatcher({
      inspect,
      apply,
      intervalMs: 100,
      blockedRetryMs: 1_000,
      now: () => now,
    });
    try {
      await watcher.ready;
      expect(watcher.status()).toMatchObject({ state: 'error', error: 'provider unavailable' });
      now = 900;
      await vi.advanceTimersByTimeAsync(900);
      expect(inspect).toHaveBeenCalledTimes(1);
      now = 1_000;
      await vi.advanceTimersByTimeAsync(100);
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(apply).toHaveBeenCalledWith(recovered);
      expect(watcher.status()).toMatchObject({ state: 'in_sync', appliedRecordRevision: 6 });
    } finally {
      await watcher.stop();
      vi.useRealTimers();
    }
  });

  it('backs off automatic apply errors and retries the generation at the deadline', async () => {
    vi.useFakeTimers();
    let now = 0;
    const next = inspection(7, '7'.repeat(64));
    const inspect = vi.fn(async () => next);
    const apply = vi.fn()
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce(undefined);
    const watcher = startDurableConfigReloadWatcher({
      inspect,
      apply,
      intervalMs: 100,
      blockedRetryMs: 1_000,
      now: () => now,
    });
    try {
      await watcher.ready;
      expect(watcher.status()).toMatchObject({ state: 'error', error: 'reload failed' });
      now = 900;
      await vi.advanceTimersByTimeAsync(900);
      expect(apply).toHaveBeenCalledTimes(1);
      now = 1_000;
      await vi.advanceTimersByTimeAsync(100);
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(apply).toHaveBeenCalledTimes(2);
      expect(watcher.status()).toMatchObject({ state: 'in_sync', appliedRecordRevision: 7 });
    } finally {
      await watcher.stop();
      vi.useRealTimers();
    }
  });
});
