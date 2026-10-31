import { createHash } from 'node:crypto';
import type { DurableInboxPrimaryDispatchResult } from './durable-inbox-primary-consumer.js';
import type { DurableLarkMessageClaim } from './durable-inbox-shadow.js';
import type { DurableCoordinationStore } from './durable-coordination.js';
import { durableLarkOutboxMessage } from './durable-lark-outbox.js';

export const MESSAGE_QUOTA_INFRASTRUCTURE_RETRY = 'message_quota_infrastructure_unavailable';

export const MESSAGE_QUOTA_RETRY_NOTICE_ZH =
  '⚠️ 这条消息已收到，但机器人当前遇到配置或额度状态异常，正在安全重试。'
  + '消息不会丢失，请勿重复发送；恢复后会自动继续处理。';

export interface DurableInboxRetryNotice {
  anchor: string;
  content: string;
  providerUuid: string;
}

/** Build the one user-visible notice that is safe to replay on every claim. */
export function durableInboxRetryNotice(
  message: DurableLarkMessageClaim,
  result: Extract<DurableInboxPrimaryDispatchResult, { kind: 'retry' }>,
): DurableInboxRetryNotice | undefined {
  if (message.eventType !== 'lark.im.message.receive_v1'
      || result.reason !== MESSAGE_QUOTA_INFRASTRUCTURE_RETRY) return undefined;
  const digest = createHash('sha256').update(message.eventId).digest('hex');
  return {
    anchor: message.messageId,
    content: MESSAGE_QUOTA_RETRY_NOTICE_ZH,
    // Feishu UUID is the cross-Pod/crash dedupe fence.  Replaying the same
    // retry claim may call the provider again but cannot create another card.
    providerUuid: `retry_${digest.slice(0, 40)}`,
  };
}

export const MESSAGE_DROPPED_NOTICE_ZH =
  '⚠️ 这条消息多次处理失败，已停止重试，没有被执行。请稍后重新发送。';

export const MESSAGE_DELIVERY_UNCONFIRMED_NOTICE_ZH =
  '⚠️ 这条消息已经交给 Agent 执行，但之后的确认多次失败，已停止重试，结论可能没有发到话题里。'
  + '请勿重复发送；可以打开 Web 终端查看本轮输出，或稍后在话题里追问结论。';

/** The notice for a message row that was completed at the retry limit. A row
 * whose input already reached the worker was executed: telling the user it
 * was not would invite a duplicate run (Mew #68). */
export function durableInboxExhaustedNotice(
  message: DurableLarkMessageClaim,
  opts: { inputReachedWorker?: boolean } = {},
): DurableInboxRetryNotice | undefined {
  if (message.eventType !== 'lark.im.message.receive_v1') return undefined;
  const digest = createHash('sha256').update(message.eventId).digest('hex');
  return {
    anchor: message.messageId,
    content: opts.inputReachedWorker
      ? MESSAGE_DELIVERY_UNCONFIRMED_NOTICE_ZH
      : MESSAGE_DROPPED_NOTICE_ZH,
    providerUuid: `drop_${digest.slice(0, 40)}`,
  };
}

export async function enqueueDurableInboxRetryNotice(input: {
  store: DurableCoordinationStore;
  message: DurableLarkMessageClaim;
  result: Extract<DurableInboxPrimaryDispatchResult, { kind: 'retry' }>;
  ownerId: string;
  now?: number;
}): Promise<'ignored' | 'busy' | 'accepted'> {
  return enqueueDurableInboxNotice({
    ...input,
    notice: durableInboxRetryNotice(input.message, input.result),
  });
}

export async function enqueueDurableInboxExhaustedNotice(input: {
  store: DurableCoordinationStore;
  message: DurableLarkMessageClaim;
  ownerId: string;
  inputReachedWorker?: boolean;
  now?: number;
}): Promise<'ignored' | 'busy' | 'accepted'> {
  return enqueueDurableInboxNotice({
    ...input,
    notice: durableInboxExhaustedNotice(input.message, {
      inputReachedWorker: input.inputReachedWorker,
    }),
  });
}

async function enqueueDurableInboxNotice(input: {
  store: DurableCoordinationStore;
  message: DurableLarkMessageClaim;
  notice: DurableInboxRetryNotice | undefined;
  ownerId: string;
  now?: number;
}): Promise<'ignored' | 'busy' | 'accepted'> {
  const notice = input.notice;
  if (!notice) return 'ignored';
  const now = input.now ?? Date.now();
  const sessionKey = `retry-notice:${notice.providerUuid}`;
  const acquired = await input.store.acquireSessionLease({
    sessionKey,
    ownerId: input.ownerId,
    leaseDurationMs: 60_000,
  });
  if (acquired.kind !== 'acquired') return 'busy';
  try {
    const inserted = await input.store.enqueueOutbox({
      lease: acquired.lease,
      message: durableLarkOutboxMessage({
        messageId: `out_${notice.providerUuid}`,
        sessionKey,
        larkAppId: input.message.larkAppId,
        target: { kind: 'reply', messageId: notice.anchor, replyInThread: true },
        content: notice.content,
        msgType: 'text',
        providerUuid: notice.providerUuid,
        visibleAt: now,
        createdAt: now,
      }),
    });
    if (inserted.kind === 'conflict') {
      throw new Error('durable retry notice payload conflict');
    }
    if (inserted.kind === 'stale_lease') return 'busy';
    return 'accepted';
  } finally {
    await input.store.releaseSessionLease(acquired.lease).catch(() => undefined);
  }
}
