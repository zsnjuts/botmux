import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { ScheduleAuthorityRecord } from '../src/services/schedule-authority-store.js';
import type { DurableSessionRecord } from '../src/services/durable-coordination.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import { resolveDurablePrimaryOutputClaim } from '../src/services/durable-primary-output-claim.js';
import {
  durablePrimarySessionProjection,
  parseDurablePrimarySessionRecord,
} from '../src/services/durable-session-primary.js';
import type { ScheduledTask, Session } from '../src/types.js';

const scheduledTurn = 'schedule:a1b2c3d4:00000000-0000-4000-8000-000000000000';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    chatId: 'oc_chat',
    chatType: 'group',
    rootMessageId: 'om_root',
    scope: 'thread',
    title: 'scheduled output',
    status: 'active',
    createdAt: '2026-10-24T00:00:00.000Z',
    lastMessageAt: '2026-10-24T00:01:00.000Z',
    larkAppId: 'cli_test',
    ...overrides,
  };
}

function message(messageId = 'om_input'): DurableLarkMessageClaim {
  return {
    eventType: 'lark.im.message.receive_v1',
    eventId: `im.message.receive_v1:cli_test:${messageId}`,
    partitionKey: 'lark-message-routing:cli_test:oc_chat',
    larkAppId: 'cli_test',
    messageId,
    attempts: 1,
    data: {},
  };
}

function current(
  messageId = 'om_input',
  sessionOverrides: Partial<Session> = {},
): DurableSessionRecord {
  const projection = durablePrimarySessionProjection(
    session(sessionOverrides),
    message(messageId),
  );
  return {
    sessionKey: projection.sessionKey,
    revision: 1,
    value: projection.value,
    updatedAt: 1,
  };
}

function daemonSession(turnId = scheduledTurn): Pick<
  DaemonSession,
  'larkAppId' | 'chatId' | 'managedTurnOrigin' | 'session'
> {
  return {
    larkAppId: 'cli_test',
    chatId: 'oc_chat',
    session: session(),
    managedTurnOrigin: {
      turnId,
      capability: 'capability',
      preexistingProcessIdentities: [],
    },
  };
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'a1b2c3d4',
    name: 'scheduled output',
    schedule: '2m',
    parsed: { kind: 'once', runAt: '2026-10-24T00:02:00.000Z', display: 'once in 2m' },
    prompt: 'send final',
    workingDir: '/repo',
    chatId: 'oc_chat',
    larkAppId: 'cli_test',
    enabled: true,
    createdAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

function authority(overrides: Partial<ScheduleAuthorityRecord> = {}): ScheduleAuthorityRecord {
  return {
    kind: 'direct',
    state: 'active',
    task: task(),
    runScopes: [],
    selfManage: false,
    ...overrides,
  };
}

describe('durable primary scheduled output claim', () => {
  it('keeps an exact committed IM admission authoritative', () => {
    expect(resolveDurablePrimaryOutputClaim({
      current: current('om_input'),
      turnId: 'om_input',
      daemonSession: daemonSession('om_input'),
    })).toMatchObject({
      eventId: 'im.message.receive_v1:cli_test:om_input',
      messageId: 'om_input',
    });
  });

  it('mints an exact host-only scheduled claim for an existing Session', () => {
    expect(resolveDurablePrimaryOutputClaim({
      current: current(),
      turnId: scheduledTurn,
      daemonSession: daemonSession(),
      authority: authority({
        state: 'completed',
        task: task({ enabled: false, disabledReason: 'once_completed' }),
      }),
    })).toEqual({
      eventType: 'lark.im.message.receive_v1',
      eventId: `im.message.receive_v1:cli_test:${scheduledTurn}`,
      partitionKey: 'lark-message-routing:cli_test:oc_chat',
      larkAppId: 'cli_test',
      messageId: scheduledTurn,
      attempts: 1,
      data: {},
    });
  });

  it('can initialize a fresh scheduled Session with no prior IM snapshot', () => {
    const claim = resolveDurablePrimaryOutputClaim({
      current: undefined,
      turnId: scheduledTurn,
      daemonSession: daemonSession(),
      authority: authority(),
    });
    const projection = durablePrimarySessionProjection(session(), claim);
    expect(parseDurablePrimarySessionRecord({
      sessionKey: projection.sessionKey,
      revision: 1,
      value: projection.value,
      updatedAt: 1,
    })).toMatchObject({
      admission: {
        eventId: `im.message.receive_v1:cli_test:${scheduledTurn}`,
        messageId: scheduledTurn,
      },
    });
  });

  it('replaces a closed prior logical Session for unbound scheduled output', () => {
    expect(resolveDurablePrimaryOutputClaim({
      current: current('om_input', {
        sessionId: 'closed-session',
        status: 'closed',
      }),
      turnId: scheduledTurn,
      daemonSession: daemonSession(),
      authority: authority({
        state: 'completed',
        task: task({ enabled: false, disabledReason: 'once_completed' }),
      }),
    })).toMatchObject({
      eventId: `im.message.receive_v1:cli_test:${scheduledTurn}`,
      messageId: scheduledTurn,
    });
  });

  it('rejects replacing an active prior logical Session', () => {
    expect(() => resolveDurablePrimaryOutputClaim({
      current: current('om_input', { sessionId: 'active-session' }),
      turnId: scheduledTurn,
      daemonSession: daemonSession(),
      authority: authority(),
    })).toThrow('durable primary Session snapshot belongs to another logical Session');
  });

  it('rejects replacing the Session bound to a scheduled task', () => {
    expect(() => resolveDurablePrimaryOutputClaim({
      current: current('om_input', {
        sessionId: 'bound-session',
        status: 'closed',
      }),
      turnId: scheduledTurn,
      daemonSession: daemonSession(),
      authority: authority({
        task: task({ boundSessionId: 'bound-session' }),
      }),
    })).toThrow('durable primary Session snapshot belongs to another logical Session');
  });

  it.each([
    ['changed managed turn', { managedTurnOrigin: { turnId: 'om_other', capability: 'cap', preexistingProcessIdentities: [] } }, authority()],
    ['paused authority', {}, authority({ state: 'paused' })],
    ['wrong app', {}, authority({ task: task({ larkAppId: 'cli_other' }) })],
    ['wrong chat', {}, authority({ task: task({ chatId: 'oc_other' }) })],
  ])('rejects scheduled fallback with %s', (_label, sessionPatch, record) => {
    expect(() => resolveDurablePrimaryOutputClaim({
      current: current(),
      turnId: scheduledTurn,
      daemonSession: { ...daemonSession(), ...sessionPatch },
      authority: record,
    })).toThrow(/durable scheduled output authority is not committed/);
  });

  it('keeps an uncommitted ordinary turn fail-closed', () => {
    expect(() => resolveDurablePrimaryOutputClaim({
      current: current(),
      turnId: 'om_other',
      daemonSession: daemonSession('om_other'),
    })).toThrow('durable primary Session snapshot is not committed for turn om_other');
  });
});
