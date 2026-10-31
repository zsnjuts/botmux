import { describe, expect, it, vi } from 'vitest';
import { t } from '../src/i18n/index.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

// Runs the real worker handlers against a stub Remote Runner backend: /stop must
// report the provider's receipt, and the card's Ctrl-C must say so when the
// stop did not reach the turn.
function harness(result: { outcome: string; turnId?: string } | null) {
  const interruptActiveTurn = vi.fn(async () => result);
  const scope: Record<string, any> = {
    effectiveBackendType: 'remote-runner',
    isRemoteBackendType: () => true,
    backend: {
      write: vi.fn(() => true),
      ...(result ? { interruptActiveTurn } : {}),
    },
    currentBotmuxTurnId: 'turn-running',
    currentBotmuxDispatchAttempt: 2,
    REMOTE_RUNNER_STOP_DEADLINE_MS: 10_000,
    send: vi.fn(),
    log: vi.fn(),
    t,
  };
  scope.stopRemoteRunnerTurn = loadWorkerFunction('stopRemoteRunnerTurn', scope);
  const stop = loadWorkerFunction<(requestId: string, deadline: number, issuedAt?: number) => Promise<void>>(
    'handleStopActiveTurn', scope,
  );
  const termAction = loadWorkerFunction<(key: string) => Promise<void>>('handleTermAction', scope);
  return { scope, interruptActiveTurn, stop, termAction };
}

describe('Remote Runner stop in the worker', () => {
  it('stops the worker\'s own turn and answers /stop with the provider receipt', async () => {
    const h = harness({ outcome: 'sent', turnId: 'turn-running' });

    await h.stop('stop-1', 5_000, 1_234);

    expect(h.interruptActiveTurn).toHaveBeenCalledWith(5_000, {
      expectedTurnId: 'turn-running',
      issuedAtMs: 1_234,
    });
    expect(h.scope.send).toHaveBeenCalledWith({
      type: 'stop_active_turn_result',
      requestId: 'stop-1',
      outcome: 'sent',
      turnId: 'turn-running',
    });
  });

  it('answers unknown when the backend cannot report a stop receipt', async () => {
    const h = harness(null);

    await h.stop('stop-2', 5_000);

    expect(h.scope.send).toHaveBeenCalledWith({
      type: 'stop_active_turn_result',
      requestId: 'stop-2',
      outcome: 'unknown',
    });
  });

  it.each([
    ['not_ready', 'cmd.stop.not_ready'],
    ['unknown', 'cmd.stop.unknown'],
  ])('tells the user when a card Ctrl-C was %s', async (outcome, key) => {
    const h = harness({ outcome, turnId: 'turn-running' });

    await h.termAction('ctrlc');

    expect(h.scope.send).toHaveBeenCalledWith({
      type: 'user_notify',
      turnId: 'turn-running',
      dispatchAttempt: 2,
      message: t(key),
    });
    expect(h.scope.backend.write).not.toHaveBeenCalled();
  });

  it.each(['sent', 'no_active_turn'])('stays quiet when a card Ctrl-C was %s', async outcome => {
    const h = harness({ outcome, turnId: 'turn-running' });

    await h.termAction('ctrlc');

    expect(h.scope.send).not.toHaveBeenCalled();
  });

  it('falls back to a plain Ctrl-C write when the backend has no stop receipt', async () => {
    const h = harness(null);

    await h.termAction('ctrlc');

    expect(h.scope.backend.write).toHaveBeenCalledWith('\x03');
  });
});
