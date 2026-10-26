#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const capabilities = [
  'start', 'resume', 'turn', 'turn_steer', 'cancel', 'detach', 'reattach', 'status',
];
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
