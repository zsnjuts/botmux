#!/usr/bin/env node

// Reports startup_progress during start and before a turn's busy ack, plus a
// late milestone after busy that the host must drop. STARTUP_PROGRESS_FIXTURE_UNADVERTISED
// emits the same events without advertising the capability.
import readline from 'node:readline';

const protocol = 'botmux.remote-runner';
const version = 1;
const unadvertised = process.env.STARTUP_PROGRESS_FIXTURE_UNADVERTISED === '1';
let state;
let status = 'starting';

const emit = event => process.stdout.write(`${JSON.stringify({ protocol, version, ...event })}\n`);

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    const negotiated = (command.optionalCapabilities ?? []).includes('startup_progress');
    emit({
      type: 'hello',
      requestId: command.requestId,
      provider: 'startup-progress',
      capabilities: ['start', 'resume', 'turn', 'cancel', 'detach', 'reattach', 'status',
        ...(negotiated && !unadvertised ? ['startup_progress'] : [])],
    });
  } else if (command.type === 'start') {
    state = {
      version,
      provider: 'startup-progress',
      generation: 1,
      remoteSessionId: `startup:${command.sessionId}`,
    };
    emit({ type: 'startup_progress', stage: 'sandbox_resume' });
    status = 'ready';
    emit({ type: 'ready', requestId: command.requestId, state });
    // No start/resume is pending any more: dropped.
    emit({ type: 'startup_progress', stage: 'sandbox_init' });
  } else if (command.type === 'turn') {
    emit({ type: 'startup_progress', turnId: command.turnId, stage: 'sandbox_create' });
    emit({ type: 'startup_progress', turnId: 'some-other-turn', stage: 'tools_prepare' });
    emit({ type: 'startup_progress', turnId: command.turnId, stage: 'provider_future_stage' });
    status = 'busy';
    emit({ type: 'status', requestId: command.requestId, status, state });
    emit({ type: 'startup_progress', turnId: command.turnId, stage: 'cli_start' });
    setTimeout(() => {
      status = 'ready';
      emit({ type: 'final', turnId: command.turnId, content: 'done', state });
    }, 50);
  } else if (command.type === 'detach' || command.type === 'reattach'
    || command.type === 'cancel' || command.type === 'status') {
    if (command.type === 'cancel') status = 'closed';
    emit({ type: 'status', requestId: command.requestId, status, state });
  }
});
