import { createHash } from 'node:crypto';
import { projectGroupContextCard } from '../im/lark/group-context-card.js';
import { isConfirmedLarkMessageId } from './scheduled-run-settlement.js';
import { parseScheduledTurnId } from './scheduled-turn-provenance.js';

// Lark Card 2.0 element_id must begin with a letter and be at most 20 chars.
// Keep 52 digest bits after the stable seven-character namespace.
const ELEMENT_PREFIX = 'bmxsfr_';
const ELEMENT_ID_MAX_LENGTH = 20;
const ELEMENT_ID_PATTERN = /^bmxsfr_[0-9a-f]{13}$/;

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
    .slice(0, ELEMENT_ID_MAX_LENGTH - ELEMENT_PREFIX.length);
  return `${ELEMENT_PREFIX}${digest}`;
}

export function isScheduledFinalDeliveryElementId(value: unknown): value is string {
  return typeof value === 'string' && ELEMENT_ID_PATTERN.test(value);
}

/** Bind the turn-specific proof to a real card element that Lark preserves in
 * structured readback.  The old carrier combined an overlong element id with a
 * standalone markdown body containing only an invisible Unicode separator;
 * neither is a provider-durable Card 2.0 contract even though both survive
 * local renderer tests.
 *
 * Prefer the footer separator because changing only its `element_id` leaves the
 * user-visible rendering equivalent. If no unkeyed separator exists, append
 * one. The fixed `hr` shape lets readback distinguish a real Card 2.0
 * component from callback payloads or arbitrary business JSON.
 *
 * The provider readback still has to match this exact proof.  A client-reported
 * message id alone proves none of the scheduled turn/generation identity. */
export function stampScheduledFinalDeliveryProof<T extends Record<string, any>>(
  card: T,
  elementId: string,
): T {
  if (!isScheduledFinalDeliveryElementId(elementId)
      || !Array.isArray(card.body?.elements)) return card;
  const elements = card.body.elements as Array<Record<string, unknown>>;
  const reusable = [...elements].reverse().find(element =>
    element?.tag === 'hr' && element.element_id === undefined);
  if (reusable) reusable.element_id = elementId;
  else elements.push({ tag: 'hr', element_id: elementId });
  return card;
}

function providerCardRoot(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (typeof root.user_dsl !== 'string') return root;
  try {
    const inner = JSON.parse(root.user_dsl) as unknown;
    return inner && typeof inner === 'object' && !Array.isArray(inner)
      ? inner as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** The proof writer stamps only a top-level Card 2.0 body component.  Match
 * that exact provider-preserved structure rather than recursively scanning
 * arbitrary JSON: callback `behaviors[].value`, URLs, chart data and other
 * model-authored payloads are data, not delivery-proof components. */
function hasProviderComponentElementId(value: unknown, elementId: string): boolean {
  const root = providerCardRoot(value);
  const body = root?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const elements = (body as Record<string, unknown>).elements;
  return Array.isArray(elements) && elements.some(element =>
    !!element
    && typeof element === 'object'
    && !Array.isArray(element)
    && (element as Record<string, unknown>).tag === 'hr'
    && isScheduledFinalDeliveryElementId((element as Record<string, unknown>).element_id)
    && (element as Record<string, unknown>).element_id === elementId);
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
  if (!hasProviderComponentElementId(card, input.elementId)) {
    return { ok: false, error: 'provider_turn_proof_missing' };
  }
  const projection = projectGroupContextCard(content, { botmuxSender: true });
  if (projection?.kind !== 'conversation') {
    return { ok: false, error: 'provider_final_not_confirmed' };
  }
  return { ok: true };
}
