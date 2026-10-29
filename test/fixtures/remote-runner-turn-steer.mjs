#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
// TURN_STEER_FIXTURE_UNSUPPORTED=1 models a provider that predates turn_steer.
const capabilities = [
  'start', 'resume', 'turn',
  ...(process.env.TURN_STEER_FIXTURE_UNSUPPORTED === '1' ? [] : ['turn_steer']),
  'cancel', 'detach', 'reattach', 'status',
];
// Like the TAE provider, steer is enabled only when the host asked for it in
// hello, either pinned (required) or optional.
let steerRequested = false;
let state;
let status = 'starting';
let activeTurn;

const emit = event => process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);

function fail(command, code, message, failureStatus = 'failed') {
  emit({
    type: 'failure',
    requestId: command.requestId,
    ...(command.turnId ? { turnId: command.turnId } : {}),
    code,
    message,
    status: failureStatus,
    retryable: failureStatus !== 'ambiguous',
  });
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    steerRequested = [
      ...(command.requiredCapabilities ?? []),
      ...(command.optionalCapabilities ?? []),
    ].includes('turn_steer');
    emit({ type: 'hello', requestId: command.requestId, provider: 'turn-steer', capabilities });
  } else if (command.type === 'start') {
    state = {
      version,
      provider: 'turn-steer',
      generation: 1,
      remoteSessionId: `turn-steer:${command.sessionId}`,
    };
    status = 'ready';
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'turn') {
    if (status !== 'ready' || activeTurn) {
      fail(command, 'not_ready', 'another turn is active');
      return;
    }
    activeTurn = command;
    status = 'busy';
    emit({ type: 'status', requestId: command.requestId, status, state });
  } else if (command.type === 'turn_steer') {
    if (!steerRequested) {
      fail(command, 'turn_steer_not_negotiated', 'host did not request turn_steer');
      return;
    }
    if (!activeTurn || status !== 'busy'
        || command.turnId !== activeTurn.turnId
        || command.generation !== state?.generation) {
      fail(command, 'steer_target_mismatch', 'steer target is not the active turn');
      return;
    }
    if (command.content === 'reject') {
      fail(command, 'steer_rejected', 'steer was not applied');
      return;
    }
    if (command.content === 'ambiguous') {
      fail(command, 'steer_unknown', 'steer result is unknown', 'ambiguous');
      return;
    }
    emit({ type: 'status', requestId: command.requestId, status: 'busy', state });
    emit({
      type: 'progress',
      turnId: activeTurn.turnId,
      content: `steered:${command.steerId}:${command.content}`,
    });
    status = 'ready';
    emit({
      type: 'final',
      turnId: activeTurn.turnId,
      content: `final:${activeTurn.content}+${command.content}`,
      state,
    });
    activeTurn = undefined;
  } else if (command.type === 'cancel') {
    status = 'closed';
    activeTurn = undefined;
    emit({ type: 'status', requestId: command.requestId, status, state });
  } else if (command.type === 'status') {
    emit({ type: 'status', requestId: command.requestId, status, state });
  }
});
