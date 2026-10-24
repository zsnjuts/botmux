import { describe, expect, it } from 'vitest';
import {
  durableConfigCasRequest,
  parseDurableConfigCasArgs,
} from '../src/cli/durable-config-cas.js';

describe('durable config CAS command', () => {
  it('builds a read-only inspection request', () => {
    const parsed = parseDurableConfigCasArgs([
      'inspect', '--bot', 'cli_demo123', '--scope', 'group-context',
    ]);
    expect(parsed).toEqual({
      action: 'inspect',
      larkAppId: 'cli_demo123',
      scope: 'group-context',
      yes: false,
    });
    expect(durableConfigCasRequest(parsed)).toEqual({
      path: '/api/durable-config-cas?scope=group-context',
      init: { method: 'GET' },
    });
  });

  it('requires two exact hashes and explicit confirmation for reconcile', () => {
    const committed = 'a'.repeat(64);
    const file = 'b'.repeat(64);
    expect(() => parseDurableConfigCasArgs([
      'reconcile', '--bot', 'cli_demo123', '--scope', 'bots',
      '--expected-committed-sha', committed,
      '--expected-file-sha', file,
    ])).toThrow('requires --yes');
    const parsed = parseDurableConfigCasArgs([
      'reconcile', '--bot', 'cli_demo123', '--scope', 'bots',
      '--expected-committed-sha', committed,
      '--expected-file-sha', file,
      '--yes',
    ]);
    expect(durableConfigCasRequest(parsed)).toEqual({
      path: '/api/durable-config-cas?scope=bots',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedCommittedSha256: committed,
          expectedFileSha256: file,
        }),
      },
    });
  });

  it('builds a path rebind request only from a complete explicit proof', () => {
    const committed = 'a'.repeat(64);
    const file = 'a'.repeat(64);
    const boundPath = 'b'.repeat(64);
    const currentPath = 'c'.repeat(64);
    const args = [
      'rebind-path', '--bot', 'cli_demo123', '--scope', 'global',
      '--expected-record-revision', '7',
      '--expected-bound-path-sha', boundPath,
      '--expected-current-path-sha', currentPath,
      '--expected-committed-sha', committed,
      '--expected-file-sha', file,
    ];
    expect(() => parseDurableConfigCasArgs(args)).toThrow('requires --yes');
    const parsed = parseDurableConfigCasArgs([...args, '--yes']);
    expect(durableConfigCasRequest(parsed)).toEqual({
      path: '/api/durable-config-cas/rebind-path?scope=global',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRecordRevision: 7,
          expectedBoundPathSha256: boundPath,
          expectedCurrentPathSha256: currentPath,
          expectedCommittedSha256: committed,
          expectedFileSha256: file,
        }),
      },
    });
  });

  it('builds a combined path and content recovery request only from a complete explicit proof', () => {
    const committed = 'a'.repeat(64);
    const file = 'd'.repeat(64);
    const boundPath = 'b'.repeat(64);
    const currentPath = 'c'.repeat(64);
    const args = [
      'rebind-and-reconcile', '--bot', 'cli_demo123', '--scope', 'bots',
      '--expected-record-revision', '9',
      '--expected-bound-path-sha', boundPath,
      '--expected-current-path-sha', currentPath,
      '--expected-committed-sha', committed,
      '--expected-file-sha', file,
    ];
    expect(() => parseDurableConfigCasArgs(args)).toThrow('requires --yes');
    const parsed = parseDurableConfigCasArgs([...args, '--yes']);
    expect(durableConfigCasRequest(parsed)).toEqual({
      path: '/api/durable-config-cas/rebind-and-reconcile?scope=bots',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRecordRevision: 9,
          expectedBoundPathSha256: boundPath,
          expectedCurrentPathSha256: currentPath,
          expectedCommittedSha256: committed,
          expectedFileSha256: file,
        }),
      },
    });
  });

  it('rejects unsupported scopes and non-canonical digests', () => {
    expect(() => parseDurableConfigCasArgs([
      'inspect', '--bot', 'cli_demo123', '--scope', 'unknown',
    ])).toThrow('invalid durable config scope');
    expect(() => parseDurableConfigCasArgs([
      'reconcile', '--bot', 'cli_demo123',
      '--expected-committed-sha', 'A'.repeat(64),
      '--expected-file-sha', 'b'.repeat(64), '--yes',
    ])).toThrow('lowercase --expected-committed-sha');
    expect(() => parseDurableConfigCasArgs([
      'rebind-path', '--bot', 'cli_demo123', '--scope', 'bots',
      '--expected-record-revision', '0',
      '--expected-bound-path-sha', 'b'.repeat(64),
      '--expected-current-path-sha', 'c'.repeat(64),
      '--expected-committed-sha', 'd'.repeat(64),
      '--expected-file-sha', 'd'.repeat(64), '--yes',
    ])).toThrow('positive --expected-record-revision');
  });
});
