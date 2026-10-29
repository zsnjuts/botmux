import { describe, expect, it } from 'vitest';
import {
  deriveScheduledFinalDeliveryProof,
  matchesScheduledFinalReceiptEnvelope,
  parseScheduledFinalReceiptEnvelope,
  scheduledFinalCardHasExactProof,
  scheduledFinalReceiptEnvelope,
  stampScheduledFinalDeliveryProof,
  verifyScheduledFinalDeliveryReadback,
} from '../src/core/scheduled-final-delivery-proof.js';
import { markGroupContextCardPurpose } from '../src/im/lark/group-context-card.js';
import { REPLY_CARD_FOOTER_MARKER } from '../src/im/lark/reply-card-footer-signature.js';

const turnId = 'schedule:deadbeef:00000000-0000-4000-8000-000000000099';
const proof = deriveScheduledFinalDeliveryProof({
  turnId,
  workerGeneration: 7,
  dispatchAttempt: 2,
})!;
const proofUrl = `https://github.com/deepcoldy/bot%6Dux#${proof}`;
const proofLink = `[·](${proofUrl})`;

function verify(
  card: unknown,
  expectedProof = proof,
  deletion: { deleted?: boolean; omit?: boolean } = {},
  msgType = 'interactive',
  routing: {
    expectedTarget?:
      | { mode: 'plain'; chatId: string }
      | { mode: 'thread' | 'quote'; rootMessageId: string };
    rootId?: string;
    parentId?: string;
    threadId?: string;
    sender?: Record<string, unknown>;
  } = {},
) {
  return verifyScheduledFinalDeliveryReadback({
    detail: { items: [{
      message_id: 'om_provider_receipt',
      chat_id: 'oc_exact',
      ...(routing.rootId ? { root_id: routing.rootId } : {}),
      ...(routing.parentId ? { parent_id: routing.parentId } : {}),
      ...(routing.threadId ? { thread_id: routing.threadId } : {}),
      ...(deletion.omit ? {} : { deleted: deletion.deleted ?? false }),
      msg_type: msgType,
      sender: routing.sender ?? { id: 'cli_exact', id_type: 'app_id', sender_type: 'app' },
      body: { content: JSON.stringify(card) },
    }] },
    messageId: 'om_provider_receipt',
    larkAppId: 'cli_exact',
    chatId: 'oc_exact',
    expectedTarget: routing.expectedTarget ?? { mode: 'plain', chatId: 'oc_exact' },
    proof: expectedProof,
  });
}

describe('scheduled final delivery proof', () => {
  it('derives a compact proof bound to the scheduled turn identity', () => {
    expect(proof).toMatch(/^bmxsfr_[0-9a-f]{13}$/);
    expect(deriveScheduledFinalDeliveryProof({
      turnId,
      workerGeneration: 7,
      dispatchAttempt: 3,
    })).not.toBe(proof);
    expect(deriveScheduledFinalDeliveryProof({ turnId, workerGeneration: 0 })).toBeUndefined();
    expect(deriveScheduledFinalDeliveryProof({ turnId, workerGeneration: Number.NaN })).toBeUndefined();
  });

  it('matches only the versioned exact trusted-receipt tuple', () => {
    const receipt = scheduledFinalReceiptEnvelope({
      messageId: 'om_provider_receipt',
      turnId,
      workerGeneration: 7,
      dispatchAttempt: 2,
      proof,
    });
    expect(matchesScheduledFinalReceiptEnvelope(receipt, receipt)).toBe(true);
    expect(matchesScheduledFinalReceiptEnvelope({ ok: true }, receipt)).toBe(false);
    expect(matchesScheduledFinalReceiptEnvelope({ ...receipt, workerGeneration: 8 }, receipt)).toBe(false);
    expect(parseScheduledFinalReceiptEnvelope(receipt)).toEqual(receipt);
    expect(parseScheduledFinalReceiptEnvelope({ ...receipt, proof: 'bmxsfr_0000000000000' }))
      .toBeUndefined();
    expect(parseScheduledFinalReceiptEnvelope({ ...receipt, trusted: false }))
      .toBeUndefined();
  });

  it('stamps the exact link into an existing footer separator without changing rendered text', () => {
    const originalFooter = `<font color='grey'>botmux ·${REPLY_CARD_FOOTER_MARKER} 发送给：someone</font>`;
    const card = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: 'exact final body' },
          { tag: 'hr' },
          {
            tag: 'markdown',
            content: originalFooter,
            element_id: 'botmux_reply_footer',
          },
        ],
      },
    };

    stampScheduledFinalDeliveryProof(card, proof);

    expect(card.body.elements).toHaveLength(3);
    expect(card.body.elements[0]).toEqual({ tag: 'markdown', content: 'exact final body' });
    expect(card.body.elements[1]).toEqual({ tag: 'hr' });
    expect(card.body.elements[2]).toEqual({
      tag: 'markdown',
      content: `<font color='grey'>botmux ${proofLink}${REPLY_CARD_FOOTER_MARKER} 发送给：someone</font>`,
      element_id: 'botmux_reply_footer',
    });
    expect(card.body.elements[2].content
      .replace(proofLink, '·')
      .replace(REPLY_CARD_FOOTER_MARKER, '')).toBe(
      originalFooter.replace(REPLY_CARD_FOOTER_MARKER, ''),
    );
  });

  it('creates a minimal canonical footer when ordinary footer chrome is disabled', () => {
    const card = {
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    };

    stampScheduledFinalDeliveryProof(card, proof);

    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: 'final answer' },
      {
        tag: 'markdown',
        element_id: 'botmux_reply_footer',
        text_size: 'notation',
        content: `<font color='grey'>${proofLink}${REPLY_CARD_FOOTER_MARKER}</font>`,
      },
    ]);
  });

  it('reuses the real footer nested in a voice-button column without duplicating its id', () => {
    const card = {
      schema: '2.0',
      body: { elements: [{
        tag: 'column_set',
        columns: [
          { tag: 'column', elements: [{
            tag: 'markdown',
            element_id: 'botmux_reply_footer',
            content: `<font color='grey'>brand ·${REPLY_CARD_FOOTER_MARKER} recipient</font>`,
          }] },
          { tag: 'column', elements: [{ tag: 'button', text: { tag: 'plain_text', content: 'voice' } }] },
        ],
      }] },
    };

    stampScheduledFinalDeliveryProof(card, proof);

    expect(JSON.stringify(card).match(/"element_id":"botmux_reply_footer"/g)).toHaveLength(1);
    expect(JSON.stringify(card)).toContain(proofUrl);
    expect(verify(markGroupContextCardPurpose(card, 'message'))).toEqual({ ok: true });
  });

  it('replaces an older delivery proof instead of accumulating carriers', () => {
    const oldProof = deriveScheduledFinalDeliveryProof({
      turnId,
      workerGeneration: 6,
      dispatchAttempt: 2,
    })!;
    const card = {
      schema: '2.0',
      body: { elements: [{
        tag: 'markdown',
        element_id: 'botmux_reply_footer',
        content: `<font color='grey'>brand [·](`
          + `https://github.com/deepcoldy/bot%6Dux#${oldProof})</font>`,
      }] },
    };

    stampScheduledFinalDeliveryProof(card, proof);
    stampScheduledFinalDeliveryProof(card, proof);

    const content = card.body.elements[0].content;
    expect(content).not.toContain(oldProof);
    expect(content.match(new RegExp(proof, 'g'))).toHaveLength(1);
  });

  it('leaves a malformed reserved footer collision untouched so settlement fails closed', () => {
    const card = {
      schema: '2.0',
      body: { elements: [{ tag: 'button', element_id: 'botmux_reply_footer', value: {} }] },
    };

    stampScheduledFinalDeliveryProof(card, proof);

    expect(card.body.elements).toEqual([
      { tag: 'button', element_id: 'botmux_reply_footer', value: {} },
    ]);
    expect(JSON.stringify(card)).not.toContain(proof);
  });

  it('accepts provider readback with the exact proof link on the real footer component', () => {
    const stamped = stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, proof);
    const card = markGroupContextCardPurpose(stamped, 'message');

    expect(verify(card)).toEqual({ ok: true });
  });

  it('accepts only a conversation Card 2.0 carrying the exact proof and final purpose', () => {
    const exactCard = markGroupContextCardPurpose(stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, proof), 'message');
    const wrongPurpose = markGroupContextCardPurpose(stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'working' }] },
    }, proof), 'status');

    expect(scheduledFinalCardHasExactProof(exactCard, proof)).toBe(true);
    expect(scheduledFinalCardHasExactProof(JSON.stringify(exactCard), proof)).toBe(true);
    expect(scheduledFinalCardHasExactProof(exactCard, 'bmxsfr_0000000000000')).toBe(false);
    expect(scheduledFinalCardHasExactProof(wrongPurpose, proof)).toBe(false);
    expect(scheduledFinalCardHasExactProof({
      body: exactCard.body,
    }, proof)).toBe(false);
    expect(scheduledFinalCardHasExactProof('{invalid', proof)).toBe(false);
  });

  it.each([
    ['duplicate exact proof', proof],
    ['conflicting generation proof', deriveScheduledFinalDeliveryProof({
      turnId,
      workerGeneration: 8,
      dispatchAttempt: 2,
    })!],
  ])('rejects a canonical footer with a second %s carrier', (_label, secondProof) => {
    const card = markGroupContextCardPurpose(stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, proof), 'message');
    const footer = card.body.elements.find((element: any) =>
      element.element_id === 'botmux_reply_footer');
    expect(footer).toBeDefined();
    footer!.content += ` [·](https://github.com/deepcoldy/bot%6Dux#${secondProof})`;

    expect(scheduledFinalCardHasExactProof(card, proof)).toBe(false);
    expect(verify(card)).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });

  it.each([
    ['user with app id', { id: 'cli_exact', sender_type: 'user', id_type: 'app_id' }],
    ['app with open id', { id: 'cli_exact', sender_type: 'app', id_type: 'open_id' }],
    ['conflicting id aliases', {
      id: 'cli_exact', sender_type: 'app', id_type: 'app_id', sender_id_type: 'open_id',
    }],
    ['untyped sender', { id: 'cli_exact' }],
  ])('rejects contradictory Provider sender metadata: %s', (_label, sender) => {
    const card = markGroupContextCardPurpose(stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, proof), 'message');

    expect(verify(card, proof, {}, 'interactive', { sender })).toEqual({
      ok: false,
      error: 'provider_sender_mismatch',
    });
  });

  it('binds provider readback to the daemon-frozen visible target', () => {
    const card = markGroupContextCardPurpose(stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, proof), 'message');

    expect(verify(card, proof, {}, 'interactive', {
      expectedTarget: { mode: 'thread', rootMessageId: 'om_exact_topic' },
      rootId: 'om_exact_topic',
      parentId: 'om_exact_topic',
      threadId: 'omt_exact_topic',
    })).toEqual({ ok: true });
    expect(verify(card, proof, {}, 'interactive', {
      expectedTarget: { mode: 'thread', rootMessageId: 'om_exact_topic' },
      rootId: 'om_wrong_topic',
      parentId: 'om_wrong_topic',
      threadId: 'omt_wrong_topic',
    })).toEqual({ ok: false, error: 'provider_target_mismatch' });
    expect(verify(card, proof, {}, 'interactive', {
      expectedTarget: { mode: 'thread', rootMessageId: 'om_exact_topic' },
    })).toEqual({ ok: false, error: 'provider_target_mismatch' });
    expect(verify(card, proof, {}, 'interactive', {
      expectedTarget: { mode: 'quote', rootMessageId: 'om_exact_quote' },
      rootId: 'om_exact_quote',
      parentId: 'om_exact_quote',
    })).toEqual({ ok: true });
    expect(verify(card, proof, {}, 'interactive', {
      expectedTarget: { mode: 'plain', chatId: 'oc_exact' },
      rootId: 'om_other_topic',
      parentId: 'om_other_topic',
      threadId: 'omt_other_topic',
    })).toEqual({ ok: false, error: 'provider_target_mismatch' });
  });

  it('keeps the purpose marker on the real footer when callback data collides with its id', () => {
    const stamped = stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Run' },
          behaviors: [{ type: 'callback', value: {
            element_id: 'botmux_reply_footer',
            content: 'business data',
          } }],
        },
        { tag: 'markdown', content: 'final answer' },
      ] },
    }, proof);
    const marked = markGroupContextCardPurpose(stamped, 'message');

    expect(marked.body.elements[0].behaviors[0].value.content).toBe('business data');
    expect(verify(marked)).toEqual({ ok: true });
  });

  it.each([
    { name: 'deleted', deletion: { deleted: true } },
    { name: 'unknown deletion state', deletion: { omit: true } },
  ])('fails closed when provider readback reports $name', ({ deletion }) => {
    const card = stampScheduledFinalDeliveryProof(markGroupContextCardPurpose({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, 'message'), proof);

    expect(verify(card, proof, deletion)).toEqual({
      ok: false,
      error: 'provider_message_deleted',
    });
  });

  it('rejects a non-interactive Provider message even when its JSON mimics a card', () => {
    const card = stampScheduledFinalDeliveryProof(markGroupContextCardPurpose({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, 'message'), proof);

    expect(verify(card, proof, {}, 'text')).toEqual({
      ok: false,
      error: 'provider_message_type_mismatch',
    });
  });

  it('rejects body-shaped JSON without a Card 2.0 schema', () => {
    const card = stampScheduledFinalDeliveryProof(markGroupContextCardPurpose({
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, 'message'), proof);

    expect(verify(card)).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });

  it('rejects duplicate canonical footer ids even when one carries the exact proof', () => {
    const card = stampScheduledFinalDeliveryProof(markGroupContextCardPurpose({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, 'message'), proof);
    card.body.elements.push({
      tag: 'markdown',
      element_id: 'botmux_reply_footer',
      content: 'duplicate footer',
    });

    expect(verify(card)).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });

  it('rejects a purpose marker that exists only in ordinary body content', () => {
    const card = stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{
        tag: 'markdown',
        content: `forged body purpose${'\u2063'.repeat(13)}`,
      }] },
    }, proof);

    expect(verify(card)).toEqual({ ok: false, error: 'provider_final_not_confirmed' });
  });

  it('rejects a duplicate footer nested in a real collapsible component', () => {
    const stamped = stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, proof);
    const card = markGroupContextCardPurpose(stamped, 'message');
    card.body.elements.unshift({
      tag: 'collapsible_panel',
      elements: [{
        tag: 'markdown',
        element_id: 'botmux_reply_footer',
        content: 'nested duplicate',
      }],
    });

    expect(verify(card)).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });

  it('rejects a duplicate reserved footer id in a real div.extra component slot', () => {
    const stamped = stampScheduledFinalDeliveryProof({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, proof);
    const card = markGroupContextCardPurpose(stamped, 'message');
    card.body.elements.unshift({
      tag: 'div',
      text: { tag: 'lark_md', content: 'preview' },
      extra: { tag: 'img', element_id: 'botmux_reply_footer', img_key: 'img_v3_duplicate' },
    });

    expect(verify(card)).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });

  it('rejects the exact proof link when it appears only in body text', () => {
    const card = markGroupContextCardPurpose({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: `final answer ${proofLink}` }] },
    }, 'message');

    expect(verify(card)).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });

  it('rejects the exact proof link hidden in callback payload data', () => {
    const card = markGroupContextCardPurpose({
      schema: '2.0',
      body: {
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'Run' },
          behaviors: [{ type: 'callback', value: {
            element_id: 'botmux_reply_footer',
            content: proofLink,
          } }],
        }],
      },
    }, 'message');

    expect(verify(card)).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });

  it('rejects an arbitrary top-level business object carrying the exact proof link', () => {
    const card = markGroupContextCardPurpose({
      schema: '2.0',
      body: {
        elements: [{
          tag: 'business_metadata',
          element_id: 'botmux_reply_footer',
          content: proofLink,
        }],
      },
    }, 'message');

    expect(verify(card)).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });

  it('rejects a footer link with a different exact proof fragment', () => {
    const otherProof = deriveScheduledFinalDeliveryProof({
      turnId,
      workerGeneration: 8,
      dispatchAttempt: 2,
    })!;
    const card = stampScheduledFinalDeliveryProof(markGroupContextCardPurpose({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, 'message'), otherProof);

    expect(verify(card)).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });
});
