import { describe, expect, it } from 'vitest';
import {
  scheduledFinalDeliveryElementId,
  stampScheduledFinalDeliveryProof,
  verifyScheduledFinalDeliveryReadback,
} from '../src/core/scheduled-final-delivery-proof.js';
import { markGroupContextCardPurpose } from '../src/im/lark/group-context-card.js';

const turnId = 'schedule:deadbeef:00000000-0000-4000-8000-000000000099';
const elementId = scheduledFinalDeliveryElementId({
  turnId,
  workerGeneration: 7,
  dispatchAttempt: 2,
})!;

describe('scheduled final delivery proof', () => {
  it('uses a provider-valid Card 2.0 element id', () => {
    expect(elementId).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    expect(elementId).toHaveLength(20);
  });

  it('reuses the existing footer separator so provider readback keeps the proof without changing visible content', () => {
    const card = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: 'exact final body' },
          { tag: 'hr' },
          { tag: 'markdown', content: 'footer', element_id: 'botmux_reply_footer' },
        ],
      },
    };

    stampScheduledFinalDeliveryProof(card, elementId);

    expect(card.body.elements).toHaveLength(3);
    expect(card.body.elements[1]).toEqual({ tag: 'hr', element_id: elementId });
    expect(card.body.elements[0]).toEqual({ tag: 'markdown', content: 'exact final body' });
    expect(card.body.elements[2]).toEqual({
      tag: 'markdown',
      content: 'footer',
      element_id: 'botmux_reply_footer',
    });
  });

  it('appends a provider-supported separator when the card has no separator', () => {
    const card = {
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    };

    stampScheduledFinalDeliveryProof(card, elementId);

    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: 'final answer' },
      { tag: 'hr', element_id: elementId },
    ]);
  });

  it('does not overwrite caller-owned ids and falls back to a provider-durable separator', () => {
    const card = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: 'custom', element_id: 'custom_content' },
          { tag: 'action', element_id: 'custom_action', actions: [] },
        ],
      },
    };

    stampScheduledFinalDeliveryProof(card, elementId);

    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: 'custom', element_id: 'custom_content' },
      { tag: 'action', element_id: 'custom_action', actions: [] },
      { tag: 'hr', element_id: elementId },
    ]);
  });

  it('accepts a provider readback that preserves the proof on the real content element', () => {
    const card = stampScheduledFinalDeliveryProof(markGroupContextCardPurpose({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'final answer' }] },
    }, 'message'), elementId);

    expect(verifyScheduledFinalDeliveryReadback({
      detail: { items: [{
        message_id: 'om_provider_receipt',
        chat_id: 'oc_exact',
        deleted: false,
        sender: { id: 'cli_exact', id_type: 'app_id', sender_type: 'app' },
        body: { content: JSON.stringify(card) },
      }] },
      messageId: 'om_provider_receipt',
      larkAppId: 'cli_exact',
      chatId: 'oc_exact',
      elementId,
    })).toEqual({ ok: true });
  });

  it('does not accept a proof string hidden in callback payload data', () => {
    const card = markGroupContextCardPurpose({
      schema: '2.0',
      body: {
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'Run' },
          behaviors: [{ type: 'callback', value: { element_id: elementId } }],
        }],
      },
    }, 'message');

    expect(verifyScheduledFinalDeliveryReadback({
      detail: { items: [{
        message_id: 'om_callback_forgery',
        chat_id: 'oc_exact',
        deleted: false,
        sender: { id: 'cli_exact', id_type: 'app_id', sender_type: 'app' },
        body: { content: JSON.stringify(card) },
      }] },
      messageId: 'om_callback_forgery',
      larkAppId: 'cli_exact',
      chatId: 'oc_exact',
      elementId,
    })).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });

  it('does not accept an arbitrary top-level business object carrying the proof id', () => {
    const card = markGroupContextCardPurpose({
      schema: '2.0',
      body: {
        elements: [{
          kind: 'business_metadata',
          element_id: elementId,
          payload: { source: 'model' },
        }],
      },
    }, 'message');

    expect(verifyScheduledFinalDeliveryReadback({
      detail: { items: [{
        message_id: 'om_business_forgery',
        chat_id: 'oc_exact',
        deleted: false,
        sender: { id: 'cli_exact', id_type: 'app_id', sender_type: 'app' },
        body: { content: JSON.stringify(card) },
      }] },
      messageId: 'om_business_forgery',
      larkAppId: 'cli_exact',
      chatId: 'oc_exact',
      elementId,
    })).toEqual({ ok: false, error: 'provider_turn_proof_missing' });
  });
});
