import { describe, expect, it } from 'vitest';
import { DURABLE_INBOX_LANE_SESSION_CONTROL, type InboxClaim } from '../src/services/durable-coordination.js';
import { normalizeCardActionData } from '../src/im/lark/card-action-data.js';
import {
  durableDirectSessionControlEvent,
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
  durableRemoteOrphanControlPartition,
  parseDurableLarkSessionControlClaim,
  parseDurableSessionControlClaim,
} from '../src/services/durable-lark-session-control.js';

function rawControl(action: 'close' | 'resume' | 'restart' = 'close') {
  return {
    event_id: 'evt_control_1',
    action: {
      value: {
        action,
        session_id: 'session-1',
        root_id: 'om_root',
      },
    },
    operator: { open_id: 'ou_operator' },
    context: { open_message_id: 'om_card' },
  };
}

function displayControl(target: 'hidden' | 'screenshot' = 'screenshot') {
  return {
    ...rawControl('close'),
    action: {
      value: {
        action: 'toggle_display',
        target_display_mode: target,
        session_id: 'session-1',
        root_id: 'om_root',
      },
    },
  };
}

function claim(event = durableLarkSessionControlEvent({
  larkAppId: 'cli_test',
  eventId: durableLarkSessionControlEventId('cli_test', 'evt_control_1'),
  partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
  data: rawControl(),
  now: 10,
})): InboxClaim {
  return {
    event,
    workerId: 'control-worker',
    claimEpoch: 1,
    claimUntil: 100,
    attempts: 2,
  };
}

describe('durable Lark session control envelope', () => {
  it('pins one stable card interaction to the session-control lane and partition', () => {
    const parsed = parseDurableLarkSessionControlClaim(claim());
    expect(parsed).toMatchObject({
      operationId: 'card.action.trigger:cli_test:evt_control_1',
      partitionKey: 'lark-session-control:cli_test:session-1',
      larkAppId: 'cli_test',
      action: 'close',
      sessionId: 'session-1',
      rootId: 'om_root',
      operatorOpenId: 'ou_operator',
      cardMessageId: 'om_card',
      attempts: 2,
    });
  });

  it.each(['lark-command', 'trusted-host'] as const)(
    'parses a %s lifecycle request without weakening the card envelope',
    source => {
      const event = durableDirectSessionControlEvent({
        source,
        larkAppId: 'cli_test',
        operationId: `${source}.session-control:cli_test:om_command`,
        action: 'close',
        sessionId: 'session-1',
        rootId: 'om_root',
        ...(source === 'lark-command' ? { operatorOpenId: 'ou_operator' } : {}),
        cardMessageId: 'om_card',
        now: 10,
      });
      expect(parseDurableSessionControlClaim(claim(event))).toMatchObject({
        source,
        operationId: `${source}.session-control:cli_test:om_command`,
        partitionKey: 'lark-session-control:cli_test:session-1',
        action: 'close',
        sessionId: 'session-1',
        rootId: 'om_root',
        operatorOpenId: source === 'trusted-host' ? 'trusted-host' : 'ou_operator',
        cardMessageId: 'om_card',
      });
      expect(() => parseDurableLarkSessionControlClaim(claim(event)))
        .toThrow(/invalid envelope/);
    },
  );

  it('accepts handoff only from a trusted host with the retiring owner identity', () => {
    const event = durableDirectSessionControlEvent({
      source: 'trusted-host',
      larkAppId: 'cli_test',
      operationId: 'trusted-host.session-control:cli_test:session-1:owner-1:handoff',
      action: 'handoff',
      sessionId: 'session-1',
      rootId: 'om_root',
      cardMessageId: 'om_card',
      retiringOwnerId: 'owner-1',
      now: 10,
    });
    expect(parseDurableSessionControlClaim(claim(event))).toMatchObject({
      source: 'trusted-host',
      action: 'handoff',
      retiringOwnerId: 'owner-1',
    });
    expect(() => durableDirectSessionControlEvent({
      source: 'trusted-host',
      larkAppId: 'cli_test',
      operationId: 'trusted-host.session-control:cli_test:session-1:owner-1:missing',
      action: 'handoff',
      sessionId: 'session-1',
      rootId: 'om_root',
      now: 10,
    })).toThrow(/retiringOwnerId/);
    expect(() => durableDirectSessionControlEvent({
      source: 'lark-command',
      larkAppId: 'cli_test',
      operationId: 'lark-command.session-control:cli_test:session-1:handoff',
      action: 'handoff',
      sessionId: 'session-1',
      rootId: 'om_root',
      operatorOpenId: 'ou_operator',
      retiringOwnerId: 'owner-1',
      now: 10,
    })).toThrow(/trusted host source/);
  });

  it('isolates background orphan controls from the explicit lifecycle FIFO partition', () => {
    const event = durableDirectSessionControlEvent({
      source: 'trusted-host',
      larkAppId: 'cli_test',
      operationId: 'trusted-host.remote-orphan:cli_test:session-1:2',
      action: 'terminalize_orphan',
      sessionId: 'session-1',
      rootId: 'om_root',
      cardMessageId: 'om_card',
      now: 10,
    });
    expect(event.partitionKey).toBe(
      durableRemoteOrphanControlPartition('cli_test', 'session-1'),
    );
    expect(parseDurableSessionControlClaim(claim(event))).toMatchObject({
      source: 'trusted-host',
      action: 'terminalize_orphan',
      partitionKey: 'lark-session-control:cli_test:orphan:session-1',
      sessionId: 'session-1',
    });
  });

  it('rejects a command control without a Lark user principal', () => {
    expect(() => durableDirectSessionControlEvent({
      source: 'lark-command',
      larkAppId: 'cli_test',
      operationId: 'lark-command.session-control:cli_test:om_command',
      action: 'close',
      sessionId: 'session-1',
      rootId: 'om_root',
      operatorOpenId: 'trusted-host',
      now: 10,
    })).toThrow(/operator identity/);
  });

  it('rejects lifecycle actions that are not in the first durable close/resume slice', () => {
    expect(() => durableLarkSessionControlEvent({
      larkAppId: 'cli_test',
      eventId: durableLarkSessionControlEventId('cli_test', 'evt_control_1'),
      partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
      data: rawControl('restart'),
      now: 10,
    })).toThrow(/unsupported/);
  });

  it('accepts an idempotent display target and rejects legacy blind toggles', () => {
    const event = durableLarkSessionControlEvent({
      larkAppId: 'cli_test',
      eventId: durableLarkSessionControlEventId('cli_test', 'evt_display_1'),
      partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
      data: { ...displayControl(), event_id: 'evt_display_1' },
      now: 10,
    });
    expect(parseDurableLarkSessionControlClaim(claim(event))).toMatchObject({
      action: 'toggle_display',
      sessionId: 'session-1',
    });
    expect(() => durableLarkSessionControlEvent({
      larkAppId: 'cli_test',
      eventId: durableLarkSessionControlEventId('cli_test', 'evt_display_legacy'),
      partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
      data: {
        ...displayControl(),
        event_id: 'evt_display_legacy',
        action: { value: { action: 'toggle_display', session_id: 'session-1', root_id: 'om_root' } },
      },
      now: 10,
    })).toThrow(/idempotent target mode/);
  });

  it('rejects missing stable interaction ids and mismatched durable identities', () => {
    expect(() => durableLarkSessionControlEvent({
      larkAppId: 'cli_test',
      eventId: 'card.action.trigger:cli_test:evt_control_1',
      partitionKey: 'lark-session-control:cli_test:session-1',
      data: { ...rawControl(), event_id: undefined },
      now: 10,
    })).toThrow(/event id/);

    const event = durableLarkSessionControlEvent({
      larkAppId: 'cli_test',
      eventId: durableLarkSessionControlEventId('cli_test', 'evt_control_1'),
      partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
      data: rawControl(),
      now: 10,
    });
    expect(() => parseDurableLarkSessionControlClaim(claim({
      ...event,
      eventId: 'card.action.trigger:cli_test:evt_other',
    }))).toThrow(/mismatched identity/);
    expect(() => parseDurableLarkSessionControlClaim(claim({
      ...event,
      lane: 'lark-message',
    }))).toThrow(/invalid envelope/);
    expect(event.lane).toBe(DURABLE_INBOX_LANE_SESSION_CONTROL);
  });

  it.each([
    [{ operator: { open_id: 'on_operator' } }, /principal\/card identity/],
    [{ context: { open_message_id: 'oc_card' } }, /principal\/card identity/],
    [{ action: { value: { action: 'close', session_id: 'session-1', root_id: 'ou_root' } } }, /root identity/],
  ])('rejects invalid operator/card/root identity prefixes', (patch, error) => {
    expect(() => durableLarkSessionControlEvent({
      larkAppId: 'cli_test',
      eventId: durableLarkSessionControlEventId('cli_test', 'evt_control_1'),
      partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
      data: { ...rawControl(), ...patch },
      now: 10,
    })).toThrow(error);
  });

  it.each(['object', 'string', 'behaviors', 'envelope', 'envelope-behaviors'] as const)(
    'accepts normalized %s card callbacks through the strict ingress validation',
    shape => {
      const value = { action: 'close' as const, session_id: 'session-1', root_id: 'om_root' };
      const wrapped = shape === 'envelope' || shape === 'envelope-behaviors';
      const innerShape = shape === 'envelope' ? 'string' : shape;
      const inner = {
        action: innerShape === 'behaviors' || innerShape === 'envelope-behaviors'
          ? { behaviors: [{ type: 'callback', value }] }
          : { value: innerShape === 'object' ? value : JSON.stringify(value) },
        operator: { open_id: 'ou_operator' },
        context: { open_message_id: 'om_card' },
      };
      const payload = wrapped
        ? normalizeCardActionData({ header: { event_id: 'evt_control_1' }, event: inner })
        : normalizeCardActionData({ event_id: 'evt_control_1', ...inner });
      const event = durableLarkSessionControlEvent({
        larkAppId: 'cli_test',
        eventId: durableLarkSessionControlEventId('cli_test', 'evt_control_1'),
        partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
        data: payload,
        now: 10,
      });
      const parsed = parseDurableLarkSessionControlClaim(claim(event));
      expect(parsed.action).toBe('close');
      expect(parsed.sessionId).toBe('session-1');
      expect(parsed.rootId).toBe('om_root');
      expect(parsed.operatorOpenId).toBe('ou_operator');
      expect(parsed.cardMessageId).toBe('om_card');
    },
  );
});
