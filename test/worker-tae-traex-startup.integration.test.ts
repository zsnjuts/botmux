import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, TrustedCaller, WorkerToDaemon } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const tmuxAvailable = probeTmuxFunctional().ok;
const children = new Set<ChildProcess>();
const roots = new Set<string>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const root of roots) {
    try {
      execFileSync('tmux', ['kill-server'], {
        env: { ...process.env, TMUX_TMPDIR: root },
        stdio: 'ignore',
      });
    } catch { /* already stopped */ }
    rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

async function waitFor(check: () => boolean, logs: string[], timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Worker condition timed out\n${logs.join('')}`);
}

function runnerReceivedContent(input: string, expected: string): boolean {
  for (const line of input.split(/[\r\n]+/)) {
    const marker = '::botmux-tae-traex:';
    if (!line.startsWith(marker)) continue;
    try {
      const payload = JSON.parse(Buffer.from(line.slice(marker.length), 'base64').toString('utf8')) as {
        content?: unknown;
      };
      if (payload.content === expected) return true;
    } catch { /* ignore an incomplete or unrelated runner frame */ }
  }
  return false;
}

function startWorker(trustedCaller: TrustedCaller) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-tae-traex-startup-'));
  roots.add(root);
  const dataDir = join(root, 'data');
  const inputFile = join(root, 'input.log');
  const fakeRunner = join(root, 'fake-tae-traex-runner');
  writeFileSync(fakeRunner, `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.setRawMode?.(true);
process.stdin.on('data', chunk => fs.appendFileSync(${JSON.stringify(inputFile)}, chunk));
process.stdout.write('[tae-traex:ready] › ');
setInterval(() => {}, 1_000);
`);
  chmodSync(fakeRunner, 0o755);

  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      // Keep the worker startup deterministic in CI/devboxes. The host's
      // interactive zsh rc stack can spend several seconds in nested startup
      // helpers before the test runner is exec'd, which tests shell startup
      // rather than the TAE ready-gate behavior below.
      SHELL: '/bin/bash',
      TMUX_TMPDIR: root,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'sid-tae-traex-startup',
      BOTMUX_TIME_SCALE: '0.05',
      LARK_APP_ID: 'app_test',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.on('message', raw => {
    messages.push(raw as WorkerToDaemon);
    logs.push(`[ipc] ${JSON.stringify(raw)}\n`);
  });
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init',
    sessionId: 'sid-tae-traex-startup',
    chatId: 'oc_test',
    rootMessageId: 'om_root',
    workingDir: root,
    cliId: 'tae-traex',
    cliPathOverride: fakeRunner,
    backendType: 'tmux',
    prompt: 'TAE_STARTUP_MARKER',
    turnId: 'om_tae_startup',
    trustedCaller,
    larkAppId: 'app_test',
    larkAppSecret: 'secret',
  } satisfies DaemonToWorker);

  return {
    messages,
    logs,
    input: () => existsSync(inputFile) ? readFileSync(inputFile, 'utf8') : '',
    pane: () => {
      try {
        return execFileSync('tmux', ['capture-pane', '-e', '-p', '-t', 'bmx-sid-tae-'], {
          env: { ...process.env, TMUX_TMPDIR: root },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { return ''; }
    },
  };
}

describe.skipIf(!tmuxAvailable)('TAE TraeX worker startup', () => {
  it('does not lose a one-shot ready prompt emitted before worker initialization finishes', async () => {
    const worker = startWorker({
      requestUserOpenId: 'ou_human',
      requestLarkAppId: 'app_test',
      senderType: 'user',
    });

    await waitFor(() => worker.pane().includes('[tae-traex:ready]'), worker.logs);
    await waitFor(() => runnerReceivedContent(worker.input(), 'TAE_STARTUP_MARKER'), worker.logs);
    expect(worker.logs.join('')).not.toContain('First prompt hard timeout');
  }, 15_000);

  it('forwards bot caller authority to the runner for explicit inheritance policy', async () => {
    const worker = startWorker({
      requestUserOpenId: 'ou_peer_bot',
      requestLarkAppId: 'app_test',
      senderType: 'bot',
    });

    await waitFor(() => worker.pane().includes('[tae-traex:ready]'), worker.logs);
    await waitFor(() => runnerReceivedContent(worker.input(), 'TAE_STARTUP_MARKER'), worker.logs);
    expect(worker.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'final_output',
        turnId: 'om_tae_startup',
        turnFailed: true,
      }),
    ]));
  }, 15_000);
});
