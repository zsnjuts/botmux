import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDurableConfigCoordinator } from '../src/services/durable-config-coordinator.js';
import {
  assertDurableConfigMutationAllowed,
  runDurableConfigMutation,
  setDurableConfigCoordinator,
} from '../src/services/durable-config-mutation.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { invalidateGlobalConfigCache, mergeGlobalConfig } from '../src/global-config.js';

const dirs: string[] = [];

function contentSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function pathSha256(path: string): string {
  const normalized = resolve(path);
  return createHash('sha256')
    .update(join(realpathSync(dirname(normalized)), basename(normalized)))
    .digest('hex');
}

function lexicalPathSha256(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex');
}

async function seedLegacyRecord(
  store: SqliteDurableCoordinationStore,
  input: { scope: 'global'; path: string; phase: 'prepared' | 'committed' },
): Promise<void> {
  const key = `auxiliary::config-cas::${input.scope}`;
  const acquired = await store.acquireSessionLease({
    sessionKey: key,
    ownerId: 'legacy-seed',
    leaseDurationMs: 300_000,
  });
  if (acquired.kind !== 'acquired') throw new Error('failed to seed legacy record');
  const digest = contentSha256(input.path);
  await store.writeAuxiliaryState({
    lease: acquired.lease,
    expectedRevision: null,
    value: {
      version: 1,
      type: 'botmux.config.cas',
      scope: input.scope,
      phase: input.phase,
      operationId: 'legacy-operation',
      baseSha256: digest,
      contentSha256: digest,
      updatedAt: 1,
      audit: [],
    },
  });
  await store.releaseSessionLease(acquired.lease);
}

async function seedV2PathRecord(
  store: SqliteDurableCoordinationStore,
  input: {
    scope: 'global';
    path: string;
    pathSha256: string;
    contentSha256?: string;
    phase?: 'prepared' | 'committed';
  },
): Promise<void> {
  const key = `auxiliary::config-cas::${input.scope}`;
  const acquired = await store.acquireSessionLease({
    sessionKey: key,
    ownerId: 'v2-path-seed',
    leaseDurationMs: 300_000,
  });
  if (acquired.kind !== 'acquired') throw new Error('failed to seed v2 path record');
  const digest = input.contentSha256 ?? contentSha256(input.path);
  await store.writeAuxiliaryState({
    lease: acquired.lease,
    expectedRevision: null,
    value: {
      version: 2,
      type: 'botmux.config.cas',
      scope: input.scope,
      phase: input.phase ?? 'committed',
      operationId: 'v2-path-operation',
      pathSha256: input.pathSha256,
      baseSha256: digest,
      contentSha256: digest,
      updatedAt: 1,
      audit: [],
    },
  });
  await store.releaseSessionLease(acquired.lease);
}

function fixture() {
  let now = 1_800_000_000_000;
  const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-config-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ dashboard: { publicReadOnly: false }, secret: 'must-not-leak' }) + '\n');
  const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => now });
  const coordinator = createDurableConfigCoordinator({ store, ownerId: 'config-test', now: () => now });
  return { path, store, coordinator, advance: (ms: number) => { now += ms; } };
}

afterEach(() => {
  setDurableConfigCoordinator(undefined);
  invalidateGlobalConfigCache();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable config coordinator', () => {
  it('serializes a mutation and records hash-only audit metadata', async () => {
    const { path, store, coordinator } = fixture();
    await coordinator.run({
      scope: 'global',
      path,
      mutation: async () => {
        const config = JSON.parse(readFileSync(path, 'utf8'));
        config.dashboard.publicReadOnly = true;
        writeFileSync(path, JSON.stringify(config) + '\n');
      },
    });

    const record = await store.readAuxiliaryState('auxiliary::config-cas::global');
    expect(record).toMatchObject({
      revision: 2,
      value: { version: 2, phase: 'committed', pathSha256: pathSha256(path) },
    });
    expect(JSON.stringify(record)).not.toContain('must-not-leak');
    expect(JSON.stringify(record)).not.toContain(path);
    expect(record?.value).toMatchObject({
      audit: [expect.objectContaining({
        outcome: 'committed',
        changedPaths: ['dashboard'],
      })],
    });
    await store.close();
  });

  it('isolates group-context configuration from the global config CAS key', async () => {
    const { store, coordinator } = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-group-context-'));
    dirs.push(dir);
    const path = join(dir, 'group-context-settings.json');
    await coordinator.run({
      scope: 'group-context',
      path,
      mutation: async () => {
        writeFileSync(path, JSON.stringify({
          schemaVersion: 1,
          configs: { oc_group: { enabled: true } },
        }) + '\n');
      },
    });

    expect(await store.readAuxiliaryState('auxiliary::config-cas::group-context'))
      .toMatchObject({ revision: 2, value: { phase: 'committed', scope: 'group-context' } });
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global')).toBeUndefined();
    await store.close();
  });

  it('rejects another writer while the config lease is held', async () => {
    const { path, store, coordinator } = fixture();
    const peer = createDurableConfigCoordinator({ store, ownerId: 'config-peer' });
    let unblock!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const first = coordinator.run({
      scope: 'global',
      path,
      mutation: async () => {
        entered();
        await blocked;
      },
    });
    await ready;
    await expect(peer.run({ scope: 'global', path, mutation: async () => undefined }))
      .rejects.toThrow('durable_config_busy');
    unblock();
    await first;
    await store.close();
  });

  it('recovers a prepared write after the file changed but the CAS commit failed', async () => {
    const { path, store } = fixture();
    let writes = 0;
    const faultStore = {
      acquireSessionLease: (value: Parameters<typeof store.acquireSessionLease>[0]) => store.acquireSessionLease(value),
      renewSessionLease: (value: Parameters<typeof store.renewSessionLease>[0]) => store.renewSessionLease(value),
      releaseSessionLease: (value: Parameters<typeof store.releaseSessionLease>[0]) => store.releaseSessionLease(value),
      readAuxiliaryState: (key: string) => store.readAuxiliaryState(key),
      writeAuxiliaryState: async (value: Parameters<typeof store.writeAuxiliaryState>[0]) => {
        writes += 1;
        if (writes === 2) throw new Error('simulated commit loss');
        return store.writeAuxiliaryState(value);
      },
    };
    const first = createDurableConfigCoordinator({ store: faultStore, ownerId: 'config-fault' });
    await expect(first.run({
      scope: 'global',
      path,
      mutation: async () => writeFileSync(path, JSON.stringify({ recovered: true }) + '\n'),
    })).rejects.toThrow('simulated commit loss');

    const recovery = createDurableConfigCoordinator({ store, ownerId: 'config-recovery' });
    await recovery.run({ scope: 'global', path, mutation: async () => undefined });
    const record = await store.readAuxiliaryState('auxiliary::config-cas::global');
    expect(record?.value).toMatchObject({
      phase: 'committed',
      audit: [
        expect.objectContaining({ outcome: 'recovered_changed', changedPaths: ['<recovered>'] }),
        expect.objectContaining({ outcome: 'committed', changedPaths: [] }),
      ],
    });
    await store.close();
  });

  it('fails closed when the shared file drifts after a committed revision', async () => {
    const { path, store, coordinator } = fixture();
    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
    writeFileSync(path, JSON.stringify({ editedOutsideCoordinator: true }) + '\n');
    await expect(coordinator.run({ scope: 'global', path, mutation: async () => undefined }))
      .rejects.toThrow('durable_config_content_drift');
    await store.close();
  });

  it('inspects content drift without exposing configuration bytes', async () => {
    const { path, store, coordinator } = fixture();
    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
    const committedSha256 = contentSha256(path);
    writeFileSync(path, JSON.stringify({ editedOutsideCoordinator: true, secret: 'still-private' }) + '\n');

    const result = await coordinator.inspect({ scope: 'global', path });

    expect(result).toMatchObject({
      scope: 'global',
      status: 'content_drift',
      committedSha256,
      fileSha256: contentSha256(path),
      pathMatches: true,
    });
    expect(JSON.stringify(result)).not.toContain('still-private');
    expect(JSON.stringify(result)).not.toContain(path);
    await store.close();
  });

  it('reconciles an explicitly confirmed external write under the durable lease', async () => {
    const { path, store, coordinator } = fixture();
    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
    const committedSha256 = contentSha256(path);
    writeFileSync(path, JSON.stringify({ editedOutsideCoordinator: true }) + '\n');
    const fileSha256 = contentSha256(path);

    const result = await coordinator.reconcile({
      scope: 'global',
      path,
      expectedCommittedSha256: committedSha256,
      expectedFileSha256: fileSha256,
    });

    expect(result).toMatchObject({
      status: 'in_sync',
      recordRevision: 3,
      committedSha256: fileSha256,
      fileSha256,
    });
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({
        revision: 3,
        value: {
          phase: 'committed',
          baseSha256: committedSha256,
          contentSha256: fileSha256,
          audit: [
            expect.objectContaining({ outcome: 'committed' }),
            expect.objectContaining({
              outcome: 'reconciled_external',
              baseSha256: committedSha256,
              contentSha256: fileSha256,
              changedPaths: ['<external-reconcile>'],
            }),
          ],
        },
      });
    await expect(coordinator.run({ scope: 'global', path, mutation: async () => undefined }))
      .resolves.toBeUndefined();
    await store.close();
  });

  it('rejects stale reconcile hashes without changing the CAS record', async () => {
    const { path, store, coordinator } = fixture();
    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
    const committedSha256 = contentSha256(path);
    writeFileSync(path, JSON.stringify({ editedOutsideCoordinator: true }) + '\n');
    const fileSha256 = contentSha256(path);

    await expect(coordinator.reconcile({
      scope: 'global',
      path,
      expectedCommittedSha256: '0'.repeat(64),
      expectedFileSha256: fileSha256,
    })).rejects.toThrow('durable_config_reconcile_committed_sha_mismatch');
    await expect(coordinator.reconcile({
      scope: 'global',
      path,
      expectedCommittedSha256: committedSha256,
      expectedFileSha256: 'f'.repeat(64),
    })).rejects.toThrow('durable_config_reconcile_file_sha_mismatch');
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 2, value: { contentSha256: committedSha256 } });
    await store.close();
  });

  it('binds a matching committed v1 record to the normalized path before continuing', async () => {
    const { path, store, coordinator } = fixture();
    await seedLegacyRecord(store, { scope: 'global', path, phase: 'committed' });

    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });

    const record = await store.readAuxiliaryState('auxiliary::config-cas::global');
    expect(record).toMatchObject({
      revision: 4,
      value: { version: 2, phase: 'committed', pathSha256: pathSha256(path) },
    });
    await store.close();
  });

  it('uses the same CAS identity through a stable directory alias', async () => {
    const { path, store, coordinator } = fixture();
    const aliasDir = join(path, '..', 'pinned-control');
    symlinkSync(join(path, '..'), aliasDir, 'dir');
    const aliasPath = join(aliasDir, 'config.json');

    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
    await coordinator.run({ scope: 'global', path: aliasPath, mutation: async () => undefined });

    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 4, value: { pathSha256: pathSha256(path) } });
    await store.close();
  });

  it.skipIf(process.platform !== 'linux')('uses the canonical identity through a pinned procfs directory fd', async () => {
    const { path, store, coordinator } = fixture();
    const directoryFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const pinnedPath = `/proc/${process.pid}/fd/${directoryFd}/${basename(path)}`;
      await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
      await coordinator.run({ scope: 'global', path: pinnedPath, mutation: async () => undefined });

      expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
        .toMatchObject({ revision: 4, value: { pathSha256: pathSha256(path) } });
    } finally {
      closeSync(directoryFd);
      await store.close();
    }
  });

  it('rebinds a matching lexical v2 alias record to the canonical identity', async () => {
    const { path, store, coordinator } = fixture();
    const aliasDir = join(path, '..', 'legacy-pinned-control');
    symlinkSync(join(path, '..'), aliasDir, 'dir');
    const aliasPath = join(aliasDir, 'config.json');
    const acquired = await store.acquireSessionLease({
      sessionKey: 'auxiliary::config-cas::global',
      ownerId: 'legacy-v2-seed',
      leaseDurationMs: 300_000,
    });
    if (acquired.kind !== 'acquired') throw new Error('failed to seed lexical v2 record');
    const digest = contentSha256(path);
    await store.writeAuxiliaryState({
      lease: acquired.lease,
      expectedRevision: null,
      value: {
        version: 2,
        type: 'botmux.config.cas',
        scope: 'global',
        phase: 'committed',
        operationId: 'legacy-v2-operation',
        pathSha256: lexicalPathSha256(aliasPath),
        baseSha256: digest,
        contentSha256: digest,
        updatedAt: 1,
        audit: [],
      },
    });
    await store.releaseSessionLease(acquired.lease);

    await coordinator.run({ scope: 'global', path: aliasPath, mutation: async () => undefined });

    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 4, value: { pathSha256: pathSha256(path) } });
    await store.close();
  });

  it('explicitly rebinds a stale v2 path only with the complete hash and revision proof', async () => {
    const { path, store, coordinator } = fixture();
    const oldPathSha256 = '1'.repeat(64);
    const digest = contentSha256(path);
    await seedV2PathRecord(store, { scope: 'global', path, pathSha256: oldPathSha256 });

    expect(await coordinator.inspect({ scope: 'global', path })).toMatchObject({
      status: 'path_mismatch',
      recordRevision: 1,
      boundPathSha256: oldPathSha256,
      currentPathSha256: pathSha256(path),
      committedSha256: digest,
      fileSha256: digest,
    });
    const result = await coordinator.rebindPath({
      scope: 'global',
      path,
      expectedRecordRevision: 1,
      expectedBoundPathSha256: oldPathSha256,
      expectedCurrentPathSha256: pathSha256(path),
      expectedCommittedSha256: digest,
      expectedFileSha256: digest,
    });

    expect(result).toMatchObject({
      status: 'in_sync',
      recordRevision: 2,
      boundPathSha256: pathSha256(path),
      currentPathSha256: pathSha256(path),
      committedSha256: digest,
      fileSha256: digest,
    });
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({
        revision: 2,
        value: {
          pathSha256: pathSha256(path),
          audit: [{
            outcome: 'reconciled_external',
            baseSha256: digest,
            contentSha256: digest,
            basePathSha256: oldPathSha256,
            pathSha256: pathSha256(path),
            changedPaths: ['<path-identity-rebind>'],
          }],
        },
      });
    await expect(coordinator.run({ scope: 'global', path, mutation: async () => undefined }))
      .resolves.toBeUndefined();
    await store.close();
  });

  it('rejects stale or incomplete path rebind proof without changing the record', async () => {
    const { path, store, coordinator } = fixture();
    const oldPathSha256 = '2'.repeat(64);
    const digest = contentSha256(path);
    await seedV2PathRecord(store, { scope: 'global', path, pathSha256: oldPathSha256 });
    const valid = {
      scope: 'global' as const,
      path,
      expectedRecordRevision: 1,
      expectedBoundPathSha256: oldPathSha256,
      expectedCurrentPathSha256: pathSha256(path),
      expectedCommittedSha256: digest,
      expectedFileSha256: digest,
    };

    await expect(coordinator.rebindPath({ ...valid, expectedRecordRevision: 2 }))
      .rejects.toThrow('durable_config_rebind_revision_mismatch');
    await expect(coordinator.rebindPath({ ...valid, expectedBoundPathSha256: '3'.repeat(64) }))
      .rejects.toThrow('durable_config_rebind_bound_path_sha_mismatch');
    await expect(coordinator.rebindPath({ ...valid, expectedCurrentPathSha256: '4'.repeat(64) }))
      .rejects.toThrow('durable_config_rebind_current_path_sha_mismatch');
    await expect(coordinator.rebindPath({ ...valid, expectedCommittedSha256: '5'.repeat(64) }))
      .rejects.toThrow('durable_config_rebind_committed_sha_mismatch');
    await expect(coordinator.rebindPath({ ...valid, expectedFileSha256: '6'.repeat(64) }))
      .rejects.toThrow('durable_config_rebind_file_sha_mismatch');
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 1, value: { pathSha256: oldPathSha256, audit: [] } });
    await store.close();
  });

  it('never combines path rebinding with content reconciliation', async () => {
    const { path, store, coordinator } = fixture();
    const oldPathSha256 = '7'.repeat(64);
    const committedSha256 = contentSha256(path);
    await seedV2PathRecord(store, { scope: 'global', path, pathSha256: oldPathSha256 });
    writeFileSync(path, JSON.stringify({ changedOutsideCoordinator: true }) + '\n');
    const fileSha256 = contentSha256(path);

    await expect(coordinator.rebindPath({
      scope: 'global',
      path,
      expectedRecordRevision: 1,
      expectedBoundPathSha256: oldPathSha256,
      expectedCurrentPathSha256: pathSha256(path),
      expectedCommittedSha256: committedSha256,
      expectedFileSha256: fileSha256,
    })).rejects.toThrow('durable_config_rebind_content_drift');
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 1, value: { pathSha256: oldPathSha256, audit: [] } });
    await store.close();
  });

  it('rejects path rebinding for records that are not a mismatched committed v2 generation', async () => {
    const uninitialized = fixture();
    const uninitializedDigest = contentSha256(uninitialized.path);
    await expect(uninitialized.coordinator.rebindPath({
      scope: 'global',
      path: uninitialized.path,
      expectedRecordRevision: 1,
      expectedBoundPathSha256: '8'.repeat(64),
      expectedCurrentPathSha256: pathSha256(uninitialized.path),
      expectedCommittedSha256: uninitializedDigest,
      expectedFileSha256: uninitializedDigest,
    })).rejects.toThrow('durable_config_rebind_uninitialized');
    await uninitialized.store.close();

    const legacy = fixture();
    const legacyDigest = contentSha256(legacy.path);
    await seedLegacyRecord(legacy.store, { scope: 'global', path: legacy.path, phase: 'committed' });
    await expect(legacy.coordinator.rebindPath({
      scope: 'global',
      path: legacy.path,
      expectedRecordRevision: 1,
      expectedBoundPathSha256: '9'.repeat(64),
      expectedCurrentPathSha256: pathSha256(legacy.path),
      expectedCommittedSha256: legacyDigest,
      expectedFileSha256: legacyDigest,
    })).rejects.toThrow('durable_config_rebind_requires_committed_v2');
    await legacy.store.close();

    const prepared = fixture();
    const preparedDigest = contentSha256(prepared.path);
    await seedV2PathRecord(prepared.store, {
      scope: 'global',
      path: prepared.path,
      pathSha256: 'a'.repeat(64),
      phase: 'prepared',
    });
    await expect(prepared.coordinator.rebindPath({
      scope: 'global',
      path: prepared.path,
      expectedRecordRevision: 1,
      expectedBoundPathSha256: 'a'.repeat(64),
      expectedCurrentPathSha256: pathSha256(prepared.path),
      expectedCommittedSha256: preparedDigest,
      expectedFileSha256: preparedDigest,
    })).rejects.toThrow('durable_config_rebind_requires_committed_v2');
    await prepared.store.close();

    const matched = fixture();
    const matchedDigest = contentSha256(matched.path);
    await seedV2PathRecord(matched.store, {
      scope: 'global',
      path: matched.path,
      pathSha256: pathSha256(matched.path),
    });
    await expect(matched.coordinator.rebindPath({
      scope: 'global',
      path: matched.path,
      expectedRecordRevision: 1,
      expectedBoundPathSha256: pathSha256(matched.path),
      expectedCurrentPathSha256: pathSha256(matched.path),
      expectedCommittedSha256: matchedDigest,
      expectedFileSha256: matchedDigest,
    })).rejects.toThrow('durable_config_rebind_not_mismatched');
    await matched.store.close();
  });

  it('rejects a current path proof that changes while waiting for the shared lease', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-config-rebind-race-'));
    dirs.push(dir);
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    const alias = join(dir, 'current');
    const fileName = 'config.json';
    const firstPath = join(first, fileName);
    const secondPath = join(second, fileName);
    const aliasPath = join(alias, fileName);
    const contents = JSON.stringify({ sameBytes: true }) + '\n';
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(firstPath, contents);
    writeFileSync(secondPath, contents);
    symlinkSync(first, alias, 'dir');

    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'));
    const oldPathSha256 = 'b'.repeat(64);
    await seedV2PathRecord(store, {
      scope: 'global',
      path: aliasPath,
      pathSha256: oldPathSha256,
    });
    let reachedAcquire!: () => void;
    let releaseAcquire!: () => void;
    const acquireReached = new Promise<void>(resolve => { reachedAcquire = resolve; });
    const acquireGate = new Promise<void>(resolve => { releaseAcquire = resolve; });
    const gatedStore = {
      acquireSessionLease: async (...args: Parameters<typeof store.acquireSessionLease>) => {
        reachedAcquire();
        await acquireGate;
        return store.acquireSessionLease(...args);
      },
      renewSessionLease: store.renewSessionLease.bind(store),
      releaseSessionLease: store.releaseSessionLease.bind(store),
      readAuxiliaryState: store.readAuxiliaryState.bind(store),
      writeAuxiliaryState: store.writeAuxiliaryState.bind(store),
    };
    const coordinator = createDurableConfigCoordinator({ store: gatedStore, ownerId: 'race-test' });
    const digest = contentSha256(aliasPath);
    const staleCurrentPathSha256 = pathSha256(aliasPath);
    const rebind = coordinator.rebindPath({
      scope: 'global',
      path: aliasPath,
      expectedRecordRevision: 1,
      expectedBoundPathSha256: oldPathSha256,
      expectedCurrentPathSha256: staleCurrentPathSha256,
      expectedCommittedSha256: digest,
      expectedFileSha256: digest,
    });

    await acquireReached;
    rmSync(alias);
    symlinkSync(second, alias, 'dir');
    releaseAcquire();
    await expect(rebind).rejects.toThrow('durable_config_rebind_current_path_sha_mismatch');
    expect(pathSha256(aliasPath)).not.toBe(staleCurrentPathSha256);
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 1, value: { pathSha256: oldPathSha256, audit: [] } });
    await store.close();
  });

  it('rolls back a rebind when the path identity changes during the CAS commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-config-rebind-commit-path-'));
    dirs.push(dir);
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    const alias = join(dir, 'current');
    const fileName = 'config.json';
    const aliasPath = join(alias, fileName);
    const contents = JSON.stringify({ sameBytes: true }) + '\n';
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, fileName), contents);
    writeFileSync(join(second, fileName), contents);
    symlinkSync(first, alias, 'dir');

    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'));
    const oldPathSha256 = 'c'.repeat(64);
    await seedV2PathRecord(store, {
      scope: 'global',
      path: aliasPath,
      pathSha256: oldPathSha256,
    });
    let reachedCommit!: () => void;
    let releaseCommit!: () => void;
    const commitReached = new Promise<void>(resolve => { reachedCommit = resolve; });
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
    let writes = 0;
    const gatedStore = {
      acquireSessionLease: store.acquireSessionLease.bind(store),
      renewSessionLease: store.renewSessionLease.bind(store),
      releaseSessionLease: store.releaseSessionLease.bind(store),
      readAuxiliaryState: store.readAuxiliaryState.bind(store),
      writeAuxiliaryState: async (...args: Parameters<typeof store.writeAuxiliaryState>) => {
        writes += 1;
        if (writes === 1) {
          reachedCommit();
          await commitGate;
        }
        return store.writeAuxiliaryState(...args);
      },
    };
    const coordinator = createDurableConfigCoordinator({ store: gatedStore, ownerId: 'race-test' });
    const digest = contentSha256(aliasPath);
    const currentPathSha256 = pathSha256(aliasPath);
    const rebind = coordinator.rebindPath({
      scope: 'global',
      path: aliasPath,
      expectedRecordRevision: 1,
      expectedBoundPathSha256: oldPathSha256,
      expectedCurrentPathSha256: currentPathSha256,
      expectedCommittedSha256: digest,
      expectedFileSha256: digest,
    });

    await commitReached;
    rmSync(alias);
    symlinkSync(second, alias, 'dir');
    releaseCommit();
    await expect(rebind).rejects.toThrow('durable_config_rebind_current_path_sha_mismatch');
    const record = await store.readAuxiliaryState('auxiliary::config-cas::global');
    expect(record).toMatchObject({
      revision: 3,
      value: {
        pathSha256: oldPathSha256,
        audit: [{
          outcome: 'failed_unchanged',
          basePathSha256: oldPathSha256,
          pathSha256: currentPathSha256,
          changedPaths: ['<path-identity-rebind-rolled-back>'],
        }],
      },
    });
    await store.close();
  });

  it('rolls back a rebind when file content changes during the CAS commit', async () => {
    const { path, store } = fixture();
    const oldPathSha256 = 'd'.repeat(64);
    await seedV2PathRecord(store, { scope: 'global', path, pathSha256: oldPathSha256 });
    let reachedCommit!: () => void;
    let releaseCommit!: () => void;
    const commitReached = new Promise<void>(resolve => { reachedCommit = resolve; });
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
    let writes = 0;
    const gatedStore = {
      acquireSessionLease: store.acquireSessionLease.bind(store),
      renewSessionLease: store.renewSessionLease.bind(store),
      releaseSessionLease: store.releaseSessionLease.bind(store),
      readAuxiliaryState: store.readAuxiliaryState.bind(store),
      writeAuxiliaryState: async (...args: Parameters<typeof store.writeAuxiliaryState>) => {
        writes += 1;
        if (writes === 1) {
          reachedCommit();
          await commitGate;
        }
        return store.writeAuxiliaryState(...args);
      },
    };
    const coordinator = createDurableConfigCoordinator({ store: gatedStore, ownerId: 'race-test' });
    const digest = contentSha256(path);
    const currentPathSha256 = pathSha256(path);
    const rebind = coordinator.rebindPath({
      scope: 'global',
      path,
      expectedRecordRevision: 1,
      expectedBoundPathSha256: oldPathSha256,
      expectedCurrentPathSha256: currentPathSha256,
      expectedCommittedSha256: digest,
      expectedFileSha256: digest,
    });

    await commitReached;
    writeFileSync(path, JSON.stringify({ changedDuringCommit: true }) + '\n');
    releaseCommit();
    await expect(rebind).rejects.toThrow('durable_config_rebind_content_drift');
    const record = await store.readAuxiliaryState('auxiliary::config-cas::global');
    expect(record).toMatchObject({
      revision: 3,
      value: {
        pathSha256: oldPathSha256,
        contentSha256: digest,
        audit: [{
          outcome: 'failed_changed',
          baseSha256: digest,
          contentSha256: contentSha256(path),
          basePathSha256: oldPathSha256,
          pathSha256: currentPathSha256,
          changedPaths: ['<path-identity-rebind-rolled-back>'],
        }],
      },
    });
    await store.close();
  });

  it('refuses to guess a path for an interrupted v1 prepared record', async () => {
    const { path, store, coordinator } = fixture();
    await seedLegacyRecord(store, { scope: 'global', path, phase: 'prepared' });
    const mutation = vi.fn(async () => undefined);

    await expect(coordinator.run({ scope: 'global', path, mutation }))
      .rejects.toThrow('durable_config_path_identity_unbound');
    expect(mutation).not.toHaveBeenCalled();
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 1, value: { version: 1, phase: 'prepared' } });
    await store.close();
  });

  it('rejects another path without changing the binding or blocking the original path', async () => {
    const { path, store, coordinator } = fixture();
    const alternatePath = join(path, '..', 'alternate.json');
    writeFileSync(alternatePath, readFileSync(path));
    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
    const wrongMutation = vi.fn(async () => undefined);

    await expect(coordinator.run({ scope: 'global', path: alternatePath, mutation: wrongMutation }))
      .rejects.toThrow('durable_config_path_mismatch');
    expect(wrongMutation).not.toHaveBeenCalled();
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 2, value: { pathSha256: pathSha256(path) } });

    await coordinator.run({ scope: 'global', path, mutation: async () => undefined });
    expect(await store.readAuxiliaryState('auxiliary::config-cas::global'))
      .toMatchObject({ revision: 4, value: { pathSha256: pathSha256(path) } });
    await store.close();
  });

  it('fails closed when primary mode has no registered coordinator', async () => {
    const { path, store } = fixture();
    vi.stubEnv('BOTMUX_COORDINATION_MODE', 'primary');
    await expect(runDurableConfigMutation({
      scope: 'global', path, mutation: async () => undefined,
    })).rejects.toThrow('durable_config_coordinator_unavailable');
    await store.close();
  });

  it('admits a primary write only inside the registered durable transaction context', async () => {
    const { path, store, coordinator } = fixture();
    vi.stubEnv('BOTMUX_COORDINATION_MODE', 'primary');
    setDurableConfigCoordinator(coordinator);
    await runDurableConfigMutation({
      scope: 'global',
      path,
      mutation: async () => {
        expect(() => assertDurableConfigMutationAllowed('global')).not.toThrow();
        expect(() => assertDurableConfigMutationAllowed('bots'))
          .toThrow('durable_config_coordinator_required');
      },
    });
    await store.close();
  });

  it('allows the real global-config writer only through the durable primary transaction', async () => {
    const { path, store, coordinator } = fixture();
    vi.stubEnv('BOTMUX_COORDINATION_MODE', 'primary');
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', path);
    setDurableConfigCoordinator(coordinator);
    await runDurableConfigMutation({
      scope: 'global',
      path,
      mutation: async () => mergeGlobalConfig({ repoPickerMode: 'repos' }),
    });
    invalidateGlobalConfigCache();
    expect(JSON.parse(readFileSync(path, 'utf8')).repoPickerMode).toBe('repos');
    await store.close();
  });
});
