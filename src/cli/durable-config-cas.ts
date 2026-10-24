import {
  DURABLE_CONFIG_SCOPES,
  type DurableConfigScope,
} from '../services/durable-config-coordinator.js';

export const DURABLE_CONFIG_CAS_ROUTE = '/api/durable-config-cas';

type DurableConfigCasCommandBase = {
  larkAppId: string;
  scope: DurableConfigScope;
};

export type DurableConfigCasCommand = DurableConfigCasCommandBase & (
  | { action: 'inspect'; yes: false }
  | {
      action: 'reconcile';
      expectedCommittedSha256: string;
      expectedFileSha256: string;
      yes: true;
    }
  | {
      action: 'rebind-path';
      expectedRecordRevision: number;
      expectedBoundPathSha256: string;
      expectedCurrentPathSha256: string;
      expectedCommittedSha256: string;
      expectedFileSha256: string;
      yes: true;
    }
);

const DIGEST = /^[0-9a-f]{64}$/;
const SCOPES = new Set<string>(DURABLE_CONFIG_SCOPES);

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseDurableConfigCasArgs(args: string[]): DurableConfigCasCommand {
  const action = args[0];
  if (action !== 'inspect' && action !== 'reconcile' && action !== 'rebind-path') {
    throw new Error(
      'usage: botmux config-cas inspect|reconcile|rebind-path --bot <appId> '
      + '[--scope bots|global|group-context] '
      + '[--expected-record-revision <revision> '
      + '--expected-bound-path-sha <sha256> --expected-current-path-sha <sha256> '
      + '--expected-committed-sha <sha256> --expected-file-sha <sha256> --yes]',
    );
  }
  let larkAppId = '';
  let scope: DurableConfigScope = 'bots';
  let expectedCommittedSha256: string | undefined;
  let expectedFileSha256: string | undefined;
  let expectedRecordRevision: number | undefined;
  let expectedBoundPathSha256: string | undefined;
  let expectedCurrentPathSha256: string | undefined;
  let yes = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--bot') {
      larkAppId = valueAfter(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--scope') {
      const value = valueAfter(args, index, arg);
      if (!SCOPES.has(value as DurableConfigScope)) throw new Error('invalid durable config scope');
      scope = value as DurableConfigScope;
      index += 1;
      continue;
    }
    if (arg === '--expected-committed-sha') {
      expectedCommittedSha256 = valueAfter(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--expected-file-sha') {
      expectedFileSha256 = valueAfter(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--expected-record-revision') {
      const value = valueAfter(args, index, arg);
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('config-cas rebind-path requires a positive --expected-record-revision');
      }
      expectedRecordRevision = Number(value);
      index += 1;
      continue;
    }
    if (arg === '--expected-bound-path-sha') {
      expectedBoundPathSha256 = valueAfter(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--expected-current-path-sha') {
      expectedCurrentPathSha256 = valueAfter(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown config-cas argument: ${arg}`);
  }
  if (!/^cli_[A-Za-z0-9]+$/.test(larkAppId)) throw new Error('--bot requires a Lark app id');
  if (action === 'inspect') {
    if (yes || expectedCommittedSha256 || expectedFileSha256 || expectedRecordRevision
        || expectedBoundPathSha256 || expectedCurrentPathSha256) {
      throw new Error('config-cas inspect does not accept mutation confirmation flags');
    }
    return { action, larkAppId, scope, yes: false };
  }
  if (!yes) throw new Error(`config-cas ${action} requires --yes`);
  if (!expectedCommittedSha256 || !DIGEST.test(expectedCommittedSha256)) {
    throw new Error(`config-cas ${action} requires a lowercase --expected-committed-sha`);
  }
  if (!expectedFileSha256 || !DIGEST.test(expectedFileSha256)) {
    throw new Error(`config-cas ${action} requires a lowercase --expected-file-sha`);
  }
  if (action === 'reconcile') {
    if (expectedRecordRevision || expectedBoundPathSha256 || expectedCurrentPathSha256) {
      throw new Error('config-cas reconcile does not accept path rebind confirmation flags');
    }
    return {
      action,
      larkAppId,
      scope,
      expectedCommittedSha256,
      expectedFileSha256,
      yes: true,
    };
  }
  if (!expectedRecordRevision) {
    throw new Error('config-cas rebind-path requires a positive --expected-record-revision');
  }
  if (!expectedBoundPathSha256 || !DIGEST.test(expectedBoundPathSha256)) {
    throw new Error('config-cas rebind-path requires a lowercase --expected-bound-path-sha');
  }
  if (!expectedCurrentPathSha256 || !DIGEST.test(expectedCurrentPathSha256)) {
    throw new Error('config-cas rebind-path requires a lowercase --expected-current-path-sha');
  }
  return {
    action,
    larkAppId,
    scope,
    expectedCommittedSha256,
    expectedFileSha256,
    expectedRecordRevision,
    expectedBoundPathSha256,
    expectedCurrentPathSha256,
    yes: true,
  };
}

export function durableConfigCasRequest(command: DurableConfigCasCommand): {
  path: string;
  init: RequestInit;
} {
  const path = `${DURABLE_CONFIG_CAS_ROUTE}?scope=${encodeURIComponent(command.scope)}`;
  if (command.action === 'inspect') return { path, init: { method: 'GET' } };
  if (command.action === 'rebind-path') {
    return {
      path: `${DURABLE_CONFIG_CAS_ROUTE}/rebind-path?scope=${encodeURIComponent(command.scope)}`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRecordRevision: command.expectedRecordRevision,
          expectedBoundPathSha256: command.expectedBoundPathSha256,
          expectedCurrentPathSha256: command.expectedCurrentPathSha256,
          expectedCommittedSha256: command.expectedCommittedSha256,
          expectedFileSha256: command.expectedFileSha256,
        }),
      },
    };
  }
  return {
    path,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedCommittedSha256: command.expectedCommittedSha256,
        expectedFileSha256: command.expectedFileSha256,
      }),
    },
  };
}
