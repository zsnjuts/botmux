/**
 * Durable primary 下定时任务跨副本共享（Mew #38）：一个协调库（SQLite 参考实现）
 * 被两个副本共用，各副本有自己的 Pod 本地 authority SQLite 与数据目录。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as scheduler from '../src/core/scheduler.js';
import { createTaskWithOptionalPrecondition } from '../src/core/schedule-precondition-config.js';
import { createDurableScheduleAuthority } from '../src/services/durable-schedule-authority.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import { SchedulePreconditionFileError } from '../src/services/schedule-precondition-file.js';
import {
  activateSchedulePrecondition,
  removeSchedulePrecondition,
  resolveSchedulePrecondition,
  stageSchedulePrecondition,
} from '../src/services/schedule-precondition-store.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import type { ScheduledTask } from '../src/types.js';

const APP = 'cli_durable_schedule';
const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function cluster(options: { now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-durable-schedule-'));
  dirs.push(root);
  const coordination = new SqliteDurableCoordinationStore(
    join(root, 'coordination.db'),
    options.now ? { now: options.now } : {},
  );
  cleanups.push(() => coordination.close());
  const replica = (name: string) => {
    const dataDir = join(root, `pod-${name}`);
    mkdirSync(dataDir);
    const local = ScheduleAuthorityStore.open(dataDir);
    cleanups.push(() => local.close());
    const replaced: string[] = [];
    const boot = (bootId: string) => {
      const authority = createDurableScheduleAuthority({
        store: coordination,
        local,
        bootId,
        dataDir,
        onRowReplaced: (_appId, row) => replaced.push(row.task.id),
      });
      cleanups.push(() => authority.stop());
      return authority;
    };
    return { local, authority: boot(`boot-${name}`), dataDir, replaced, restart: () => boot(`boot-${name}-2`) };
  };
  return { root, coordination, replica };
}

function task(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    name: id,
    schedule: 'every 30m',
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' },
    prompt: 'check',
    workingDir: '/repo',
    chatId: 'oc_chat',
    larkAppId: APP,
    enabled: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    nextRunAt: '2026-11-01T00:30:00.000Z',
    ...overrides,
  };
}

/** Same shape as the scheduler's claim: mark running and advance to the next occurrence. */
const claimAs = (runId: string, nextRunAt = '2026-11-01T09:00:00.000Z') =>
  (current: ScheduledTask): ScheduledTask | undefined =>
    current.lastStatus === 'running' || !current.enabled
      ? undefined
      : { ...current, lastStatus: 'running', lastRunId: runId, nextRunAt };

afterEach(async () => {
  scheduler.stopScheduler();
  scheduler.setDurableScheduleAuthority(null);
  scheduler.setScheduleAuthorityStore(null);
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable schedule authority across replicas', () => {
  it('makes a task created on one replica visible on the other after sync', async () => {
    const { replica } = cluster();
    const a = replica('a');
    const b = replica('b');
    await a.authority.hydrate(APP, () => []);
    await b.authority.hydrate(APP, () => []);

    a.local.createDirect(task('t1'));
    await a.authority.flush();
    expect(b.local.getRecord(APP, 't1')).toBeUndefined();

    await b.authority.sync(APP);
    expect(b.local.getRecord(APP, 't1')).toMatchObject({ state: 'active', task: { id: 't1', prompt: 'check' } });
    expect(b.replaced).toContain('t1');
  });

  it('hydrates a rebuilt replica from the durable copy and never imports its local legacy projection', async () => {
    const { replica } = cluster();
    const a = replica('a');
    await a.authority.hydrate(APP, () => []);
    a.local.createDirect(task('t1'));
    await a.authority.flush();

    const rebuilt = replica('rebuilt');
    await rebuilt.authority.hydrate(APP, () => [task('projection-only')]);
    expect(rebuilt.local.listTasks(APP).map(t => t.id)).toEqual(['t1']);
  });

  it('seeds the durable store from the local legacy projection on first rollout', async () => {
    const { replica } = cluster();
    const first = replica('first');
    await first.authority.hydrate(APP, () => [task('legacy-1')]);

    const peer = replica('peer');
    await peer.authority.hydrate(APP, () => [task('peer-projection')]);
    expect(peer.local.listTasks(APP).map(t => t.id)).toEqual(['legacy-1']);
  });

  it('uploads rows a same-Pod restart finds missing from the durable index', async () => {
    const { replica } = cluster();
    const a = replica('a');
    await a.authority.hydrate(APP, () => []);
    a.local.createDirect(task('t1'));
    await a.authority.flush();
    await a.authority.stop();
    // Committed after write-through stopped, so only this Pod's SQLite has it.
    a.local.createDirect(task('t2'));

    await a.restart().hydrate(APP, () => []);
    const peer = replica('peer');
    await peer.authority.hydrate(APP, () => []);
    expect(peer.local.listTasks(APP).map(t => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('lets exactly one replica win the claim on the same due occurrence', async () => {
    const { replica } = cluster();
    const a = replica('a');
    const b = replica('b');
    await a.authority.hydrate(APP, () => []);
    a.local.createDirect(task('t1'));
    await a.authority.flush();
    await b.authority.hydrate(APP, () => []);

    const [wonByA, wonByB] = await Promise.all([
      a.authority.claim(APP, 't1', claimAs('run-a')),
      b.authority.claim(APP, 't1', claimAs('run-b')),
    ]);
    const winners = [wonByA, wonByB].filter(Boolean);
    expect(winners).toHaveLength(1);
    const winningRun = winners[0]!.lastRunId;

    await a.authority.sync(APP);
    await b.authority.sync(APP);
    expect(a.local.getRecord(APP, 't1')?.task).toMatchObject({ lastStatus: 'running', lastRunId: winningRun });
    expect(b.local.getRecord(APP, 't1')?.task).toMatchObject({ lastStatus: 'running', lastRunId: winningRun });
  });

  it('refuses a claim from a replica that has not observed a run claimed and settled elsewhere', async () => {
    const { replica } = cluster();
    const a = replica('a');
    const b = replica('b');
    await a.authority.hydrate(APP, () => []);
    a.local.createDirect(task('t1'));
    await a.authority.flush();
    await b.authority.hydrate(APP, () => []);

    expect(await a.authority.claim(APP, 't1', claimAs('run-a'))).toMatchObject({ lastRunId: 'run-a' });
    a.local.updateTask(APP, 't1', current => current.lastRunId === 'run-a'
      ? { ...current, lastStatus: 'ok' }
      : undefined);
    await a.authority.flush();

    // B still holds the pre-claim view, where the occurrence looks due and idle.
    expect(b.local.getRecord(APP, 't1')?.task.lastStatus).toBeUndefined();
    expect(await b.authority.claim(APP, 't1', claimAs('run-b'))).toBeUndefined();
    expect(b.local.getRecord(APP, 't1')?.task).toMatchObject({ lastStatus: 'ok', lastRunId: 'run-a' });
  });

  it('replays an update made on a stale replica onto the claimed durable value', async () => {
    const { replica } = cluster();
    const a = replica('a');
    const b = replica('b');
    await a.authority.hydrate(APP, () => []);
    a.local.createDirect(task('t1'));
    await a.authority.flush();
    await b.authority.hydrate(APP, () => []);

    expect(await a.authority.claim(APP, 't1', claimAs('run-a'))).toBeDefined();
    // B pauses the task from its stale local copy that does not show A's run.
    b.local.updateTask(APP, 't1', current => ({ ...current, enabled: false, disabledReason: 'manual' }));
    await b.authority.flush();

    const expected = { enabled: false, disabledReason: 'manual', lastStatus: 'running', lastRunId: 'run-a' };
    expect(b.local.getRecord(APP, 't1')).toMatchObject({ state: 'paused', task: expected });
    await a.authority.sync(APP);
    expect(a.local.getRecord(APP, 't1')).toMatchObject({ state: 'paused', task: expected });

    // A's settlement keeps B's pause.
    a.local.updateTask(APP, 't1', current => current.lastRunId === 'run-a'
      ? { ...current, lastStatus: 'ok' }
      : undefined);
    await a.authority.flush();
    await b.authority.sync(APP);
    expect(b.local.getRecord(APP, 't1')?.task).toMatchObject({ enabled: false, lastStatus: 'ok' });
  });

  it('keeps a revoked tombstone so the task id cannot be reused on another replica', async () => {
    const { replica } = cluster();
    const a = replica('a');
    const b = replica('b');
    await a.authority.hydrate(APP, () => []);
    await b.authority.hydrate(APP, () => []);
    a.local.createDirect(task('t1'));
    await a.authority.flush();
    expect(a.local.revoke(APP, 't1')).toBe(true);
    await a.authority.flush();

    // B never synced and creates a different task under the same id.
    b.local.createDirect(task('t1', { prompt: 'other', createdAt: '2026-11-01T02:00:00.000Z' }));
    await b.authority.flush();
    expect(b.local.getRecord(APP, 't1')?.state).toBe('revoked');
    expect(b.local.listTasks(APP)).toEqual([]);

    const fresh = replica('fresh');
    await fresh.authority.hydrate(APP, () => []);
    expect(fresh.local.listTasks(APP)).toEqual([]);
    expect(() => fresh.local.createDirect(task('t1', { prompt: 'third' }))).toThrow('schedule_task_id_conflict');
  });

  it('reports a run as orphaned only once its owner no longer holds the runner lease', async () => {
    const { replica } = cluster();
    const a = replica('a');
    const b = replica('b');
    await a.authority.hydrate(APP, () => []);
    a.local.createDirect(task('t1'));
    await a.authority.flush();
    await b.authority.hydrate(APP, () => []);
    await a.authority.claim(APP, 't1', claimAs('run-a'));

    await b.authority.sync(APP);
    expect(await b.authority.findOrphanedRuns(APP)).toEqual([]);
    expect(await a.authority.findOrphanedRuns(APP)).toEqual([]);

    await a.authority.stop();
    await b.authority.sync(APP);
    expect(await b.authority.findOrphanedRuns(APP)).toEqual([{ taskId: 't1', runId: 'run-a' }]);
  });

  it('reports a crashed owner once its runner lease lapses', async () => {
    let clock = Date.parse('2026-11-01T00:00:00.000Z');
    const { replica } = cluster({ now: () => clock });
    const a = replica('a');
    const b = replica('b');
    await a.authority.hydrate(APP, () => []);
    a.local.createDirect(task('t1'));
    await a.authority.flush();
    await b.authority.hydrate(APP, () => []);
    await a.authority.claim(APP, 't1', claimAs('run-a'));
    await b.authority.sync(APP);
    expect(await b.authority.findOrphanedRuns(APP)).toEqual([]);

    // A stops renewing without releasing anything (crash); B keeps ticking.
    clock += 60 * 60_000;
    await b.authority.heartbeat(APP);
    expect(await b.authority.findOrphanedRuns(APP)).toEqual([{ taskId: 't1', runId: 'run-a' }]);
  });

  it('replicates an inline precondition and its removal to the other replica', async () => {
    const { replica } = cluster();
    const a = replica('a');
    const b = replica('b');
    await a.authority.hydrate(APP, () => []);
    await b.authority.hydrate(APP, () => []);

    const staged = stageSchedulePrecondition(APP, 'guarded', 'test -f /tmp/ready', { dataDir: a.dataDir });
    const created = a.local.createDirect(task('guarded', { preconditionRef: staged.preconditionRef }));
    activateSchedulePrecondition(created, APP, { dataDir: a.dataDir });
    await a.authority.flush();

    await b.authority.sync(APP);
    const onB = b.local.getRecord(APP, 'guarded')!.task;
    expect(resolveSchedulePrecondition(onB, APP, { dataDir: b.dataDir })).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'inline', script: 'test -f /tmp/ready' },
    });

    removeSchedulePrecondition(APP, 'guarded', { dataDir: a.dataDir });
    a.local.updateTask(APP, 'guarded', current => ({ ...current, preconditionRef: undefined }));
    await a.authority.flush();
    await b.authority.sync(APP);
    const cleared = b.local.getRecord(APP, 'guarded')!.task;
    expect(resolveSchedulePrecondition(cleared, APP, { dataDir: b.dataDir })).toEqual({ kind: 'none' });
  });

  it('rejects file preconditions while schedules are replicated', async () => {
    const { root, replica } = cluster();
    const a = replica('a');
    await a.authority.hydrate(APP, () => []);
    const previousDataDir = config.session.dataDir;
    config.session.dataDir = a.dataDir;
    cleanups.push(() => { config.session.dataDir = previousDataDir; });
    scheduler.setDurableScheduleAuthority(a.authority);

    let rejected: unknown;
    try {
      createTaskWithOptionalPrecondition({
        name: 'file guarded', schedule: 'every 30m', prompt: 'check', workingDir: root,
        chatId: 'oc_chat', larkAppId: APP,
      }, APP, { enabled: true, source: { kind: 'file', path: join(root, 'guard.sh') } });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(SchedulePreconditionFileError);
    expect((rejected as SchedulePreconditionFileError).code).toBe('unsupported_replicated');
    expect(a.local.listTasks(APP)).toEqual([]);
  });
});

describe('scheduler tick with a durable schedule authority', () => {
  const NOW = Date.parse('2026-11-01T01:00:00.000Z');
  let previousDataDir: string;

  /** Let the asynchronous tick (sync → claim → dispatch) run to completion. */
  async function settle(...authorities: Array<{ flush(): Promise<void> }>): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
      for (const authority of authorities) await authority.flush();
    }
  }

  function wireScheduler(a: ReturnType<ReturnType<typeof cluster>['replica']>) {
    previousDataDir = config.session.dataDir;
    config.session.dataDir = a.dataDir;
    cleanups.push(() => { config.session.dataDir = previousDataDir; });
    scheduleStore.setScheduleScope(APP);
    scheduler.setScheduleAuthorityStore(a.local);
    scheduler.setDurableScheduleAuthority(a.authority);
    scheduler.setOwnerFilter(APP, true);
  }

  it('fires a task created on another replica exactly once and writes the settlement back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const { replica } = cluster();
    const a = replica('a');
    const b = replica('b');
    await b.authority.hydrate(APP, () => []);
    b.local.createDirect(task('t1', { nextRunAt: new Date(NOW - 10_000).toISOString() }));
    await b.authority.flush();
    await a.authority.hydrate(APP, () => []);
    wireScheduler(a);

    let release!: () => void;
    const execute = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    scheduler.setExecuteCallback(execute);
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(a.authority);

    expect(execute).toHaveBeenCalledTimes(1);
    const [, context] = execute.mock.calls[0] as unknown as [ScheduledTask, scheduler.ScheduleExecutionContext];
    await b.authority.sync(APP);
    expect(b.local.getRecord(APP, 't1')?.task).toMatchObject({ lastStatus: 'running', lastRunId: context.runId });

    await vi.advanceTimersByTimeAsync(30_000);
    await settle(a.authority);
    expect(execute).toHaveBeenCalledTimes(1);

    release();
    await settle(a.authority);
    await b.authority.sync(APP);
    expect(b.local.getRecord(APP, 't1')?.task).toMatchObject({ lastStatus: 'ok', lastRunId: context.runId });
  });

  it('leaves a run that continues a Session to the replica holding it, then takes it over after the affinity window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const { replica } = cluster();
    const a = replica('a');
    await a.authority.hydrate(APP, () => []);
    a.local.createDirect(task('t1', {
      nextRunAt: new Date(NOW - 10_000).toISOString(),
      executionPosition: 'topic',
      scope: 'thread',
      rootMessageId: 'om_topic_root',
    }));
    await a.authority.flush();
    wireScheduler(a);
    const affinity = vi.fn((_task: ScheduledTask): scheduler.DurableSessionAffinity => 'not_local');
    scheduler.setDurableSessionAffinity(affinity);
    cleanups.push(() => scheduler.setDurableSessionAffinity(null));

    const execute = vi.fn(async () => {});
    scheduler.setExecuteCallback(execute);
    scheduler.startScheduler();
    // Due 10 s ago and the Session's worker lives elsewhere: not claimed here.
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(a.authority);
    expect(affinity).toHaveBeenCalled();
    expect(affinity.mock.calls[0]![0]).toMatchObject({ id: 't1', rootMessageId: 'om_topic_root' });
    expect(execute).not.toHaveBeenCalled();
    expect(a.local.getRecord(APP, 't1')?.task.lastStatus).toBeUndefined();

    // Still inside the window on the next tick (due 40 s ago).
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(a.authority);
    expect(execute).not.toHaveBeenCalled();

    // Nobody took it within the window: this replica claims it on the tick after.
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(a.authority);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('claims a due run at once when this replica holds the Session or the run opens a fresh topic', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const { replica } = cluster();
    const a = replica('a');
    await a.authority.hydrate(APP, () => []);
    a.local.createDirect(task('held', {
      nextRunAt: new Date(NOW - 10_000).toISOString(),
      executionPosition: 'topic',
      scope: 'thread',
      rootMessageId: 'om_held',
    }));
    a.local.createDirect(task('fresh', { nextRunAt: new Date(NOW - 10_000).toISOString() }));
    await a.authority.flush();
    wireScheduler(a);
    scheduler.setDurableSessionAffinity(t => (t.id === 'held' ? 'local' : 'none'));
    cleanups.push(() => scheduler.setDurableSessionAffinity(null));

    const execute = vi.fn(async () => {});
    scheduler.setExecuteCallback(execute);
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(a.authority);
    expect(execute.mock.calls.map(call => (call[0] as ScheduledTask).id).sort()).toEqual(['fresh', 'held']);
  });

  it('counts a run once when its settlement is replayed after a write that committed but reported failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const { coordination, replica } = cluster();
    const a = replica('a');
    await a.authority.hydrate(APP, () => []);
    a.local.createDirect(task('t1', {
      nextRunAt: new Date(NOW - 10_000).toISOString(),
      repeat: { times: 5, completed: 0 },
    }));
    await a.authority.flush();
    wireScheduler(a);

    let release!: () => void;
    scheduler.setExecuteCallback(vi.fn(() => new Promise<void>(resolve => { release = resolve; })));
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(a.authority);

    // The settlement commits in the coordination store, but the caller sees an
    // error, so the write-through keeps it queued and replays it later.
    const realWrite = coordination.writeAuxiliaryState.bind(coordination);
    let lost = 0;
    vi.spyOn(coordination, 'writeAuxiliaryState').mockImplementation(async input => {
      const result = await realWrite(input);
      if (lost === 0 && input.lease.sessionKey.includes('schedule-task') && result.kind === 'written') {
        lost += 1;
        throw new Error('connection reset after commit');
      }
      return result;
    });
    release();
    await settle(a.authority);
    expect(lost).toBe(1);
    await a.authority.sync(APP);
    await settle(a.authority);

    const observer = replica('observer');
    await observer.authority.hydrate(APP, () => []);
    expect(observer.local.getRecord(APP, 't1')?.task).toMatchObject({
      lastStatus: 'ok',
      repeat: { times: 5, completed: 1 },
    });
  });

  it('leaves a run owned by a live replica alone and marks it interrupted after the owner stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const { replica } = cluster();
    const a = replica('a');
    const b = replica('b');
    await b.authority.hydrate(APP, () => []);
    b.local.createDirect(task('t1', { nextRunAt: new Date(NOW - 10_000).toISOString() }));
    await b.authority.flush();
    expect(await b.authority.claim(APP, 't1', claimAs('run-b'))).toBeDefined();
    await a.authority.hydrate(APP, () => []);
    wireScheduler(a);

    const execute = vi.fn(async () => {});
    scheduler.setExecuteCallback(execute);
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(a.authority);
    expect(a.local.getRecord(APP, 't1')?.task).toMatchObject({ lastStatus: 'running', lastRunId: 'run-b' });

    await b.authority.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(a.authority);

    expect(execute).not.toHaveBeenCalled();
    const observer = replica('observer');
    await observer.authority.hydrate(APP, () => []);
    expect(observer.local.getRecord(APP, 't1')?.task).toMatchObject({
      lastStatus: 'error',
      lastRunId: 'run-b',
      lastError: expect.stringContaining('interrupted'),
    });
  });
});
