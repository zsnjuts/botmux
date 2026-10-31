#!/usr/bin/env node
// Provider that still holds one final a previous host never confirmed
// (Mew #101). FINAL_ACK_CAPABLE=0 leaves `final_ack` out of hello.
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const capable = process.env.FINAL_ACK_CAPABLE !== '0';
const ackLog = process.env.FINAL_ACK_LOG;
let state;

function emit(event) {
  process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim()) return;
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({
      type: 'hello',
      requestId: command.requestId,
      provider: 'final-ack-test',
      capabilities: [
        'start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status',
        ...(capable ? ['final_ack'] : []),
      ],
    });
    return;
  }
  if (command.type === 'resume') {
    state = command.state;
    emit({
      type: 'ready',
      requestId: command.requestId,
      state,
      pendingFinals: [{ turnId: 'turn-unconfirmed', content: 'unconfirmed final' }],
    });
    return;
  }
  if (command.type === 'final_ack') {
    if (ackLog) appendFileSync(ackLog, `${command.turnId}\n`);
    emit({ type: 'status', requestId: command.requestId, status: 'ready' });
    return;
  }
  if (command.type === 'cancel') {
    emit({ type: 'status', requestId: command.requestId, status: 'closed', state });
    return;
  }
  emit({
    type: 'failure',
    requestId: command.requestId,
    code: 'unexpected_command',
    message: 'unexpected command',
    status: 'failed',
    retryable: false,
  });
});
