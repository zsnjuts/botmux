// Dashboard polling after a close the daemon accepted but had not committed
// within its wait window (HTTP 202 `outcome: 'closing'`).
import { describe, expect, it, vi } from 'vitest';
import { waitForSessionsClosed } from '../src/dashboard/web/close-pending-poll.js';

function clockHarness() {
  let clock = 0;
  return {
    now: () => clock,
    wait: vi.fn(async (ms: number) => { clock += ms; }),
  };
}

describe('waitForSessionsClosed', () => {
  it('keeps polling until the session row reports closed', async () => {
    const c = clockHarness();
    const snapshots = [
      [{ sessionId: 's1', status: 'active' }],
      [{ sessionId: 's1', status: 'active' }],
      [{ sessionId: 's1', status: 'closed' }],
    ];
    const fetchSessions = vi.fn(async () => snapshots.shift());

    await expect(waitForSessionsClosed(['s1'], { fetchSessions, now: c.now, wait: c.wait, intervalMs: 3_000, timeoutMs: 180_000 }))
      .resolves.toEqual({ closed: ['s1'], pending: [] });
    expect(fetchSessions).toHaveBeenCalledTimes(3);
  });

  it('treats a row that left the snapshot as gone and tolerates failed snapshots', async () => {
    const c = clockHarness();
    const fetchSessions = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ sessionId: 's2', status: 'active' }]);

    await expect(waitForSessionsClosed(['s1', 's2'], { fetchSessions, now: c.now, wait: c.wait, intervalMs: 1_000, timeoutMs: 10_000 }))
      .resolves.toEqual({ closed: ['s1'], pending: ['s2'] });
  });

  it('gives up at the deadline and names what is still not closed', async () => {
    const c = clockHarness();
    const fetchSessions = vi.fn(async () => [{ sessionId: 's1', status: 'active' }]);

    const result = await waitForSessionsClosed(['s1'], { fetchSessions, now: c.now, wait: c.wait, intervalMs: 3_000, timeoutMs: 9_000 });

    expect(result).toEqual({ closed: [], pending: ['s1'] });
    expect(fetchSessions).toHaveBeenCalledTimes(3);
  });
});
