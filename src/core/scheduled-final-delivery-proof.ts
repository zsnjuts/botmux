import { createHash } from 'node:crypto';
import {
  canonicalReplyCardFooterPurpose,
  projectGroupContextCard,
} from '../im/lark/group-context-card.js';
import {
  containsReplyCardFooterElementId,
  countReplyCardFooterElementIds,
  findReplyCardFooterComponent,
  REPLY_CARD_FOOTER_ELEMENT_ID,
  REPLY_CARD_FOOTER_MARKER,
} from '../im/lark/reply-card-footer-signature.js';
import { isConfirmedLarkMessageId } from './scheduled-run-settlement.js';
import { parseScheduledTurnId } from './scheduled-turn-provenance.js';

const PROOF_PREFIX = 'bmxsfr_';
const PROOF_PATTERN = /^bmxsfr_[0-9a-f]{13}$/;
const PROOF_LINK_BASE = 'https://github.com/deepcoldy/bot%6Dux#';
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)\s]+)\)/gu;

export const SCHEDULED_FINAL_RECEIPT_DOMAIN = 'botmux.scheduled-final-receipt.v1';

export interface ScheduledFinalReceiptEnvelope {
  domain: typeof SCHEDULED_FINAL_RECEIPT_DOMAIN;
  trusted: true;
  messageId: string;
  turnId: string;
  workerGeneration: number;
  dispatchAttempt?: number;
  proof: string;
}

export interface ScheduledFinalDeliveryIdentity {
  turnId: string;
  workerGeneration: number;
  dispatchAttempt?: number;
}

export function deriveScheduledFinalDeliveryProof(
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
    .slice(0, 13);
  return `${PROOF_PREFIX}${digest}`;
}

export function isScheduledFinalDeliveryProof(value: unknown): value is string {
  return typeof value === 'string' && PROOF_PATTERN.test(value);
}

export function scheduledFinalReceiptEnvelope(input: {
  messageId: string;
  turnId: string;
  workerGeneration: number;
  dispatchAttempt?: number;
  proof: string;
}): ScheduledFinalReceiptEnvelope {
  return {
    domain: SCHEDULED_FINAL_RECEIPT_DOMAIN,
    trusted: true,
    messageId: input.messageId,
    turnId: input.turnId,
    workerGeneration: input.workerGeneration,
    ...(input.dispatchAttempt !== undefined
      ? { dispatchAttempt: input.dispatchAttempt }
      : {}),
    proof: input.proof,
  };
}

export function matchesScheduledFinalReceiptEnvelope(
  value: unknown,
  expected: ScheduledFinalReceiptEnvelope,
): value is ScheduledFinalReceiptEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  return actual.domain === expected.domain
    && actual.trusted === true
    && actual.messageId === expected.messageId
    && actual.turnId === expected.turnId
    && actual.workerGeneration === expected.workerGeneration
    && actual.dispatchAttempt === expected.dispatchAttempt
    && actual.proof === expected.proof;
}

function proofUrl(proof: string): string {
  return `${PROOF_LINK_BASE}${proof}`;
}

function isProofUrl(value: unknown, expectedProof?: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const proof = url.hash.slice(1);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && decodeURIComponent(url.pathname) === '/deepcoldy/botmux'
      && isScheduledFinalDeliveryProof(proof)
      && (expectedProof === undefined || proof === expectedProof);
  } catch {
    return false;
  }
}

function footerContentWithProof(content: string, proof: string): string {
  // The historical visible-dot marker is known to survive Lark readback. Put
  // the proof in that dot's target, keeping the rendered separator unchanged.
  const carrier = `[·](${proofUrl(proof)})`;
  let replaced = false;
  let stamped = content.replace(MARKDOWN_LINK_PATTERN, (link, text, href) => {
    if ((text === '·' || text === REPLY_CARD_FOOTER_MARKER) && isProofUrl(href)) {
      if (replaced) return '';
      replaced = true;
      return carrier;
    }
    return link;
  });
  if (!replaced) {
    const separator = `·${REPLY_CARD_FOOTER_MARKER}`;
    if (stamped.includes(separator)) {
      stamped = stamped.replace(separator, `${carrier}${REPLY_CARD_FOOTER_MARKER}`);
    } else if (/<\/font>\s*$/i.test(stamped.trimEnd())) {
      stamped = stamped.trimEnd().replace(/<\/font>\s*$/i, ` ${carrier}${REPLY_CARD_FOOTER_MARKER}</font>`);
    } else {
      stamped = stamped.trimEnd();
      stamped = stamped ? `${stamped} ${carrier}${REPLY_CARD_FOOTER_MARKER}`
        : `<font color='grey'>${carrier}${REPLY_CARD_FOOTER_MARKER}</font>`;
    }
  }
  if (!stamped.includes(REPLY_CARD_FOOTER_MARKER)) {
    stamped = stamped.replace(carrier, `${carrier}${REPLY_CARD_FOOTER_MARKER}`);
  }
  return stamped;
}

/** Bind the turn-specific proof to the canonical top-level reply footer.
 *
 * Lark rewrites caller-supplied `hr.element_id` values, while preserving the
 * canonical `botmux_reply_footer` markdown component and its link target. The
 * proof therefore lives in the target fragment of a footer separator link:
 * visible answer content is unchanged, long-answer overflow already retains
 * the footer, and provider readback can validate a real component instead of
 * scanning arbitrary callback or business JSON.
 *
 * If footer chrome is disabled, append a minimal receipt-only footer. A
 * malformed caller-owned footer collision is left untouched so delivery fails
 * closed instead of creating duplicate Card 2.0 element ids. */
export function stampScheduledFinalDeliveryProof<T extends Record<string, any>>(
  card: T,
  proof: string,
): T {
  if (!isScheduledFinalDeliveryProof(proof)
      || !Array.isArray(card.body?.elements)) return card;
  const elements = card.body.elements as Array<Record<string, unknown>>;
  const reserved = findReplyCardFooterComponent(elements);
  if (reserved) {
    if (reserved.tag !== 'markdown' || typeof reserved.content !== 'string') return card;
    reserved.content = footerContentWithProof(reserved.content, proof);
    return card;
  }
  if (containsReplyCardFooterElementId(elements)) return card;
  elements.push({
    tag: 'markdown',
    element_id: REPLY_CARD_FOOTER_ELEMENT_ID,
    text_size: 'notation',
    content: footerContentWithProof('', proof),
  });
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

function footerHasExactProofLink(content: string, proof: string): boolean {
  for (const match of content.matchAll(MARKDOWN_LINK_PATTERN)) {
    if (match[1] === '·' && isProofUrl(match[2], proof)) return true;
  }
  return false;
}

/** Match only the canonical top-level footer markdown and its exact proof link.
 * Body text, nested callback values, URLs and arbitrary business objects are
 * data, not delivery-proof components. */
function hasProviderFooterProof(value: unknown, proof: string): boolean {
  const root = providerCardRoot(value);
  if (root?.schema !== '2.0') return false;
  const body = root?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const elements = (body as Record<string, unknown>).elements;
  if (countReplyCardFooterElementIds(elements) !== 1) return false;
  const footer = findReplyCardFooterComponent(elements);
  return footer?.tag === 'markdown'
    && footer.element_id === REPLY_CARD_FOOTER_ELEMENT_ID
    && typeof footer.content === 'string'
    && footerHasExactProofLink(footer.content, proof);
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
  proof: string;
}): ScheduledFinalDeliveryReadback {
  if (!isConfirmedLarkMessageId(input.messageId)) {
    return { ok: false, error: 'invalid_message_id' };
  }
  const detail = input.detail as any;
  const item = detail?.items?.[0] ?? detail?.message ?? detail;
  if (!item || typeof item !== 'object' || item.message_id !== input.messageId) {
    return { ok: false, error: 'provider_message_not_found' };
  }
  if (item.deleted !== false) return { ok: false, error: 'provider_message_deleted' };
  if (item.chat_id !== input.chatId) return { ok: false, error: 'provider_chat_mismatch' };
  if (item.msg_type !== 'interactive') {
    return { ok: false, error: 'provider_message_type_mismatch' };
  }
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
  if (!hasProviderFooterProof(card, input.proof)) {
    return { ok: false, error: 'provider_turn_proof_missing' };
  }
  const root = providerCardRoot(card);
  if (!root || canonicalReplyCardFooterPurpose(root) !== 'message') {
    return { ok: false, error: 'provider_final_not_confirmed' };
  }
  const projection = projectGroupContextCard(content, { botmuxSender: true });
  if (projection?.kind !== 'conversation') {
    return { ok: false, error: 'provider_final_not_confirmed' };
  }
  return { ok: true };
}
