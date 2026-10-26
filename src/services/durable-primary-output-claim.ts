import type { DaemonSession } from '../core/types.js';
import { parseScheduledTurnId } from '../core/scheduled-turn-provenance.js';
import type { ScheduleAuthorityRecord } from './schedule-authority-store.js';
import { effectiveScheduleChatIds } from './schedule-store.js';
import type { DurableSessionRecord } from './durable-coordination.js';
import type { DurableLarkMessageClaim } from './durable-inbox-shadow.js';
import {
  parseDurablePrimarySessionRecord,
  type DurablePrimarySessionAdmission,
} from './durable-session-primary.js';

function claimFromAdmission(
  admission: DurablePrimarySessionAdmission,
): DurableLarkMessageClaim {
  return {
    eventType: admission.eventId.startsWith('im.message.updated_v1:')
      ? 'lark.im.message.updated_v1'
      : 'lark.im.message.receive_v1',
    eventId: admission.eventId,
    partitionKey: admission.partitionKey,
    larkAppId: admission.larkAppId,
    messageId: admission.messageId,
    attempts: 1,
    data: {},
  };
}

function completedOneShot(authority: ScheduleAuthorityRecord): boolean {
  return authority.state === 'completed'
    && authority.task.parsed?.kind === 'once'
    && authority.task.disabledReason === 'once_completed';
}

/**
 * Resolve the exact durable input identity used by the primary output
 * transaction. Ordinary IM turns must already have an admission. Scheduled
 * turns have no Lark inbox event, so the daemon may mint a host-only synthetic
 * claim after proving the live managed turn and its immutable authority row.
 *
 * The synthetic claim intentionally keeps the existing Lark routing envelope:
 * durable output is still delivered to a Lark Session/outbox, while its
 * messageId is the unforgeable `schedule:<taskId>:<uuid>` turn identity. It can
 * never collide with a real `om_` callback message.
 */
export function resolveDurablePrimaryOutputClaim(input: {
  current: DurableSessionRecord | undefined;
  turnId: string;
  daemonSession: Pick<DaemonSession, 'larkAppId' | 'chatId' | 'managedTurnOrigin' | 'session'>;
  authority?: ScheduleAuthorityRecord;
}): DurableLarkMessageClaim {
  const taskId = parseScheduledTurnId(input.turnId);
  if (input.current) {
    const parsed = parseDurablePrimarySessionRecord(input.current);
    if (parsed.session.sessionId !== input.daemonSession.session.sessionId) {
      if (!taskId
          || parsed.session.status !== 'closed'
          || !input.authority
          || input.authority.task.id !== taskId
          || input.authority.task.boundSessionId !== undefined) {
        throw new Error('durable primary Session snapshot belongs to another logical Session');
      }
    } else {
      const exact = parsed.admissions.find(entry => entry.messageId === input.turnId);
      if (exact) return claimFromAdmission(exact);
    }
  }

  if (!taskId) {
    if (!input.current) throw new Error('durable primary Session snapshot is unavailable');
    throw new Error(
      `durable primary Session snapshot is not committed for turn ${input.turnId}`,
    );
  }

  const authority = input.authority;
  const task = authority?.task;
  if (!authority || !task || task.id !== taskId
      || (authority.state !== 'active' && !completedOneShot(authority))
      || input.daemonSession.managedTurnOrigin?.turnId !== input.turnId
      || (task.larkAppId !== undefined && task.larkAppId !== input.daemonSession.larkAppId)
      || !effectiveScheduleChatIds(task).includes(input.daemonSession.chatId)) {
    throw new Error(
      `durable scheduled output authority is not committed for turn ${input.turnId}`,
    );
  }

  const larkAppId = input.daemonSession.larkAppId;
  return {
    eventType: 'lark.im.message.receive_v1',
    eventId: `im.message.receive_v1:${larkAppId}:${input.turnId}`,
    partitionKey: `lark-message-routing:${larkAppId}:${input.daemonSession.chatId}`,
    larkAppId,
    messageId: input.turnId,
    attempts: 1,
    data: {},
  };
}
