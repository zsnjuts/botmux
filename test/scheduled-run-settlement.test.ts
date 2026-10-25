import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __testOnlyResetScheduledRunSettlements,
  abortScheduledRunSettlement,
  beginScheduledRunSettlement,
  executeScheduledRunAwaitingSettlement,
  observeScheduledRunProviderReadbackDelivery,
  observeScheduledRunTerminal,
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
});
