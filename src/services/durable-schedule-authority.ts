/**
 * Durable primary 下定时任务的跨副本事实源（Mew #38）。
 *
 * primary 模式的 SESSION_DATA_DIR 是 Pod 本地盘：`schedule-authority.sqlite`、
 * `schedules.json` 投影与前置条件 sidecar 都随 Pod 重建丢失，而且多副本时任务只活在
 * 创建它的那个 Pod 上。这里把 PostgreSQL `auxiliary_state` 作为事实源：
 *
 *  - `auxiliary::schedule-index::<appId>`：`{ taskIds }`，只做并集合并、永不收缩；
 *  - `auxiliary::schedule-task::<appId>::<taskId>`：完整 authority 行（撤销后保留墓碑），
 *    内联前置条件记录，以及 `lastStatus === 'running'` 时执行该轮的 `ownerBootId`；
 *  - `auxiliary::schedule-runner::<appId>::<bootId>`：每个 daemon 持有的存活租约，
 *    别的副本能拿到它即说明 owner 已死，可以把它遗留的 running 标成中断。
 *
 * 本地 SQLite 仍是同步缓存，现有同步调用点不变：本地每次提交后按任务 FIFO 异步回写，
 * 回写时把同一个纯 mutation 在 PG 当前值上重放（lease + CAS），成功后用 PG 结果覆盖本地行。
 * 触发时每个副本先同步，再对到期任务做 CAS 认领，只有赢家执行回调。
 *
 * 只在 primary 模式接线；其他模式不创建本对象，调度器行为保持原样。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  DurableAuxiliaryStateStore,
  DurableJson,
  DurableSessionLeaseStore,
  SessionLease,
} from './durable-coordination.js';
import { createDurableGroupContextRecallFacade } from './durable-group-context-recall.js';
import {
  scheduleAuthorityStateFor,
  type ScheduleAuthorityMutation,
  type ScheduleAuthorityReplicaRow,
  type ScheduleAuthorityStore,
} from './schedule-authority-store.js';
import {
  readSchedulePreconditionRecord,
  removeSchedulePrecondition,
  writeSchedulePreconditionRecord,
  type SchedulePreconditionRecord,
} from './schedule-precondition-store.js';
import type { ScheduledTask } from '../types.js';
import { canonicalJson } from '../utils/canonical-input-hash.js';
import { logger } from '../utils/logger.js';

const RECORD_VERSION = 1;
const INDEX_TYPE = 'botmux.schedule.index';
const TASK_TYPE = 'botmux.schedule.task';
const CAS_RETRIES = 8;
const CAS_BACKOFF_MS = 150;
/** Spans several scheduler ticks; a live daemon renews it on every tick. */
const RUNNER_LEASE_MS = 120_000;
const PROBE_LEASE_MS = 1_000;

export type ScheduleTaskMutation = (task: ScheduledTask) => ScheduledTask | undefined;

export interface DurableScheduleAuthority {
  readonly bootId: string;
  /** Startup: load the durable copy into the local store, or seed it from the
   * local store when this app has no durable index yet. Installs write-through. */
  hydrate(appId: string, legacyTasks: () => readonly ScheduledTask[]): Promise<void>;
  /** Refresh local rows from the durable copy (tasks with queued local writes are skipped). */
  sync(appId: string): Promise<void>;
  /** CAS-claim a run in the durable store. Resolves the claimed task only when
   * this replica's write won; the local row then mirrors the durable result. */
  claim(
    appId: string,
    taskId: string,
    mutate: ScheduleTaskMutation,
    options?: { requireObservedRevision?: boolean },
  ): Promise<ScheduledTask | undefined>;
  /** Acquire or renew this daemon's runner liveness lease. */
  heartbeat(appId: string): Promise<void>;
  /** Running tasks whose owning daemon no longer holds its runner lease. */
  findOrphanedRuns(appId: string): Promise<Array<{ taskId: string; runId?: string }>>;
  /** Wait until every queued write-through has been attempted. */
  flush(): Promise<void>;
  /** Drain (bounded), release runner leases and stop. Idempotent. */
  stop(timeoutMs?: number): Promise<void>;
}

interface TaskEnvelope {
  row: ScheduleAuthorityReplicaRow;
  precondition?: SchedulePreconditionRecord;
  ownerBootId?: string;
}

interface StoredValue {
  revision: number;
  value: DurableJson;
}

interface Job {
  /** Write-through jobs retry until they commit; claims are one-shot. */
  retry: boolean;
  run(): Promise<void>;
  abandon?(): void;
}

interface Lane {
  key: string;
  appId: string;
  taskId: string;
  jobs: Job[];
  running?: Promise<void>;
  stalled: boolean;
  failures: number;
}

/** Thrown inside a CAS builder to abort without writing. */
class UnchangedRecord extends Error {
  current?: StoredValue;
  constructor() { super('durable schedule record unchanged'); }
}

function boundedId(value: string, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${label} must contain at most 512 non-empty characters`);
  }
  return normalized;
}

export function durableScheduleIndexKey(appId: string): string {
  return `auxiliary::schedule-index::${boundedId(appId, 'appId')}`;
}

export function durableScheduleTaskKey(appId: string, taskId: string): string {
  return `auxiliary::schedule-task::${boundedId(appId, 'appId')}::${boundedId(taskId, 'taskId')}`;
}

export function durableScheduleRunnerKey(appId: string, bootId: string): string {
  return `auxiliary::schedule-runner::${boundedId(appId, 'appId')}::${boundedId(bootId, 'bootId')}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseIndex(value: unknown, appId: string): string[] {
  if (!isObject(value) || value.version !== RECORD_VERSION || value.type !== INDEX_TYPE
      || value.larkAppId !== appId || !Array.isArray(value.taskIds)
      || value.taskIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error(`durable schedule index for ${appId} has an invalid envelope`);
  }
  return [...value.taskIds] as string[];
}

function parseTaskEnvelope(value: unknown, appId: string, taskId: string): TaskEnvelope {
  if (!isObject(value) || value.version !== RECORD_VERSION || value.type !== TASK_TYPE
      || value.larkAppId !== appId || value.taskId !== taskId
      || !isObject(value.row) || !isObject(value.row.task) || value.row.task.id !== taskId
      || (value.precondition !== undefined && !isObject(value.precondition))
      || (value.ownerBootId !== undefined && typeof value.ownerBootId !== 'string')) {
    throw new Error(`durable schedule task ${taskId} has an invalid envelope`);
  }
  return {
    row: value.row as unknown as ScheduleAuthorityReplicaRow,
    ...(value.precondition ? { precondition: value.precondition as unknown as SchedulePreconditionRecord } : {}),
    ...(value.ownerBootId ? { ownerBootId: value.ownerBootId } : {}),
  };
}

function serializeTask(appId: string, taskId: string, envelope: TaskEnvelope, now: number): DurableJson {
  return JSON.parse(JSON.stringify({
    version: RECORD_VERSION,
    type: TASK_TYPE,
    larkAppId: appId,
    taskId,
    row: envelope.row,
    ...(envelope.precondition ? { precondition: envelope.precondition } : {}),
    ...(envelope.ownerBootId ? { ownerBootId: envelope.ownerBootId } : {}),
    updatedAt: now,
  })) as DurableJson;
}

export function createDurableScheduleAuthority(input: {
  store: DurableSessionLeaseStore & DurableAuxiliaryStateStore;
  local: ScheduleAuthorityStore;
  bootId: string;
  /** Precondition sidecar root; defaults to the daemon data directory. */
  dataDir?: string;
  /** A local row was replaced by the durable copy (refresh the projection).
   * Not called during hydrate: the caller rebuilds the whole projection then. */
  onRowReplaced?: (appId: string, row: ScheduleAuthorityReplicaRow) => void;
  now?: () => number;
}): DurableScheduleAuthority {
  const { store, local } = input;
  const bootId = boundedId(input.bootId, 'bootId');
  const now = input.now ?? Date.now;
  const sidecarOptions = input.dataDir ? { dataDir: input.dataDir } : {};
  const facade = createDurableGroupContextRecallFacade({ store, ownerId: `schedule-authority:${bootId}` });
  const lanes = new Map<string, Lane>();
  /** Last durable value this replica observed per task key (sync or own write). */
  const seen = new Map<string, { appId: string; taskId: string; revision: number; envelope: TaskEnvelope }>();
  const runnerLeases = new Map<string, SessionLease>();
  let stopped = false;
  let hydrating = false;
  let stopPromise: Promise<void> | undefined;

  /** Lease + read + CAS write on one key, retrying while another replica holds it. */
  async function cas(
    key: string,
    build: (current: StoredValue | undefined) => DurableJson,
  ): Promise<{ written: boolean; record?: StoredValue }> {
    for (let attempt = 0; ; attempt++) {
      let result: Awaited<ReturnType<typeof facade.writeExactFromCurrent>>;
      try {
        result = await facade.writeExactFromCurrent(key, current => {
          try {
            return build(current);
          } catch (error) {
            if (error instanceof UnchangedRecord && current) error.current = current;
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof UnchangedRecord) {
          return { written: false, ...(error.current ? { record: error.current } : {}) };
        }
        throw error;
      } finally {
        await facade.releaseLease(key).catch(() => false);
      }
      if (result.kind === 'written') return { written: true, record: result.record };
      if ((result.kind === 'occupied' || result.kind === 'conflict' || result.kind === 'stale_lease')
          && attempt < CAS_RETRIES) {
        await sleep(CAS_BACKOFF_MS * (attempt + 1));
        continue;
      }
      throw new Error(`durable schedule write did not commit: ${result.kind}`);
    }
  }

  async function mergeIndex(appId: string, taskIds: readonly string[]): Promise<void> {
    await cas(durableScheduleIndexKey(appId), current => {
      const merged = current ? parseIndex(current.value, appId) : [];
      const present = new Set(merged);
      let added = 0;
      for (const taskId of taskIds) {
        if (present.has(taskId)) continue;
        present.add(taskId);
        merged.push(taskId);
        added += 1;
      }
      if (added === 0) throw new UnchangedRecord();
      return { version: RECORD_VERSION, type: INDEX_TYPE, larkAppId: appId, taskIds: merged, updatedAt: now() };
    });
  }

  function readSidecar(appId: string, taskId: string): SchedulePreconditionRecord | undefined {
    try { return readSchedulePreconditionRecord(appId, taskId, sidecarOptions); }
    catch { return undefined; }
  }

  /** The active precondition bound to this task generation; the newer copy wins. */
  function bindPrecondition(
    appId: string,
    task: ScheduledTask,
    durable?: SchedulePreconditionRecord,
  ): SchedulePreconditionRecord | undefined {
    const ref = task.preconditionRef;
    if (!ref) return undefined;
    let newest: SchedulePreconditionRecord | undefined;
    for (const candidate of [readSidecar(appId, task.id), durable]) {
      if (!candidate || candidate.state !== 'active' || candidate.preconditionRef !== ref) continue;
      if (!newest || candidate.updatedAt > newest.updatedAt) newest = candidate;
    }
    return newest;
  }

  /** A write that starts a new run is owned by this boot; a running run keeps its owner. */
  function ownerAfter(previous: TaskEnvelope, next: ScheduledTask): string | undefined {
    if (next.lastStatus !== 'running') return undefined;
    const prior = previous.row.task;
    if (prior.lastStatus === 'running' && prior.lastRunId === next.lastRunId) return previous.ownerBootId;
    return bootId;
  }

  function localRow(appId: string, taskId: string): ScheduleAuthorityReplicaRow | undefined {
    try { return local.getReplicaRow(appId, taskId); }
    catch { return undefined; }
  }

  function remember(appId: string, taskId: string, record: StoredValue): TaskEnvelope {
    const envelope = parseTaskEnvelope(record.value, appId, taskId);
    seen.set(durableScheduleTaskKey(appId, taskId), { appId, taskId, revision: record.revision, envelope });
    return envelope;
  }

  function installPrecondition(appId: string, taskId: string, envelope: TaskEnvelope): void {
    try {
      const current = readSidecar(appId, taskId);
      if (envelope.row.state === 'revoked' || (!envelope.precondition && !envelope.row.task.preconditionRef)) {
        if (current) removeSchedulePrecondition(appId, taskId, sidecarOptions);
      } else if (envelope.precondition
          && (!current || canonicalJson(current) !== canonicalJson(envelope.precondition))) {
        writeSchedulePreconditionRecord(envelope.precondition, sidecarOptions);
      }
    } catch (error) {
      logger.warn(`[schedule-durable] precondition of task ${taskId} not installed locally: ${errorText(error)}`);
    }
  }

  /** Overwrite the local cache row (and sidecar) with the durable value. */
  function install(appId: string, taskId: string, envelope: TaskEnvelope): void {
    const current = localRow(appId, taskId);
    if (!current || canonicalJson(current) !== canonicalJson(envelope.row)) {
      local.putReplicaRow(appId, envelope.row);
      try { if (!hydrating) input.onRowReplaced?.(appId, envelope.row); }
      catch (error) { logger.warn(`[schedule-durable] projection refresh for ${taskId} failed: ${errorText(error)}`); }
    }
    installPrecondition(appId, taskId, envelope);
  }

  function laneBusy(key: string): boolean {
    const lane = lanes.get(key);
    return !!lane && (lane.jobs.length > 0 || !!lane.running);
  }

  function pump(lane: Lane): void {
    if (lane.running || lane.stalled || stopped) return;
    lane.running = (async () => {
      // Let the synchronous caller finish first (e.g. activating a precondition
      // sidecar right after the task row was committed).
      await Promise.resolve();
      while (lane.jobs.length > 0 && !lane.stalled && !stopped) {
        const job = lane.jobs[0]!;
        try {
          await job.run();
          lane.jobs.shift();
          lane.failures = 0;
        } catch (error) {
          lane.failures += 1;
          lane.stalled = true;
          logger.warn(
            `[schedule-durable] write-through of task ${lane.taskId} failed (${lane.failures} in a row); `
            + `the local copy diverges from the durable store until a later tick retries it: ${errorText(error)}`,
          );
          // Claims queued behind a stalled write must not hang their caller.
          lane.jobs = lane.jobs.filter(queued => {
            if (queued.retry) return true;
            queued.abandon?.();
            return false;
          });
        }
      }
    })().finally(() => {
      lane.running = undefined;
      if (lane.jobs.length > 0) pump(lane);
      else if (!lane.stalled && lanes.get(lane.key) === lane) lanes.delete(lane.key);
    });
  }

  function enqueue(appId: string, taskId: string, job: Job): void {
    if (stopped) {
      job.abandon?.();
      return;
    }
    const key = durableScheduleTaskKey(appId, taskId);
    let lane = lanes.get(key);
    if (!lane) {
      lane = { key, appId, taskId, jobs: [], stalled: false, failures: 0 };
      lanes.set(key, lane);
    }
    lane.jobs.push(job);
    pump(lane);
  }

  function replay(mutation: ScheduleAuthorityMutation, previous: TaskEnvelope | undefined): TaskEnvelope | undefined {
    switch (mutation.kind) {
      case 'created':
        if (previous) {
          if (previous.row.task.createdAt !== mutation.row.task.createdAt) {
            logger.warn(
              `[schedule-durable] task id ${mutation.taskId} already exists in the durable store; `
              + 'keeping the durable copy',
            );
          }
          return undefined;
        }
        return {
          row: mutation.row,
          ...withPrecondition(bindPrecondition(mutation.appId, mutation.row.task)),
        };
      case 'updated': {
        const base: TaskEnvelope = previous ?? { row: mutation.before };
        if (base.row.state === 'revoked') return undefined;
        const task = mutation.mutate(structuredClone(base.row.task));
        if (!task) return undefined;
        const owner = ownerAfter(base, task);
        return {
          row: { ...base.row, task, state: scheduleAuthorityStateFor(task) },
          ...withPrecondition(bindPrecondition(mutation.appId, task, base.precondition)),
          ...(owner ? { ownerBootId: owner } : {}),
        };
      }
      case 'revoked':
        if (previous?.row.state === 'revoked') return undefined;
        return { row: { ...(previous?.row ?? mutation.row), state: 'revoked' } };
      case 'rolled_back':
        if (!previous || previous.row.state === 'revoked'
            || previous.row.kind !== 'direct' || previous.row.grantId) return undefined;
        return { row: { ...previous.row, state: 'revoked' } };
    }
  }

  function writeThrough(mutation: ScheduleAuthorityMutation): void {
    const { appId, taskId } = mutation;
    const key = durableScheduleTaskKey(appId, taskId);
    enqueue(appId, taskId, {
      retry: true,
      run: async () => {
        // Index before the task key: a dangling index entry is skipped by
        // readers, a task key missing from the index would be invisible.
        if (!seen.has(key) && mutation.kind !== 'rolled_back') await mergeIndex(appId, [taskId]);
        const outcome = await cas(key, current => {
          const previous = current ? parseTaskEnvelope(current.value, appId, taskId) : undefined;
          const next = replay(mutation, previous);
          if (!next) throw new UnchangedRecord();
          return serializeTask(appId, taskId, next, now());
        });
        if (!outcome.record) return;
        const envelope = remember(appId, taskId, outcome.record);
        // Later queued jobs install their own result; installing this one
        // now would briefly undo those newer local mutations.
        if ((lanes.get(key)?.jobs.length ?? 0) <= 1) install(appId, taskId, envelope);
      },
    });
  }

  async function upload(appId: string, row: ScheduleAuthorityReplicaRow): Promise<void> {
    const taskId = row.task.id;
    try {
      const outcome = await cas(durableScheduleTaskKey(appId, taskId), current => {
        if (current) throw new UnchangedRecord();
        // Ownerless: a run left `running` by a previous boot is reaped as interrupted.
        return serializeTask(appId, taskId, {
          row,
          ...withPrecondition(bindPrecondition(appId, row.task)),
        }, now());
      });
      if (outcome.record) install(appId, taskId, remember(appId, taskId, outcome.record));
    } catch (error) {
      logger.warn(`[schedule-durable] upload of task ${taskId} failed: ${errorText(error)}`);
    }
  }

  async function heartbeat(appId: string): Promise<void> {
    if (stopped) return;
    const held = runnerLeases.get(appId);
    if (held) {
      const renewed = await store.renewSessionLease({ lease: held, leaseDurationMs: RUNNER_LEASE_MS });
      if (renewed.kind === 'applied') {
        runnerLeases.set(appId, renewed.lease);
        return;
      }
      runnerLeases.delete(appId);
    }
    const acquired = await store.acquireSessionLease({
      sessionKey: durableScheduleRunnerKey(appId, bootId),
      ownerId: `schedule-runner:${bootId}`,
      leaseDurationMs: RUNNER_LEASE_MS,
    });
    if (acquired.kind === 'acquired') runnerLeases.set(appId, acquired.lease);
    else logger.warn(`[schedule-durable] runner lease of this daemon is held by ${acquired.ownerId}`);
  }

  async function runnerAlive(appId: string, ownerBootId: string): Promise<boolean> {
    const probe = await store.acquireSessionLease({
      sessionKey: durableScheduleRunnerKey(appId, ownerBootId),
      ownerId: `schedule-reaper:${bootId}`,
      leaseDurationMs: PROBE_LEASE_MS,
    });
    if (probe.kind === 'occupied') return true;
    await store.releaseSessionLease(probe.lease).catch(() => undefined);
    return false;
  }

  async function flush(): Promise<void> {
    for (;;) {
      const running = [...lanes.values()].flatMap(lane => lane.running ? [lane.running] : []);
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  async function hydrateApp(appId: string, legacyTasks: () => readonly ScheduledTask[]): Promise<void> {
    await heartbeat(appId);
    const indexRecord = await store.readAuxiliaryState(durableScheduleIndexKey(appId));
    let uploads: ScheduleAuthorityReplicaRow[];
    if (indexRecord) {
      // The durable copy is authoritative: never import a Pod-local legacy projection.
      local.initializeApp(appId, []);
      const installed = new Set<string>();
      for (const taskId of parseIndex(indexRecord.value, appId)) {
        const record = await store.readAuxiliaryState(durableScheduleTaskKey(appId, taskId));
        if (!record) continue;
        try {
          install(appId, taskId, remember(appId, taskId, record));
          installed.add(taskId);
        } catch (error) {
          logger.warn(`[schedule-durable] durable task ${taskId} not loaded: ${errorText(error)}`);
        }
      }
      // Rows this Pod committed but never replicated (same-Pod restart).
      uploads = local.listReplicaRows(appId).filter(row => !installed.has(row.task.id));
    } else {
      local.initializeApp(appId, legacyTasks());
      uploads = local.listReplicaRows(appId);
    }
    if (uploads.length > 0) {
      await mergeIndex(appId, uploads.map(row => row.task.id));
      for (const row of uploads) await upload(appId, row);
    }
  }

  return {
    bootId,

    async hydrate(appId, legacyTasks) {
      hydrating = true;
      try {
        await hydrateApp(appId, legacyTasks);
      } finally {
        hydrating = false;
      }
      local.setMutationObserver(mutation => {
        try { writeThrough(mutation); }
        catch (error) { logger.warn(`[schedule-durable] write-through not queued: ${errorText(error)}`); }
      });
    },

    async sync(appId) {
      if (stopped) return;
      for (const lane of lanes.values()) {
        if (lane.appId !== appId || !lane.stalled) continue;
        lane.stalled = false;
        pump(lane);
      }
      const indexRecord = await store.readAuxiliaryState(durableScheduleIndexKey(appId));
      if (!indexRecord) return;
      for (const taskId of parseIndex(indexRecord.value, appId)) {
        const key = durableScheduleTaskKey(appId, taskId);
        // Tombstones are terminal: nothing ever rewrites a revoked task.
        if (seen.has(key) && localRow(appId, taskId)?.state === 'revoked') continue;
        const record = await store.readAuxiliaryState(key);
        // A task with queued local writes keeps its optimistic local row; the
        // write-through installs the merged durable value when it commits.
        if (!record || laneBusy(key)) continue;
        try {
          install(appId, taskId, remember(appId, taskId, record));
        } catch (error) {
          logger.warn(`[schedule-durable] durable task ${taskId} not synced: ${errorText(error)}`);
        }
      }
    },

    claim(appId, taskId, mutate, options = {}) {
      const key = durableScheduleTaskKey(appId, taskId);
      if (stopped || lanes.get(key)?.stalled) return Promise.resolve(undefined);
      return new Promise(resolve => {
        enqueue(appId, taskId, {
          retry: false,
          abandon: () => resolve(undefined),
          run: async () => {
            try {
              const observed = seen.get(key)?.revision;
              const outcome = await cas(key, current => {
                if (!current) throw new UnchangedRecord();
                // Someone else wrote since this replica last looked: the run it
                // observed may already be claimed or settled. Retry next tick.
                if (options.requireObservedRevision !== false && current.revision !== observed) {
                  throw new UnchangedRecord();
                }
                const previous = parseTaskEnvelope(current.value, appId, taskId);
                if (previous.row.state === 'revoked') throw new UnchangedRecord();
                const task = mutate(structuredClone(previous.row.task));
                if (!task || task.lastStatus !== 'running') throw new UnchangedRecord();
                return serializeTask(appId, taskId, {
                  row: { ...previous.row, task, state: scheduleAuthorityStateFor(task) },
                  ...withPrecondition(previous.precondition),
                  ownerBootId: bootId,
                }, now());
              });
              const envelope = outcome.record ? remember(appId, taskId, outcome.record) : undefined;
              if (envelope) install(appId, taskId, envelope);
              resolve(outcome.written && envelope ? structuredClone(envelope.row.task) : undefined);
            } catch (error) {
              logger.warn(`[schedule-durable] claim of task ${taskId} failed: ${errorText(error)}`);
              resolve(undefined);
            }
          },
        });
      });
    },

    heartbeat,

    async findOrphanedRuns(appId) {
      const orphans: Array<{ taskId: string; runId?: string }> = [];
      const alive = new Map<string, boolean>();
      for (const [key, entry] of seen) {
        if (entry.appId !== appId || laneBusy(key)) continue;
        const { row, ownerBootId } = entry.envelope;
        if (row.state === 'revoked' || row.task.lastStatus !== 'running' || ownerBootId === bootId) continue;
        if (ownerBootId) {
          if (!alive.has(ownerBootId)) alive.set(ownerBootId, await runnerAlive(appId, ownerBootId));
          if (alive.get(ownerBootId)) continue;
        }
        orphans.push({ taskId: entry.taskId, ...(row.task.lastRunId ? { runId: row.task.lastRunId } : {}) });
      }
      return orphans;
    },

    flush,

    stop(timeoutMs = 5_000) {
      stopPromise ??= (async () => {
        const deadline = Date.now() + timeoutMs;
        await Promise.race([flush(), sleep(timeoutMs, undefined, { ref: false })]);
        stopped = true;
        local.setMutationObserver(undefined);
        let dropped = 0;
        for (const lane of lanes.values()) {
          for (const job of lane.jobs.splice(0)) {
            if (job.retry) dropped += 1;
            job.abandon?.();
          }
        }
        if (dropped > 0) {
          logger.warn(`[schedule-durable] ${dropped} schedule write-through(s) not replicated before shutdown`);
        }
        for (const lease of runnerLeases.values()) {
          await store.releaseSessionLease(lease).catch(() => undefined);
        }
        runnerLeases.clear();
        await facade.stop(Math.min(timeoutMs, Math.max(0, deadline - Date.now())));
      })();
      return stopPromise;
    },
  };
}

function withPrecondition(
  precondition: SchedulePreconditionRecord | undefined,
): { precondition?: SchedulePreconditionRecord } {
  return precondition ? { precondition } : {};
}
