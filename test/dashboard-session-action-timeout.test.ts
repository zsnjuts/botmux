import { describe, expect, it } from 'vitest';
import { dashboardSessionActionTimeoutMs } from '../src/dashboard/session-action-timeout.js';

describe('dashboard session action timeout', () => {
  it('gives both durable lifecycle actions the extended proxy budget', () => {
    const closeBudget = dashboardSessionActionTimeoutMs('close');
    const resumeBudget = dashboardSessionActionTimeoutMs('resume');
    const ordinaryBudgets = ['locate', 'restart', 'start']
      .map(action => dashboardSessionActionTimeoutMs(action as 'locate' | 'restart' | 'start'));

    expect(resumeBudget).toBe(closeBudget);
    expect(ordinaryBudgets.every(budget => budget < resumeBudget)).toBe(true);
    expect(new Set(ordinaryBudgets).size).toBe(1);
  });
});
