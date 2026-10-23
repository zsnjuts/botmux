import type { DurableConfigScope } from '../services/durable-config-coordinator.js';

export const DURABLE_CONFIG_CAS_ROUTE = '/api/durable-config-cas';

export type DurableConfigCasCommand = {
  action: 'inspect' | 'reconcile';
  larkAppId: string;
  scope: DurableConfigScope;
  expectedCommittedSha256?: string;
  expectedFileSha256?: string;
  yes: boolean;
};

const DIGEST = /^[0-9a-f]{64}$/;
const SCOPES = new Set<DurableConfigScope>(['bots', 'global', 'group-context']);

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseDurableConfigCasArgs(args: string[]): DurableConfigCasCommand {
  const action = args[0];
  if (action !== 'inspect' && action !== 'reconcile') {
    throw new Error(
      'usage: botmux config-cas inspect|reconcile --bot <appId> '
      + '[--scope bots|global|group-context] '
      + '[--expected-committed-sha <sha256> --expected-file-sha <sha256> --yes]',
    );
  }
  let larkAppId = '';
  let scope: DurableConfigScope = 'bots';
  let expectedCommittedSha256: string | undefined;
  let expectedFileSha256: string | undefined;
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
    throw new Error(`unknown config-cas argument: ${arg}`);
  }
  if (!/^cli_[A-Za-z0-9]+$/.test(larkAppId)) throw new Error('--bot requires a Lark app id');
  if (action === 'inspect') {
    if (yes || expectedCommittedSha256 || expectedFileSha256) {
      throw new Error('config-cas inspect does not accept reconcile confirmation flags');
    }
    return { action, larkAppId, scope, yes: false };
  }
  if (!yes) throw new Error('config-cas reconcile requires --yes');
  if (!expectedCommittedSha256 || !DIGEST.test(expectedCommittedSha256)) {
    throw new Error('config-cas reconcile requires a lowercase --expected-committed-sha');
  }
  if (!expectedFileSha256 || !DIGEST.test(expectedFileSha256)) {
    throw new Error('config-cas reconcile requires a lowercase --expected-file-sha');
  }
  return {
    action,
    larkAppId,
    scope,
    expectedCommittedSha256,
    expectedFileSha256,
    yes,
  };
}

export function durableConfigCasRequest(command: DurableConfigCasCommand): {
  path: string;
  init: RequestInit;
} {
  const path = `${DURABLE_CONFIG_CAS_ROUTE}?scope=${encodeURIComponent(command.scope)}`;
  if (command.action === 'inspect') return { path, init: { method: 'GET' } };
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
