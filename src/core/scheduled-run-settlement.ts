/**
 * In-memory rendezvous between the scheduler fire and the exact user-visible
 * delivery/terminal events produced by that fire.
 *
 * A scheduler callback must not report success merely because a worker accepted
 * the prompt. Non-silent runs settle only after Lark returned a concrete
 * message id for the turn's final answer. Silent runs intentionally have no
 * delivery requirement and settle on a successful terminal event instead.
 *
 * The durable task row remains the restart boundary: if the daemon exits while
 * a run is pending, scheduler startup recovery turns the persisted `running`
 * state into an error. This module therefore must not persist a second ledger.
 */

export interface ScheduledRunSettlement {
  turnId: string;
  taskId: string;
  requireFinalDelivery: boolean;
  settled: Promise<{ messageId?: string }>;
}

interface PendingSettlement {
  taskId: string;
  larkAppId?: string;
  requireFinalDelivery: boolean;
  authorityIsCurrent?: () => boolean;
  resolve: (value: { messageId?: string }) => void;
  reject: (error: Error) => void;
}

const pending = new Map<string, PendingSettlement>();
const LARK_MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,128}$/;

export function isConfirmedLarkMessageId(value: unknown): value is string {
  return typeof value === 'string' && LARK_MESSAGE_ID.test(value);
}

export class ScheduledRunDeliveryError extends Error {
  constructor(turnId: string, detail: string) {
    super(`scheduled run ${turnId} did not produce a confirmed final delivery: ${detail}`);
    this.name = 'ScheduledRunDeliveryError';
  }
}

function settlementError(turnId: string, detail: string): ScheduledRunDeliveryError {
  return new ScheduledRunDeliveryError(turnId, detail);
}

function authorityIsCurrent(record: PendingSettlement): boolean {
  if (!record.authorityIsCurrent) return true;
  try { return record.authorityIsCurrent() === true; } catch { return false; }
}

export function beginScheduledRunSettlement(input: {
  turnId: string;
  taskId: string;
  larkAppId?: string;
  requireFinalDelivery: boolean;
  authorityIsCurrent?: () => boolean;
}): ScheduledRunSettlement {
  if (pending.has(input.turnId)) {
    throw new Error(`scheduled run settlement already exists for ${input.turnId}`);
  }
  let resolve!: PendingSettlement['resolve'];
  let reject!: PendingSettlement['reject'];
  const settled = new Promise<{ messageId?: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Revocation may arrive while dispatch is still awaiting worker admission;
  // attach a handler immediately so the preserved rejection cannot surface as
  // unhandled before executeScheduledRunAwaitingSettlement awaits it.
  void settled.catch(() => undefined);
  pending.set(input.turnId, {
    taskId: input.taskId,
    larkAppId: input.larkAppId,
    requireFinalDelivery: input.requireFinalDelivery,
    authorityIsCurrent: input.authorityIsCurrent,
    resolve,
    reject,
  });
  return { ...input, settled };
}

function settleScheduledRunFinalDelivery(
  turnId: string,
  messageId: string | undefined,
): boolean {
  const record = pending.get(turnId);
  if (!record || !record.requireFinalDelivery) return false;
  if (!isConfirmedLarkMessageId(messageId)) return false;
  if (!authorityIsCurrent(record)) {
    pending.delete(turnId);
    record.reject(settlementError(turnId, 'schedule authority was revoked before delivery'));
    return false;
  }
  pending.delete(turnId);
  record.resolve({ messageId });
  return true;
}

/** A daemon-owned Lark write returned this provider message id directly. Call
 * only at the exact awaited provider boundary, never from worker/CLI IPC. */
export function observeScheduledRunDaemonProviderDelivery(
  turnId: string,
  messageId: string | undefined,
): boolean {
  return settleScheduledRunFinalDelivery(turnId, messageId);
}

/** The daemon independently read the message back from Lark and verified its
 * exact scheduled-turn proof, generation, sender, chat and final-card shape. */
export function observeScheduledRunProviderReadbackDelivery(
  turnId: string,
  messageId: string | undefined,
): boolean {
  return settleScheduledRunFinalDelivery(turnId, messageId);
}

/** Terminal without a prior final receipt is an error for a non-silent run. */
export function observeScheduledRunTerminal(input: {
  turnId: string;
  status: string;
  errorCode?: string;
}): boolean {
  const record = pending.get(input.turnId);
  if (!record) return false;
  pending.delete(input.turnId);
  if (!authorityIsCurrent(record)) {
    record.reject(settlementError(input.turnId, 'schedule authority was revoked before terminal'));
    return true;
  }
  if (!record.requireFinalDelivery && input.status === 'completed') {
    record.resolve({});
    return true;
  }
  const detail = input.errorCode
    ? `${input.status} (${input.errorCode})`
    : input.status === 'completed'
      ? 'turn completed without a final Lark message receipt'
      : input.status;
  record.reject(settlementError(input.turnId, detail));
  return true;
}

/** Dispatch itself failed before a terminal event could exist. */
export function abortScheduledRunSettlement(turnId: string, error: unknown): boolean {
  const record = pending.get(turnId);
  if (!record) return false;
  pending.delete(turnId);
  record.reject(error instanceof Error ? error : new Error(String(error)));
  return true;
}

/** Revoke every in-flight run for the exact task authority. This closes the
 * window where a removed task could later be marked successful by a delayed
 * Provider receipt or terminal event. */
export function revokeScheduledRunSettlements(
  taskId: string,
  larkAppId?: string,
): number {
  let revoked = 0;
  for (const [turnId, record] of pending) {
    if (record.taskId !== taskId
        || (larkAppId !== undefined && record.larkAppId !== larkAppId)) continue;
    pending.delete(turnId);
    record.reject(settlementError(turnId, 'schedule authority was revoked'));
    revoked += 1;
  }
  return revoked;
}

/** Register before dispatch, then keep the scheduler callback pending until the
 * exact turn produces its required terminal evidence. */
export async function executeScheduledRunAwaitingSettlement(
  input: {
    turnId: string;
    taskId: string;
    larkAppId?: string;
    requireFinalDelivery: boolean;
    authorityIsCurrent?: () => boolean;
  },
  dispatch: () => void | Promise<void>,
): Promise<{ messageId?: string }> {
  const settlement = beginScheduledRunSettlement(input);
  try {
    await dispatch();
    return await settlement.settled;
  } catch (error) {
    abortScheduledRunSettlement(input.turnId, error);
    // Dispatch may have synchronously terminalized the exact turn before
    // throwing (for example, worker admission reports rejected and its caller
    // then raises).  In that case abort returns false because the pending row
    // is already gone, but the rejected rendezvous still needs an attached
    // consumer or Node can surface an unhandled rejection in the daemon.
    await settlement.settled.catch(() => undefined);
    throw error;
  }
}

export function __testOnlyResetScheduledRunSettlements(): void {
  for (const [turnId, record] of pending) {
    record.reject(settlementError(turnId, 'test reset'));
  }
  pending.clear();
}
