import { normalizeRemoteRunnerBackendState } from '../adapters/backend/remote-runner-protocol.js';
import type { DurableCoordinationStore, SessionLease } from './durable-coordination.js';
import { durableDirectSessionControlEvent } from './durable-lark-session-control.js';
import { parseDurablePrimarySessionRecord } from './durable-session-primary.js';

const DEFAULT_PAGE_LIMIT = 40;
const OPERATION_PREFIX = 'trusted-host.remote-orphan';
const DEFAULT_PAGE_SIZE = 256;
const DEFAULT_LEASE_MS = 60_000;

export interface DurableRemoteOrphanScanResult {
  scanned: number;
  candidates: number;
  occupied: number;
  enqueued: number;
  duplicates: number;
  invalid: number;
  unsupported?: true;
}

export interface DurableRemoteOrphanReconcilerOptions {
  store: DurableCoordinationStore;
  larkAppId: string;
  ownerId: string;
  hasLocalOwner(sessionId: string): boolean;
  leaseDurationMs?: number;
  pageLimit?: number;
  pageSize?: number;
  now?: () => number;
  onError?(error: unknown): void;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function candidateForApp(
  raw: Awaited<ReturnType<NonNullable<DurableCoordinationStore['listSessions']>>>['records'][number],
  larkAppId: string,
): ReturnType<typeof parseDurablePrimarySessionRecord> | undefined {
  const parsed = parseDurablePrimarySessionRecord(raw);
  const session = parsed.session;
  if (session.larkAppId !== larkAppId || session.status !== 'active') return undefined;
  if (session.backendType !== 'remote-runner' && session.cliId !== 'remote-runner') return undefined;
  const remote = normalizeRemoteRunnerBackendState(session.remoteBackendState);
  if (!remote?.remoteSessionId || remote.generation < 1) return undefined;
  if (session.title?.startsWith('Adopt:') || session.adoptedFrom) return undefined;
  return parsed;
}

/**
 * Orphan controls are pinned to the canonical lineage they were scanned from:
 * the remote generation and the canonical record revision. A control whose
 * Session moved on (a local owner took over and committed, or the remote was
 * replaced) is stale and must settle as a no-op instead of terminalizing a
 * Session that is no longer orphaned. The revision also keeps a later orphan
 * of the same generation from colliding with an earlier, settled control.
 * Controls enqueued by older daemons carry only the generation.
 */
export function durableRemoteOrphanOperationId(input: {
  larkAppId: string;
  sessionId: string;
  generation: number;
  revision: number;
}): string {
  return [
    OPERATION_PREFIX,
    input.larkAppId,
    input.sessionId,
    String(input.generation),
    `r${input.revision}`,
  ].join(':');
}

export function parseDurableRemoteOrphanOperationId(
  operationId: string,
): { generation: number; revision?: number } | undefined {
  if (!operationId.startsWith(`${OPERATION_PREFIX}:`)) return undefined;
  const parts = operationId.split(':');
  let revision: number | undefined;
  const last = parts[parts.length - 1] ?? '';
  if (/^r\d+$/.test(last)) {
    revision = Number(last.slice(1));
    parts.pop();
  }
  const generationText = parts[parts.length - 1] ?? '';
  if (parts.length < 4 || !/^\d+$/.test(generationText)) return undefined;
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation)
      || (revision !== undefined && !Number.isSafeInteger(revision))) return undefined;
  return revision === undefined ? { generation } : { generation, revision };
}

function hasStrandedRecoveredTurn(session: ReturnType<typeof parseDurablePrimarySessionRecord>['session']): boolean {
  return session.lastFailedTurn?.recoveredRemoteTurn === true;
}

/**
 * Discover canonical-only Remote Runner Sessions, fence out a still-live owner,
 * then enqueue one provider-neutral orphan reconciliation control. The control
 * does not itself assert that the remote is gone: only a provider that
 * negotiated `orphan_reconciliation` may return `ready` for that proof.
 */
export async function scanDurableRemoteOrphans(
  options: DurableRemoteOrphanReconcilerOptions,
): Promise<DurableRemoteOrphanScanResult> {
  const result: DurableRemoteOrphanScanResult = {
    scanned: 0,
    candidates: 0,
    occupied: 0,
    enqueued: 0,
    duplicates: 0,
    invalid: 0,
  };
  if (!options.store.listSessions) return { ...result, unsupported: true };
  const leaseDurationMs = boundedInteger(
    options.leaseDurationMs ?? DEFAULT_LEASE_MS,
    'leaseDurationMs',
    1_000,
    300_000,
  );
  const pageLimit = boundedInteger(options.pageLimit ?? DEFAULT_PAGE_LIMIT, 'pageLimit', 1, 100);
  const pageSize = boundedInteger(options.pageSize ?? DEFAULT_PAGE_SIZE, 'pageSize', 1, 256);
  const now = options.now ?? Date.now;
  let afterSessionKey: string | undefined;
  for (let page = 0; page < pageLimit; page += 1) {
    const listed = await options.store.listSessions({
      ...(afterSessionKey ? { afterSessionKey } : {}),
      limit: pageSize,
    });
    for (const record of listed.records) {
      result.scanned += 1;
      let parsed: ReturnType<typeof parseDurablePrimarySessionRecord> | undefined;
      try {
        parsed = candidateForApp(record, options.larkAppId);
      } catch (error) {
        result.invalid += 1;
        try { options.onError?.(error); } catch { /* observation cannot alter reconciliation */ }
        continue;
      }
      if (!parsed
          || (options.hasLocalOwner(parsed.session.sessionId)
            && !hasStrandedRecoveredTurn(parsed.session))) continue;
      result.candidates += 1;
      const acquired = await options.store.acquireSessionLease({
        sessionKey: record.sessionKey,
        ownerId: options.ownerId,
        leaseDurationMs,
      });
      if (acquired.kind === 'occupied') {
        result.occupied += 1;
        continue;
      }
      const release: SessionLease = acquired.lease;
      try {
        const current = await options.store.readSession(record.sessionKey);
        if (!current || current.revision !== record.revision) continue;
        const currentParsed = candidateForApp(current, options.larkAppId);
        if (!currentParsed || currentParsed.session.sessionId !== parsed.session.sessionId
            || (options.hasLocalOwner(parsed.session.sessionId)
              && !hasStrandedRecoveredTurn(currentParsed.session))) continue;
        const remote = normalizeRemoteRunnerBackendState(currentParsed.session.remoteBackendState)!;
        const operationId = durableRemoteOrphanOperationId({
          larkAppId: options.larkAppId,
          sessionId: currentParsed.session.sessionId,
          generation: remote.generation,
          revision: current.revision,
        });
        const inserted = await options.store.enqueueInboxWithLease({
          lease: acquired.lease,
          event: durableDirectSessionControlEvent({
            source: 'trusted-host',
            larkAppId: options.larkAppId,
            operationId,
            action: 'terminalize_orphan',
            sessionId: currentParsed.session.sessionId,
            rootId: currentParsed.session.scope === 'chat'
              ? currentParsed.session.chatId
              : currentParsed.session.rootMessageId,
            cardMessageId: currentParsed.session.streamCardId,
            now: now(),
          }),
        });
        if (inserted.kind === 'conflict') {
          // A conflicting historical row is isolated to this Session. This is
          // especially important during rolling upgrades: an orphan control
          // persisted before partition isolation has the same stable event id
          // but the former ordinary Session partition. The legacy row remains
          // valid work for the backwards-compatible consumer; it must not
          // abort the scan and starve unrelated canonical-only Sessions.
          result.invalid += 1;
          try {
            options.onError?.(new Error(`durable orphan reconciliation conflict ${operationId}`));
          } catch { /* observation cannot alter reconciliation */ }
          continue;
        }
        if (inserted.kind === 'stale_lease') continue;
        if (inserted.kind === 'inserted') {
          result.enqueued += 1;
        } else {
          result.duplicates += 1;
        }
      } finally {
        await options.store.releaseSessionLease(release).catch(() => undefined);
      }
    }
    if (!listed.nextSessionKey) return result;
    afterSessionKey = listed.nextSessionKey;
  }
  throw new Error('durable orphan reconciliation session listing limit exceeded');
}

export interface DurableRemoteOrphanReconciler {
  ready: Promise<void>;
  scan(): Promise<DurableRemoteOrphanScanResult>;
  stop(): void;
}

export function startDurableRemoteOrphanReconciler(
  options: DurableRemoteOrphanReconcilerOptions & { intervalMs?: number },
): DurableRemoteOrphanReconciler {
  const intervalMs = boundedInteger(options.intervalMs ?? 60_000, 'intervalMs', 1_000, 3_600_000);
  let stopped = false;
  let running: Promise<DurableRemoteOrphanScanResult> | undefined;
  const scan = (): Promise<DurableRemoteOrphanScanResult> => {
    if (stopped) return Promise.resolve({
      scanned: 0, candidates: 0, occupied: 0, enqueued: 0, duplicates: 0, invalid: 0,
    });
    running ??= scanDurableRemoteOrphans(options).finally(() => { running = undefined; });
    return running;
  };
  const report = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* observers cannot alter reconciliation */ }
  };
  const ready = scan().then(() => undefined, report);
  const timer = setInterval(() => { void scan().catch(report); }, intervalMs);
  timer.unref?.();
  return {
    ready,
    scan,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
