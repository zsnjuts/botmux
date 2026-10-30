import { execFile } from 'node:child_process';

/** One CLI installation's version probe (`<bin> --version` by default). */
export interface CliVersionProbe {
  bin: string;
  args: string[];
  /** Human-readable runtime name for logs. */
  label: string;
}

export interface CliVersionRecord {
  version: string;
  lastCheckAt: number;
}

export type CliVersionRunner = (probe: CliVersionProbe, timeoutMs: number) => Promise<string>;

/** Runs the probe as a child process without blocking the event loop. */
export const runCliVersionProbe: CliVersionRunner = (probe, timeoutMs) => new Promise((resolve, reject) => {
  execFile(probe.bin, probe.args, { encoding: 'utf-8', timeout: timeoutMs }, (error, stdout) => {
    if (error) reject(error);
    else resolve(String(stdout));
  });
});

export interface CliVersionRefresherOptions {
  /** A cached version younger than this is reused without probing. */
  intervalMs: number;
  timeoutMs?: number;
  now?: () => number;
  run?: CliVersionRunner;
  /** Shared with callers that read versions synchronously. */
  cache?: Map<string, CliVersionRecord>;
  /** A probe produced a version (`previous` is the cached one, if any). */
  onVersion?: (key: string, version: string, previous: string | undefined, probe: CliVersionProbe) => void;
  onError?: (key: string, error: unknown, probe: CliVersionProbe | undefined) => void;
}

export interface CliVersionRefresher {
  /**
   * Refresh the version cached under `key` when it is missing or older than
   * the interval. The probe runs in the background: callers that do not await
   * the result keep reading the cached version meanwhile. Concurrent calls for
   * one key share a single probe. Resolves true when the version changed;
   * never rejects.
   */
  refresh(key: string, resolveProbe: () => CliVersionProbe | undefined): Promise<boolean>;
  version(key: string): string | undefined;
}

export function createCliVersionRefresher(options: CliVersionRefresherOptions): CliVersionRefresher {
  const now = options.now ?? Date.now;
  const run = options.run ?? runCliVersionProbe;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const cache = options.cache ?? new Map<string, CliVersionRecord>();
  const inFlight = new Map<string, Promise<boolean>>();

  const refresh = (key: string, resolveProbe: () => CliVersionProbe | undefined): Promise<boolean> => {
    const checkedAt = now();
    const cached = cache.get(key);
    if (cached && checkedAt - cached.lastCheckAt < options.intervalMs) return Promise.resolve(false);
    const running = inFlight.get(key);
    if (running) return running;
    let probe: CliVersionProbe | undefined;
    try {
      probe = resolveProbe();
    } catch (error) {
      try { options.onError?.(key, error, undefined); } catch { /* observer only */ }
      return Promise.resolve(false);
    }
    // Remote backends without a local binary have nothing to probe.
    if (!probe) return Promise.resolve(false);
    const resolvedProbe = probe;
    // The probe starts on a later microtask, so the in-flight entry below is
    // always registered before either settle handler can remove it.
    const probing: Promise<boolean> = Promise.resolve()
      .then(() => run(resolvedProbe, timeoutMs))
      .then(raw => {
        inFlight.delete(key);
        const version = raw.trim().replace(/^[^0-9]*/, '');
        if (!version || version === 'unknown') return false;
        const previous = cache.get(key)?.version;
        cache.set(key, { version, lastCheckAt: checkedAt });
        try { options.onVersion?.(key, version, previous, resolvedProbe); } catch { /* observer only */ }
        return previous !== undefined && previous !== version;
      }, error => {
        inFlight.delete(key);
        try { options.onError?.(key, error, resolvedProbe); } catch { /* observer only */ }
        return false;
      });
    inFlight.set(key, probing);
    return probing;
  };

  return {
    refresh,
    version: key => cache.get(key)?.version,
  };
}
