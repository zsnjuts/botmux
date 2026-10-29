import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __testOnlyResetScheduledRunSettlements,
  abortScheduledRunSettlement,
  beginScheduledRunSettlement,
  executeScheduledRunAwaitingSettlement,
  observeScheduledRunDaemonProviderDelivery,
  observeScheduledRunProviderReadbackDelivery,
  observeScheduledRunTerminal,
  revokeScheduledRunSettlements,
} from '../src/core/scheduled-run-settlement.js';

afterEach(() => __testOnlyResetScheduledRunSettlements());

describe('scheduled run settlement', () => {
  it('requires a concrete final Lark receipt for non-silent runs', async () => {
    const run = beginScheduledRunSettlement({
      turnId: 'schedule:deadbeef:00000000-0000-4000-8000-000000000001',
      taskId: 'deadbeef',
      requireFinalDelivery: true,
    });

    expect(observeScheduledRunProviderReadbackDelivery(run.turnId, undefined)).toBe(false);
    expect(observeScheduledRunProviderReadbackDelivery(run.turnId, 'invalid')).toBe(false);
    expect(observeScheduledRunProviderReadbackDelivery(run.turnId, 'om_!')).toBe(false);
    expect(observeScheduledRunProviderReadbackDelivery(run.turnId, 'om_delivered')).toBe(true);
    await expect(run.settled).resolves.toEqual({ messageId: 'om_delivered' });
  });

  it('rejects a completed non-silent turn that has no final receipt', async () => {
    const run = beginScheduledRunSettlement({
      turnId: 'schedule:deadbeef:00000000-0000-4000-8000-000000000002',
      taskId: 'deadbeef',
      requireFinalDelivery: true,
    });

    expect(observeScheduledRunTerminal({ turnId: run.turnId, status: 'completed' })).toBe(true);
    await expect(run.settled).rejects.toThrow('completed without a final Lark message receipt');
  });

  it('allows an intentionally silent run to settle on successful terminal', async () => {
    const run = beginScheduledRunSettlement({
      turnId: 'schedule:deadbeef:00000000-0000-4000-8000-000000000003',
      taskId: 'deadbeef',
      requireFinalDelivery: false,
    });

    expect(observeScheduledRunTerminal({ turnId: run.turnId, status: 'completed' })).toBe(true);
    await expect(run.settled).resolves.toEqual({});
  });

  it('allows a silent run that publishes a final to verify it before self-delete', async () => {
    const run = beginScheduledRunSettlement({
      turnId: 'schedule:deadbeef:00000000-0000-4000-8000-000000000103',
      taskId: 'deadbeef',
      requireFinalDelivery: false,
    });

    expect(observeScheduledRunProviderReadbackDelivery(run.turnId, 'om_silent_final')).toBe(true);
    await expect(run.settled).resolves.toEqual({ messageId: 'om_silent_final' });
  });

  it('reissues the same trusted receipt after settlement without accepting a rebind', async () => {
    const run = beginScheduledRunSettlement({
      turnId: 'schedule:deadbeef:00000000-0000-4000-8000-000000000104',
      taskId: 'deadbeef',
      requireFinalDelivery: true,
    });

    expect(observeScheduledRunProviderReadbackDelivery(run.turnId, 'om_replayed')).toBe(true);
    await expect(run.settled).resolves.toEqual({ messageId: 'om_replayed' });
    expect(observeScheduledRunProviderReadbackDelivery(run.turnId, 'om_replayed')).toBe(true);
    expect(observeScheduledRunProviderReadbackDelivery(run.turnId, 'om_other')).toBe(false);
    expect(revokeScheduledRunSettlements('deadbeef')).toBe(1);
    expect(observeScheduledRunProviderReadbackDelivery(run.turnId, 'om_replayed')).toBe(false);
  });

  it('propagates dispatch failure and rejects duplicate settlement identity', async () => {
    const turnId = 'schedule:deadbeef:00000000-0000-4000-8000-000000000004';
    const run = beginScheduledRunSettlement({
      turnId,
      taskId: 'deadbeef',
      requireFinalDelivery: true,
    });
    expect(() => beginScheduledRunSettlement({
      turnId,
      taskId: 'deadbeef',
      requireFinalDelivery: true,
    })).toThrow('settlement already exists');

    expect(abortScheduledRunSettlement(turnId, new Error('dispatch failed'))).toBe(true);
    await expect(run.settled).rejects.toThrow('dispatch failed');
  });

  it('keeps the scheduler callback pending until the delivery receipt arrives', async () => {
    const turnId = 'schedule:deadbeef:00000000-0000-4000-8000-000000000005';
    let dispatchCompleted = false;
    let callbackCompleted = false;
    const execution = executeScheduledRunAwaitingSettlement({
      turnId,
      taskId: 'deadbeef',
      requireFinalDelivery: true,
    }, async () => { dispatchCompleted = true; }).then(result => {
      callbackCompleted = true;
      return result;
    });

    await vi.waitFor(() => expect(dispatchCompleted).toBe(true));
    expect(callbackCompleted).toBe(false);
    observeScheduledRunProviderReadbackDelivery(turnId, 'om_receipt');
    await expect(execution).resolves.toEqual({ messageId: 'om_receipt' });
  });

  it('consumes a terminal rejection when dispatch terminalizes before throwing', async () => {
    const turnId = 'schedule:deadbeef:00000000-0000-4000-8000-000000000006';
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const execution = executeScheduledRunAwaitingSettlement({
        turnId,
        taskId: 'deadbeef',
        requireFinalDelivery: true,
      }, async () => {
        expect(observeScheduledRunTerminal({
          turnId,
          status: 'failed',
          errorCode: 'worker_admission_rejected',
        })).toBe(true);
        throw new Error('scheduled dispatch rejected');
      });

      await expect(execution).rejects.toThrow('scheduled dispatch rejected');
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rejects a delayed receipt after the exact schedule authority changes', async () => {
    let current = true;
    const run = beginScheduledRunSettlement({
      turnId: 'schedule:deadbeef:00000000-0000-4000-8000-000000000007',
      taskId: 'deadbeef',
      larkAppId: 'cli_a',
      requireFinalDelivery: true,
      authorityIsCurrent: () => current,
    });
    current = false;

    expect(observeScheduledRunDaemonProviderDelivery(run.turnId, 'om_delayed')).toBe(false);
    await expect(run.settled).rejects.toThrow('schedule authority was revoked before delivery');
  });

  it('revokes only the matching app and task settlements', async () => {
    const first = beginScheduledRunSettlement({
      turnId: 'schedule:deadbeef:00000000-0000-4000-8000-000000000008',
      taskId: 'deadbeef',
      larkAppId: 'cli_a',
      requireFinalDelivery: true,
    });
    const other = beginScheduledRunSettlement({
      turnId: 'schedule:deadbeef:00000000-0000-4000-8000-000000000009',
      taskId: 'deadbeef',
      larkAppId: 'cli_b',
      requireFinalDelivery: true,
    });
    // Capture the rejection instead of arming `expect(pending).rejects`: on
    // `bun test` that matcher, created before the promise settles, spins the
    // event loop after the case finishes and the file never exits.
    const firstError = first.settled.then(() => undefined, (error: Error) => error);

    expect(revokeScheduledRunSettlements('deadbeef', 'cli_a')).toBe(1);
    expect((await firstError)?.message).toContain('schedule authority was revoked');
    expect(observeScheduledRunProviderReadbackDelivery(other.turnId, 'om_other')).toBe(true);
    await expect(other.settled).resolves.toEqual({ messageId: 'om_other' });
  });
});
