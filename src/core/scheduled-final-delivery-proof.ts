import { createHash } from 'node:crypto';
import { projectGroupContextCard } from '../im/lark/group-context-card.js';
import { isConfirmedLarkMessageId } from './scheduled-run-settlement.js';
import { parseScheduledTurnId } from './scheduled-turn-provenance.js';

const ELEMENT_PREFIX = 'botmux_scheduled_final_receipt_';

export interface ScheduledFinalDeliveryIdentity {
  turnId: string;
  workerGeneration: number;
  dispatchAttempt?: number;
}

export function scheduledFinalDeliveryElementId(
  input: ScheduledFinalDeliveryIdentity,
): string | undefined {
  if (parseScheduledTurnId(input.turnId) === null
      || !Number.isSafeInteger(input.workerGeneration)
      || input.workerGeneration < 1
      || (input.dispatchAttempt !== undefined
        && (!Number.isSafeInteger(input.dispatchAttempt) || input.dispatchAttempt < 1))) {
    return undefined;
  }
  const digest = createHash('sha256')
    .update('botmux.scheduled-final-delivery.v1\0', 'utf8')
    .update(input.turnId, 'utf8')
    .update('\0', 'utf8')
    .update(String(input.workerGeneration), 'utf8')
    .update('\0', 'utf8')
    .update(input.dispatchAttempt === undefined ? '-' : String(input.dispatchAttempt), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${ELEMENT_PREFIX}${digest}`;
}

/** Add an invisible, turn-specific carrier that Lark preserves in structured
 * card readback. It proves the provider message was built for this exact
 * scheduled turn/generation; a client-reported message id alone proves none of
 * that. */
export function stampScheduledFinalDeliveryProof<T extends Record<string, any>>(
  card: T,
  elementId: string,
): T {
  if (!elementId.startsWith(ELEMENT_PREFIX)
      || !Array.isArray(card.body?.elements)) return card;
  card.body.elements.push({
    tag: 'markdown',
    content: '\u2063',
    text_size: 'notation',
    element_id: elementId,
  });
  return card;
}

function hasElementId(value: unknown, elementId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => hasElementId(item, elementId));
  const record = value as Record<string, unknown>;
  if (record.element_id === elementId) return true;
  if (typeof record.user_dsl === 'string') {
    try {
      if (hasElementId(JSON.parse(record.user_dsl), elementId)) return true;
    } catch { /* malformed optional wrapper */ }
  }
  return Object.values(record).some(item => hasElementId(item, elementId));
}

export type ScheduledFinalDeliveryReadback =
  | { ok: true }
  | { ok: false; error: string };

/** Verify the authoritative provider readback before scheduler settlement. */
export function verifyScheduledFinalDeliveryReadback(input: {
  detail: unknown;
  messageId: string;
  larkAppId: string;
  chatId: string;
  elementId: string;
}): ScheduledFinalDeliveryReadback {
  if (!isConfirmedLarkMessageId(input.messageId)) {
    return { ok: false, error: 'invalid_message_id' };
  }
  const detail = input.detail as any;
  const item = detail?.items?.[0] ?? detail?.message ?? detail;
  if (!item || typeof item !== 'object' || item.message_id !== input.messageId) {
    return { ok: false, error: 'provider_message_not_found' };
  }
  if (item.deleted === true) return { ok: false, error: 'provider_message_deleted' };
  if (item.chat_id !== input.chatId) return { ok: false, error: 'provider_chat_mismatch' };
  const sender = item.sender;
  const senderType = sender?.sender_type;
  const senderIdType = sender?.id_type ?? sender?.sender_id_type;
  const senderAppId = typeof sender?.id === 'string'
    && (senderType === 'app' || senderType === 'bot' || senderIdType === 'app_id')
    ? sender.id
    : undefined;
  if (senderAppId !== input.larkAppId) {
    return { ok: false, error: 'provider_sender_mismatch' };
  }
  const content = item.body?.content ?? item.content;
  if (typeof content !== 'string') return { ok: false, error: 'provider_content_missing' };
  let card: unknown;
  try { card = JSON.parse(content); } catch { return { ok: false, error: 'provider_content_invalid' }; }
  if (!hasElementId(card, input.elementId)) {
    return { ok: false, error: 'provider_turn_proof_missing' };
  }
  const projection = projectGroupContextCard(content, { botmuxSender: true });
  if (projection?.kind !== 'conversation') {
    return { ok: false, error: 'provider_final_not_confirmed' };
  }
  return { ok: true };
}
