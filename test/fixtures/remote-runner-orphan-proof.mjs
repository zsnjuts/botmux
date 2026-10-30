#!/usr/bin/env node

import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;

function emit(event) {
  process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({
      type: 'hello',
      requestId: command.requestId,
      provider: 'orphan-proof',
      capabilities: process.env.ORPHAN_PROOF_VERDICT === '1'
        ? ['start', 'resume', 'orphan_reconciliation', 'orphan_reconciliation_verdict']
        : ['start', 'resume', 'orphan_reconciliation'],
    });
    return;
  }
  if (command.type !== 'resume') return;
  if (command.sessionId === 'session-alive-orphan-proof') {
    emit({
      type: 'ready',
      requestId: command.requestId,
      state: command.state,
      orphanReconciliation: { verdict: 'not_orphan', reason: 'remote_alive' },
    });
    return;
  }
  const valid = command.sessionId === 'session-valid-orphan-proof'
    && command.resumeMode === 'orphan-reconcile';
  emit({
    type: 'ready',
    requestId: command.requestId,
    state: valid
      ? {
          ...command.state,
          generation: command.state.generation + 1,
          remoteSessionId: undefined,
        }
      : command.state,
  });
});
