import { describe, expect, it } from 'vitest';
import { workerStartFailedMessageKey } from '../src/core/worker-start-failure.js';
import { t as tr } from '../src/i18n/index.js';

describe('worker startup failure text', () => {
  it('sends a forked remote state to /close instead of asking to fix settings and resend', () => {
    for (const reason of [
      'invalid_request: Remote Runner resume TraeX thread does not match durable state',
      'invalid_request: Remote Runner resume TAE session does not match durable state',
      'invalid_request: persisted active remote binding does not match orphan control state',
    ]) {
      expect(workerStartFailedMessageKey(reason)).toBe('worker.start_failed_state_mismatch');
    }
    expect(workerStartFailedMessageKey('spawn ENOENT: botmux-tae-traex-runner'))
      .toBe('worker.start_failed');
  });

  it('renders the cli name and the exact reason in every locale', () => {
    for (const locale of ['zh', 'en'] as const) {
      const text = tr('worker.start_failed_state_mismatch', { cliName: 'Remote Runner', reason: 'R-123' }, locale);
      expect(text).toContain('Remote Runner');
      expect(text).toContain('R-123');
      expect(text).toContain('/close');
    }
  });
});
