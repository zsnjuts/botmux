/**
 * POST /api/sessions/:sessionId/turn-delivery — the daemon-side delivery row
 * for a final answer that an isolated CLI (bwrap relay / macOS read isolation)
 * already sent but cannot index itself, because the shared feedback store is
 * not exposed to the session.
 *
 * Pins: the sandbox aperture admits the route only with the URL session's
 * current capability; every correlation field comes from the live session,
 * never from the body; the row is idempotent per message and cannot be rebound
 * to another turn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setIpcAuthSecret,
  setScheduledSelfCleanupReceiptHandler,
  setScheduledSelfCleanupReceiptLookupHandler,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import { config } from '../src/config.js';
import {
  getSkillFeedbackStore,
  __testOnly_closeSkillFeedbackStores,
} from '../src/services/skill-feedback-store.js';
import { RELAYED_TURN_DELIVERY_MAX_BYTES } from '../src/core/relayed-turn-delivery.js';
import {
  __testOnlyResetScheduledRunSettlements,
  beginScheduledRunSettlement,
  revokeScheduledRunSettlements,
} from '../src/core/scheduled-run-settlement.js';
import {
  deriveScheduledFinalDeliveryProof,
  stampScheduledFinalDeliveryProof,
} from '../src/core/scheduled-final-delivery-proof.js';
import { markGroupContextCardPurpose } from '../src/im/lark/group-context-card.js';
import * as larkClient from '../src/im/lark/client.js';
import * as botRegistry from '../src/bot-registry.js';

const SECRET = 'turn-delivery-narrow-secret';
const CAP_A = 'ab12cd34'.repeat(8);
const CAP_B = 'ef56ab78'.repeat(8);

let handle: IpcServerHandle | null = null;
let dataDir: string | null = null;
let prevDataDir: string | null = null;

afterEach(async () => {
  __testOnlyResetScheduledRunSettlements();
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  setScheduledSelfCleanupReceiptHandler(null);
  setScheduledSelfCleanupReceiptLookupHandler(null);
  await __testOnly_closeSkillFeedbackStores();
  if (prevDataDir !== null) config.session.dataDir = prevDataDir;
  prevDataDir = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
  vi.restoreAllMocks();
});

function liveSession(sessionId: string, capability: string, turnId: string | undefined, extra: Record<string, unknown> = {}): any {
  return {
    session: {
      sessionId,
      status: 'active',
      chatId: `oc_${sessionId}`,
      rootMessageId: `om_root_${sessionId}`,
      cliSessionId: `native-${sessionId}`,
      cliId: 'claude-code',
      model: 'opus',
      workerGeneration: 7,
      ...extra,
    },
    worker: { killed: false, connected: true, send: vi.fn() },
    larkAppId: 'cli_app',
    chatId: `oc_${sessionId}`,
    chatType: 'group',
    cliVersion: '9.9.9',
    workerGeneration: 7,
    managedTurnOrigin: { capability, ...(turnId ? { turnId, dispatchAttempt: 2 } : {}) },
  };
}

async function setup(sessions: Record<string, any>): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'ipc-turn-delivery-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation((id: string) => sessions[id]);
  setIpcAuthSecret(SECRET);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
}

function post(sessionId: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle!.port}/api/sessions/${encodeURIComponent(sessionId)}/turn-delivery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function rowFor(messageId: string) {
  const store = await getSkillFeedbackStore(dataDir!);
  return store.findDeliveryByPlatformMessage('lark', 'cli_app', messageId);
}

describe('POST /api/sessions/:sessionId/turn-delivery', () => {
  it('settles the exact scheduled turn only from an authenticated final receipt', async () => {
    const turnId = 'schedule:deadbeef:00000000-0000-4000-8000-000000000011';
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, turnId) });
    const proof = deriveScheduledFinalDeliveryProof({
      turnId,
      workerGeneration: 7,
      dispatchAttempt: 2,
    })!;
    const stamped = stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, proof);
    const card = markGroupContextCardPurpose(stamped, 'message');
    vi.spyOn(larkClient, 'getMessageDetail').mockResolvedValue({ items: [{
      message_id: 'om_answer_final',
      chat_id: 'oc_sess-a',
      root_id: 'om_root_sess-a',
      parent_id: 'om_root_sess-a',
      thread_id: 'omt_sess-a',
      deleted: false,
      msg_type: 'interactive',
      sender: { id: 'cli_app', id_type: 'app_id', sender_type: 'app' },
      body: { content: JSON.stringify(card) },
    }] });
    const settlement = beginScheduledRunSettlement({
      turnId,
      taskId: 'deadbeef',
      requireFinalDelivery: true,
    });

    const res = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_answer_final',
      content: 'final answer',
      responseKind: 'final',
      receiptTurnId: turnId,
      receiptWorkerGeneration: 7,
      receiptDispatchAttempt: 2,
      receiptProof: proof,
    });
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toMatchObject({
      ok: true,
      trustedFinalReceipt: {
        domain: 'botmux.scheduled-final-receipt.v1',
        trusted: true,
        messageId: 'om_answer_final',
        turnId,
        workerGeneration: 7,
        dispatchAttempt: 2,
        proof,
      },
    });
    await expect(settlement.settled).resolves.toEqual({ messageId: 'om_answer_final' });

    const replay = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_answer_final',
      content: 'final answer',
      responseKind: 'final',
      receiptTurnId: turnId,
      receiptWorkerGeneration: 7,
      receiptDispatchAttempt: 2,
      receiptProof: proof,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      ok: true,
      duplicate: true,
      trustedFinalReceipt: {
        domain: 'botmux.scheduled-final-receipt.v1',
        messageId: 'om_answer_final',
        turnId,
      },
    });
  });

  it('does not settle a client-reported id that provider readback cannot prove', async () => {
    const turnId = 'schedule:deadbeef:00000000-0000-4000-8000-000000000012';
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, turnId) });
    const proof = deriveScheduledFinalDeliveryProof({
      turnId,
      workerGeneration: 7,
      dispatchAttempt: 2,
    })!;
    vi.spyOn(larkClient, 'getMessageDetail').mockResolvedValue({ items: [] });
    const settlement = beginScheduledRunSettlement({
      turnId,
      taskId: 'deadbeef',
      requireFinalDelivery: true,
    });

    const res = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_forged',
      content: 'not actually delivered',
      responseKind: 'final',
      receiptTurnId: turnId,
      receiptWorkerGeneration: 7,
      receiptDispatchAttempt: 2,
      receiptProof: proof,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'provider_message_not_found' });
    let settled = false;
    void settlement.settled.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('rejects a proved final delivered to another topic in the same chat', async () => {
    const turnId = 'schedule:deadbeef:00000000-0000-4000-8000-000000000112';
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, turnId) });
    const proof = deriveScheduledFinalDeliveryProof({
      turnId,
      workerGeneration: 7,
      dispatchAttempt: 2,
    })!;
    const card = markGroupContextCardPurpose(stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'misrouted final' }] },
    }, proof), 'message');
    vi.spyOn(larkClient, 'getMessageDetail').mockResolvedValue({ items: [{
      message_id: 'om_wrong_topic_final',
      chat_id: 'oc_sess-a',
      root_id: 'om_other_topic',
      parent_id: 'om_other_topic',
      thread_id: 'omt_other_topic',
      deleted: false,
      msg_type: 'interactive',
      sender: { id: 'cli_app', id_type: 'app_id', sender_type: 'app' },
      body: { content: JSON.stringify(card) },
    }] });
    const settlement = beginScheduledRunSettlement({
      turnId,
      taskId: 'deadbeef',
      requireFinalDelivery: true,
    });

    const res = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_wrong_topic_final',
      content: 'misrouted final',
      responseKind: 'final',
      receiptTurnId: turnId,
      receiptWorkerGeneration: 7,
      receiptDispatchAttempt: 2,
      receiptProof: proof,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'provider_target_mismatch' });
    let settled = false;
    void settlement.settled.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('replays a persisted cleanup receipt after remove revoked the live settlement', async () => {
    const turnId = 'schedule:deadbeef:00000000-0000-4000-8000-000000000113';
    const sessions = { 'sess-a': liveSession('sess-a', CAP_A, turnId) };
    await setup(sessions);
    const proof = deriveScheduledFinalDeliveryProof({
      turnId,
      workerGeneration: 7,
      dispatchAttempt: 2,
    })!;
    const card = markGroupContextCardPurpose(stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'cleanup final' }] },
    }, proof), 'message');
    vi.spyOn(larkClient, 'getMessageDetail').mockResolvedValue({ items: [{
      message_id: 'om_cleanup_final',
      chat_id: 'oc_sess-a',
      root_id: 'om_root_sess-a',
      parent_id: 'om_root_sess-a',
      thread_id: 'omt_sess-a',
      deleted: false,
      msg_type: 'interactive',
      sender: { id: 'cli_app', id_type: 'app_id', sender_type: 'app' },
      body: { content: JSON.stringify(card) },
    }] });
    const settlement = beginScheduledRunSettlement({
      turnId,
      taskId: 'deadbeef',
      larkAppId: 'cli_app',
      requireFinalDelivery: true,
    });
    let persisted: Record<string, unknown> | undefined;
    setScheduledSelfCleanupReceiptHandler(request => {
      const { action, ...value } = request;
      if (action === 'record') {
        persisted = value;
        return true;
      }
      return JSON.stringify(persisted) === JSON.stringify(value);
    });
    setScheduledSelfCleanupReceiptLookupHandler(input => {
      if (!persisted
          || persisted.appId !== input.appId
          || persisted.taskId !== input.taskId
          || persisted.turnId !== input.turnId
          || persisted.messageId !== input.messageId) return undefined;
      return {
        domain: 'botmux.scheduled-final-receipt.v1',
        trusted: true,
        messageId: String(persisted.messageId),
        turnId: String(persisted.turnId),
        workerGeneration: Number(persisted.workerGeneration),
        ...(typeof persisted.dispatchAttempt === 'number'
          ? { dispatchAttempt: persisted.dispatchAttempt }
          : {}),
        proof: String(persisted.proof),
      };
    });
    const payload = {
      originCapability: CAP_A,
      messageId: 'om_cleanup_final',
      content: 'cleanup final',
      responseKind: 'final',
      receiptTurnId: turnId,
      receiptWorkerGeneration: 7,
      receiptDispatchAttempt: 2,
      receiptProof: proof,
      receiptScheduleSelfCleanup: true,
    };

    const first = await post('sess-a', payload);
    expect(first.status).toBe(200);
    await expect(settlement.settled).resolves.toEqual({ messageId: 'om_cleanup_final' });
    expect(revokeScheduledRunSettlements('deadbeef', 'cli_app')).toBe(1);
    sessions['sess-a'] = liveSession('sess-a', CAP_A, turnId, { workerGeneration: 8 });
    sessions['sess-a'].workerGeneration = 8;

    const afterLostRemoveResponse = await post('sess-a', {
      ...payload,
      receiptWorkerGeneration: 8,
      receiptProof: deriveScheduledFinalDeliveryProof({
        turnId,
        workerGeneration: 8,
        dispatchAttempt: 2,
      }),
    });
    expect(afterLostRemoveResponse.status).toBe(200);
    expect(await afterLostRemoveResponse.json()).toMatchObject({
      ok: true,
      duplicate: true,
      trustedFinalReceipt: {
        messageId: 'om_cleanup_final',
        turnId,
        workerGeneration: 7,
        proof,
      },
    });
  });

  it('rejects a receipt from a stale worker generation before provider readback', async () => {
    const turnId = 'schedule:deadbeef:00000000-0000-4000-8000-000000000013';
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, turnId) });
    const staleProof = deriveScheduledFinalDeliveryProof({
      turnId,
      workerGeneration: 6,
      dispatchAttempt: 2,
    })!;
    const readback = vi.spyOn(larkClient, 'getMessageDetail');

    const res = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_stale_generation',
      content: 'stale',
      responseKind: 'final',
      receiptTurnId: turnId,
      receiptWorkerGeneration: 6,
      receiptDispatchAttempt: 2,
      receiptProof: staleProof,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'scheduled_delivery_origin_changed',
    });
    expect(readback).not.toHaveBeenCalled();
  });

  it('records the row from the live session, ignoring body-supplied correlation fields', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    const res = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_answer_1',
      content: 'final answer',
      // None of these may be honoured.
      turnId: 'turn-forged',
      sessionId: 'sess-b',
      botAppId: 'cli_other',
      chatId: 'oc_elsewhere',
      policy: { audience: 'everyone' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: false });
    expect(await rowFor('om_answer_1')).toMatchObject({
      botAppId: 'cli_app',
      sessionId: 'sess-a',
      turnId: 'turn-a',
      dispatchAttempt: 2,
      nativeSessionId: 'native-sess-a',
      chatId: 'oc_sess-a',
      topicRootId: 'om_root_sess-a',
      correlationDiscriminator: 'om_answer_1',
      cliId: 'claude-code',
      cliVersion: '9.9.9',
      model: 'opus',
      cardMode: 'card',
      status: 'delivered',
      policy: undefined,
      baseCard: undefined,
    });
  });

  it('reconstructs feedback and an exact chat-scope topic target from Host readback', async () => {
    const turnId = 'om_feedback_turn';
    const ds = liveSession('sess-a', CAP_A, turnId, {
      scope: 'chat',
      ownerOpenId: 'ou_owner',
      turnReplyContexts: {
        [turnId]: {
          target: { mode: 'thread', rootMessageId: 'om_exact_topic' },
          replyTargetSenderOpenId: 'ou_requester',
        },
      },
    });
    ds.scope = 'chat';
    await setup({ 'sess-a': ds });
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: {
        apiOnly: false,
        feedback: { enabled: true, audience: 'requester' },
        chatFeedbackPolicies: {},
      },
    } as any);
    const card = {
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', content: 'feedback final' },
        { tag: 'action', element_id: 'botmux_feedback', actions: [] },
      ] },
    };
    vi.spyOn(larkClient, 'getMessageDetail').mockResolvedValue({ items: [{
      message_id: 'om_feedback_final',
      chat_id: 'oc_sess-a',
      root_id: 'om_exact_topic',
      parent_id: 'om_exact_topic',
      thread_id: 'omt_exact_topic',
      deleted: false,
      msg_type: 'interactive',
      sender: { id: 'cli_app', id_type: 'app_id', sender_type: 'app' },
      body: { content: JSON.stringify(card) },
    }] });

    const res = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_feedback_final',
      content: 'feedback final',
      responseKind: 'final',
    });
    expect(res.status).toBe(200);
    expect(await rowFor('om_feedback_final')).toMatchObject({
      cardMode: 'feedback',
      policy: { audience: 'requester' },
      baseCard: {
        body: { elements: [{ element_id: 'botmux_feedback' }] },
      },
      requesterSubjectId: 'ou_requester',
      topicRootId: 'om_exact_topic',
    });
  });

  it('rejects feedback readback with contradictory Provider sender metadata', async () => {
    const turnId = 'om_feedback_sender_conflict';
    const ds = liveSession('sess-a', CAP_A, turnId, {
      ownerOpenId: 'ou_owner',
      turnReplyContexts: {
        [turnId]: {
          target: { mode: 'thread', rootMessageId: 'om_root_sess-a' },
          replyTargetSenderOpenId: 'ou_requester',
        },
      },
    });
    await setup({ 'sess-a': ds });
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: {
        apiOnly: false,
        feedback: { enabled: true, audience: 'requester' },
        chatFeedbackPolicies: {},
      },
    } as any);
    vi.spyOn(larkClient, 'getMessageDetail').mockResolvedValue({ items: [{
      message_id: 'om_feedback_sender_conflict',
      chat_id: 'oc_sess-a',
      root_id: 'om_root_sess-a',
      parent_id: 'om_root_sess-a',
      thread_id: 'omt_sess-a',
      deleted: false,
      msg_type: 'interactive',
      sender: { id: 'cli_app', id_type: 'app_id', sender_type: 'user' },
      body: { content: JSON.stringify({
        schema: '2.0',
        body: { elements: [{ tag: 'markdown', content: 'feedback final' }] },
      }) },
    }] });

    const res = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_feedback_sender_conflict',
      content: 'feedback final',
      responseKind: 'final',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'turn_delivery_feedback_readback_invalid',
    });
    expect(await rowFor('om_feedback_sender_conflict')).toBeUndefined();
  });

  it('403s a capability presented against another session and writes nothing', async () => {
    await setup({
      'sess-a': liveSession('sess-a', CAP_A, 'turn-a'),
      'sess-b': liveSession('sess-b', CAP_B, 'turn-b'),
    });
    const res = await post('sess-b', { originCapability: CAP_A, messageId: 'om_x', content: 'x' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
    const missing = await post('sess-gone', { originCapability: CAP_A, messageId: 'om_x', content: 'x' });
    expect(missing.status).toBe(403);
    expect(await rowFor('om_x')).toBeUndefined();
  });

  it('403s once the turn capability has rotated (turn over)', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_B, 'turn-next') });
    const res = await post('sess-a', { originCapability: CAP_A, messageId: 'om_late', content: 'late' });
    expect(res.status).toBe(403);
    expect(await rowFor('om_late')).toBeUndefined();
  });

  it('409s when the live origin carries no turn', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, undefined) });
    const res = await post('sess-a', { originCapability: CAP_A, messageId: 'om_unbound', content: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'turn_unbound' });
    expect(await rowFor('om_unbound')).toBeUndefined();
  });

  it('404s a closed session', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a', { status: 'closed' }) });
    const res = await post('sess-a', { originCapability: CAP_A, messageId: 'om_closed', content: 'x' });
    expect(res.status).toBe(404);
    expect(await rowFor('om_closed')).toBeUndefined();
  });

  it.each([
    ['non-om message id', { messageId: 'oc_not_a_message', content: 'x' }],
    ['malformed om message id', { messageId: 'om_!', content: 'x' }],
    ['message id with a path separator', { messageId: 'om_a/b', content: 'x' }],
    ['empty content', { messageId: 'om_empty', content: '' }],
    ['non-string content', { messageId: 'om_obj', content: { text: 'x' } }],
  ])('400s %s', async (_label, payload) => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    const res = await post('sess-a', { originCapability: CAP_A, ...payload });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_turn_delivery' });
  });

  it('413s an oversized body before authenticating it', async () => {
    await setup({ 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') });
    const res = await post('sess-a', {
      originCapability: CAP_A,
      messageId: 'om_big',
      content: 'x'.repeat(RELAYED_TURN_DELIVERY_MAX_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await rowFor('om_big')).toBeUndefined();
  });

  it('is idempotent for the same message and refuses to rebind it to another turn', async () => {
    const sessions: Record<string, any> = { 'sess-a': liveSession('sess-a', CAP_A, 'turn-a') };
    await setup(sessions);
    const first = await post('sess-a', { originCapability: CAP_A, messageId: 'om_once', content: 'answer' });
    expect(first.status).toBe(200);
    const again = await post('sess-a', { originCapability: CAP_A, messageId: 'om_once', content: 'answer' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true });

    sessions['sess-a'] = liveSession('sess-a', CAP_B, 'turn-b');
    const rebind = await post('sess-a', { originCapability: CAP_B, messageId: 'om_once', content: 'answer' });
    expect(rebind.status).toBe(409);
    expect(await rebind.json()).toMatchObject({ ok: false, error: 'message_already_recorded' });
    expect(await rowFor('om_once')).toMatchObject({ turnId: 'turn-a' });
  });
});
