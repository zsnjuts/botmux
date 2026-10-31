/**
 * Executes the worker's real deliverRemoteRunnerOutboundMessage and
 * deliverRemoteTurnFinal (see helpers/worker-function-harness.ts) to prove the
 * wiring of Mew #80: a link the requester was @-mentioned with in this turn's
 * progress message is not posted again by the final answer, while every other
 * shape keeps the final unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  RemoteRunnerOutboundMessage,
  RemoteRunnerOutboundMessageResult,
} from '../src/adapters/backend/remote-runner-protocol.js';
import {
  bridgePostText,
  isBridgeNothingToSendFinal,
  shouldSuppressBridgeEmit,
} from '../src/services/bridge-fallback-gate.js';
import {
  RemoteFinalLinkLedger,
  dedupeRemoteFinalLinks,
  outboundLinksReachedRequester,
} from '../src/services/remote-final-link-dedupe.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const AUTH = 'https://accounts.example.com/oauth/device/verify?flow_id=f1&user_code=ABCD-EFGH';
const TURN = 'om_turn_1';

function harness(sendResult: RemoteRunnerOutboundMessageResult = { outcome: 'delivered', messageId: 'om_progress' }) {
  const scope: Record<string, any> = {
    // turn state
    sessionId: 'session-1',
    currentBotmuxTurnId: TURN,
    currentBotmuxDispatchAttempt: 1,
    activeTurnAuthority: { identity: () => ({ turnId: scope.currentBotmuxTurnId, dispatchAttempt: scope.currentBotmuxDispatchAttempt }) },
    mojoTurnMark: null,
    lastInitConfig: { larkAppId: 'cli_app', chatId: 'oc_chat', rootMessageId: 'om_root' },
    config: { session: { dataDir: '/tmp/botmux-test-sessions' } },
    resolveReplyFooterPreferences: () => ({}),
    resolveChildBotsConfig: () => undefined,
    sendRemoteRunnerOutboundMessage: vi.fn(async () => sendResult),
    // final bridge gate
    readSendMarkers: () => [],
    notifyExplicitRepliesObserved: vi.fn(),
    attributableExplicitReplyMarkersForTurnWindow: () => [],
    shouldSuppressBridgeEmit,
    isBridgeNothingToSendFinal,
    replyDeliveryMode: () => 'send',
    bridgePostText,
    // the code under test
    remoteFinalLinkLedger: new RemoteFinalLinkLedger(),
    dedupeRemoteFinalLinks,
    outboundLinksReachedRequester,
    t: (key: string, vars?: { label?: string }) => (vars?.label ? `${vars.label}[${key}]` : `[${key}]`),
    log: vi.fn(),
    send: vi.fn(),
  };
  const outbound = loadWorkerFunction<(message: RemoteRunnerOutboundMessage) => Promise<RemoteRunnerOutboundMessageResult>>(
    'deliverRemoteRunnerOutboundMessage', scope,
  );
  const final = loadWorkerFunction<(text: string, turnId?: string) => void>('deliverRemoteTurnFinal', scope);
  const finalContents = () => scope.send.mock.calls
    .map(([msg]: [any]) => msg)
    .filter((msg: any) => msg.type === 'final_output')
    .map((msg: any) => msg.content);
  return { scope, outbound, final, finalContents };
}

function progress(overrides: Partial<RemoteRunnerOutboundMessage> = {}): RemoteRunnerOutboundMessage {
  return {
    operationId: 'op-1',
    turnId: TURN,
    generation: 1,
    content: `请点击授权：${AUTH}`,
    responseKind: 'progress',
    mention: 'requester',
    ...overrides,
  };
}

describe('worker: remote final does not repeat a link already sent with --mention-back', () => {
  it('replaces the duplicated link in the final and keeps the prose', async () => {
    const h = harness();
    await h.outbound(progress());
    h.final(`已发起授权，请打开 ${AUTH} 完成。`, TURN);
    expect(h.finalContents()).toEqual([
      '已发起授权，请打开 [worker.remote_final.link_sent_above] 完成。',
    ]);
  });

  it('keeps the link when the progress message did not mention the requester', async () => {
    const h = harness();
    await h.outbound(progress({ mention: 'none' }));
    h.final(`请打开 ${AUTH}`, TURN);
    expect(h.finalContents()).toEqual([`请打开 ${AUTH}`]);
  });

  it('keeps the link when the mention-back send was not confirmed delivered', async () => {
    const h = harness({ outcome: 'unknown', code: 'outbound_delivery_unknown', message: 'timeout' });
    await h.outbound(progress());
    h.final(`请打开 ${AUTH}`, TURN);
    expect(h.finalContents()).toEqual([`请打开 ${AUTH}`]);
  });

  it('does not carry links across dispatch attempts or past the turn final', async () => {
    const h = harness();
    await h.outbound(progress());
    h.scope.currentBotmuxDispatchAttempt = 2;
    h.final(`请打开 ${AUTH}`, TURN);
    expect(h.finalContents()).toEqual([`请打开 ${AUTH}`]);

    h.scope.send.mockClear();
    h.scope.currentBotmuxDispatchAttempt = 1;
    await h.outbound(progress());
    h.final(`[授权](${AUTH})`, TURN);
    h.final(`[授权](${AUTH})`, TURN);
    expect(h.finalContents()).toEqual([
      '授权[worker.remote_final.link_sent_above_labeled]',
      `[授权](${AUTH})`,
    ]);
  });
});
