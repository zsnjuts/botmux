#!/usr/bin/env node

import readline from 'node:readline';

// Models the TAE provider's receipts for a Ctrl-C `terminal_input`. Space
// separated tokens in the turn content pick the scenario:
//   ack-after:<ms>      busy ACK is delayed: the turn is still starting
//   native-after:<n>    the first n Ctrl-C answer terminal_input_not_ready
//                       (TraeX has not natively started the turn yet)
//   native-never        every Ctrl-C answers terminal_input_not_ready
//   unknown             Ctrl-C answers terminal_input_unknown (ambiguous)
//   legacy-not-applied  answers like a provider before the not_ready split:
//                       terminal_input_not_applied carrying the active turnId
//   silent              never answers Ctrl-C
//   cancel-first        the cancelled terminal is written before the receipt
//   finish-after:<ms>   the turn completes by itself after <ms>
// A delivered Ctrl-C ends the turn as cancelled (tae_traex_turn_cancelled).
const protocol = 'botmux.remote-runner';
const version = 1;
const capabilities = [
  'start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status', 'terminal_input',
];
let state;
let status = 'starting';
let activeTurn;

const emit = event => process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);

function fail(command, code, extra = {}) {
  emit({
    type: 'failure',
    requestId: command.requestId,
    code,
    message: code,
    status: 'failed',
    retryable: false,
    ...extra,
  });
}

function numberOption(turn, name) {
  const token = turn.options.find(value => value.startsWith(`${name}:`));
  return token ? Number(token.slice(name.length + 1)) : undefined;
}

function finishTurn(turn, event) {
  if (activeTurn !== turn) return;
  activeTurn = undefined;
  status = 'ready';
  emit({ turnId: turn.command.turnId, ...event });
}

function cancelled(turn) {
  finishTurn(turn, {
    type: 'failure',
    code: 'tae_traex_turn_cancelled',
    message: 'stopped',
    status: 'cancelled',
    retryable: false,
  });
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({ type: 'hello', requestId: command.requestId, provider: 'turn-interrupt', capabilities });
  } else if (command.type === 'start') {
    state = {
      version,
      provider: 'turn-interrupt',
      generation: 1,
      remoteSessionId: `turn-interrupt:${command.sessionId}`,
    };
    status = 'ready';
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'turn') {
    if (status !== 'ready' || activeTurn) {
      fail(command, 'runner_busy');
      return;
    }
    const options = String(command.content).split(/\s+/);
    const turn = { command, options, notReadyLeft: 0 };
    turn.notReadyLeft = numberOption(turn, 'native-after') ?? 0;
    activeTurn = turn;
    status = 'starting';
    const acknowledge = () => {
      if (activeTurn !== turn) return;
      status = 'busy';
      emit({ type: 'status', requestId: command.requestId, status, state });
    };
    const ackAfter = numberOption(turn, 'ack-after');
    if (ackAfter !== undefined) setTimeout(acknowledge, ackAfter);
    else acknowledge();
    const finishAfter = numberOption(turn, 'finish-after');
    if (finishAfter !== undefined) {
      setTimeout(() => finishTurn(turn, { type: 'final', content: 'finished', state }), finishAfter);
    }
  } else if (command.type === 'terminal_input') {
    const turn = activeTurn;
    if (!turn) {
      fail(command, 'terminal_input_no_active_turn');
      return;
    }
    const has = name => turn.options.includes(name);
    if (has('legacy-not-applied')) {
      fail(command, 'terminal_input_not_applied', { retryable: true, turnId: turn.command.turnId });
      return;
    }
    if (status === 'starting') {
      fail(command, 'terminal_input_not_ready', { retryable: true });
      return;
    }
    if (has('silent')) return;
    if (has('unknown')) {
      fail(command, 'terminal_input_unknown', { status: 'ambiguous' });
      return;
    }
    if (has('native-never') || turn.notReadyLeft > 0) {
      turn.notReadyLeft -= 1;
      fail(command, 'terminal_input_not_ready', { retryable: true });
      return;
    }
    if (has('cancel-first')) cancelled(turn);
    emit({ type: 'status', requestId: command.requestId, status: 'busy' });
    cancelled(turn);
  } else if (command.type === 'cancel') {
    status = 'closed';
    activeTurn = undefined;
    emit({ type: 'status', requestId: command.requestId, status, state });
  } else if (command.type === 'status') {
    emit({ type: 'status', requestId: command.requestId, status, state });
  }
});
