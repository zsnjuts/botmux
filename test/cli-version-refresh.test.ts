/**
 * CLI version refresh (`<cli> --version`) must not stall the daemon: the probe
 * runs as an async child process, callers on the message path do not wait for
 * it, and the cached version keeps serving reads meanwhile.
 *
 * Run:  npx vitest run --project unit test/cli-version-refresh.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCliVersionRefresher,
  type CliVersionProbe,
} from '../src/core/cli-version-refresh.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const probe = (label = 'Test CLI'): CliVersionProbe => ({ bin: 'test-cli', args: ['--version'], label });

describe('CLI version refresh', () => {
  it('runs the version command without blocking the event loop', async () => {
    const refresher = createCliVersionRefresher({ intervalMs: 60_000 });
    // A real child process that answers only after a delay.
    const slowCli: CliVersionProbe = {
      bin: process.execPath,
      args: ['-e', 'setTimeout(() => console.log("slow-cli 9.8.7"), 300)'],
      label: 'slow CLI',
    };
    const order: string[] = [];

    const refreshed = refresher.refresh('slow', () => slowCli).then(() => { order.push('probe'); });
    setTimeout(() => order.push('timer'), 0);
    // Reads during the probe keep serving the (still empty) cache.
    expect(refresher.version('slow')).toBeUndefined();

    await refreshed;
    expect(order).toEqual(['timer', 'probe']);
    expect(refresher.version('slow')).toBe('9.8.7');
  });

  it('shares one probe between concurrent refreshes and reuses a fresh version', async () => {
    let now = 1_000;
    const pending = deferred<string>();
    const run = vi.fn(() => pending.promise);
    const refresher = createCliVersionRefresher({ intervalMs: 60_000, now: () => now, run });

    const first = refresher.refresh('cli', () => probe());
    const second = refresher.refresh('cli', () => probe());
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    pending.resolve('test-cli 1.2.3\n');
    await Promise.all([first, second]);
    expect(refresher.version('cli')).toBe('1.2.3');

    now += 59_000;
    await refresher.refresh('cli', () => probe());
    expect(run).toHaveBeenCalledTimes(1);

    now += 2_000;
    run.mockImplementation(async () => 'test-cli 1.2.3');
    await refresher.refresh('cli', () => probe());
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reports a changed version and keeps the old one when a probe fails', async () => {
    let now = 1_000;
    const run = vi.fn(async () => 'v1.0.0');
    const versions: Array<[string, string | undefined]> = [];
    const errors: string[] = [];
    const refresher = createCliVersionRefresher({
      intervalMs: 60_000,
      now: () => now,
      run,
      onVersion: (_key, version, previous) => versions.push([version, previous]),
      onError: (_key, error, failedProbe) => errors.push(`${failedProbe?.label}: ${String(error)}`),
    });

    await expect(refresher.refresh('cli', () => probe())).resolves.toBe(false);
    now += 61_000;
    run.mockImplementation(async () => 'v1.1.0');
    await expect(refresher.refresh('cli', () => probe())).resolves.toBe(true);
    expect(versions).toEqual([['1.0.0', undefined], ['1.1.0', '1.0.0']]);

    now += 61_000;
    run.mockImplementation(async () => { throw new Error('ENOENT'); });
    await expect(refresher.refresh('cli', () => probe('Broken CLI'))).resolves.toBe(false);
    expect(refresher.version('cli')).toBe('1.1.0');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Broken CLI');

    // A failed probe does not count as a fresh check: the next call retries.
    run.mockImplementation(async () => 'v1.1.0');
    await refresher.refresh('cli', () => probe());
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('skips runtimes without a local binary to probe', async () => {
    const run = vi.fn(async () => '1.0.0');
    const refresher = createCliVersionRefresher({ intervalMs: 60_000, run });

    await expect(refresher.refresh('remote', () => undefined)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(refresher.version('remote')).toBeUndefined();
  });
});
