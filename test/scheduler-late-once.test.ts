/**
 * scheduler-late-once.test.ts
 *
 * A relative one-shot ("2 分钟后") is anchored to the source message, so when
 * the task is only created after that target passed it must still fire once
 * instead of being stored with no next run — and a stored one-shot that can
 * never be scheduled must be retired visibly instead of staying active forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() {
        return join(tempDir, 'data');
      },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: vi.fn() }));
vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: vi.fn() } }));

const TEST_APP = 'cli_testapp0000000001';

function onceParams(runAtMs: number) {
  const runAt = new Date(runAtMs).toISOString();
  return {
    name: 'late-once',
    schedule: runAt,
    parsed: { kind: 'once' as const, runAt, display: 'once' },
    prompt: 'hello',
    workingDir: '/workspace/project',
    chatId: 'oc_test_chat',
    rootMessageId: 'om_origin',
    executionPosition: 'topic' as const,
    larkAppId: TEST_APP,
  };
}

async function freshImport() {
  vi.resetModules();
  const store = await import('../src/services/schedule-store.js');
  store.setScheduleScope(TEST_APP);
  const scheduler = await import('../src/core/scheduler.js');
  return { store, scheduler };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'scheduler-late-once-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('scheduler late one-shot', () => {
  it('schedules an anchored one-shot immediately when created after its target', async () => {
    const { store, scheduler } = await freshImport();
    const messageAt = Date.now() - 12 * 60_000;
    const task = scheduler.addTask({ ...onceParams(messageAt + 2 * 60_000), referenceTimeMs: messageAt });
    expect(task.enabled).toBe(true);
    const stored = store.getTask(task.id, TEST_APP)!;
    expect(stored.nextRunAt).toBeTruthy();
    expect(Math.abs(Date.parse(stored.nextRunAt!) - Date.now())).toBeLessThan(5_000);
  });

  it('rejects a one-shot whose target was already past when requested', async () => {
    const { store, scheduler } = await freshImport();
    const messageAt = Date.now() - 12 * 60_000;
    expect(() => scheduler.addTask({ ...onceParams(messageAt - 60_000), referenceTimeMs: messageAt }))
      .toThrow('once_schedule_in_past');
    expect(() => scheduler.addTask(onceParams(Date.now() - 3600_000))).toThrow('once_schedule_in_past');
    expect(store.listTasks(TEST_APP)).toHaveLength(0);
  });

  it('retires a stored never-run one-shot that can no longer be scheduled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    const { store, scheduler } = await freshImport();
    const task = scheduler.addTask(onceParams(Date.now() + 60_000));
    const staleRunAt = new Date(Date.now() - 3600_000).toISOString();
    store.updateTask(task.id, {
      parsed: { kind: 'once', runAt: staleRunAt, display: 'once' },
      nextRunAt: undefined,
    }, TEST_APP);
    const executed = vi.fn();
    scheduler.setExecuteCallback(executed as any);

    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(6_000);
    scheduler.stopScheduler();

    expect(executed).not.toHaveBeenCalled();
    expect(store.getTask(task.id, TEST_APP)).toMatchObject({
      enabled: false,
      disabledReason: 'once_completed',
      lastStatus: 'error',
    });
    expect(store.getTask(task.id, TEST_APP)?.lastError).toMatch(/once_schedule_missed/);
  });
});
