import type { DurableCoordinationStore } from './durable-coordination.js';
import { storedSessionAnchorId } from '../core/types.js';
import { durableDirectSessionControlEvent } from './durable-lark-session-control.js';
import { parseDurablePrimarySessionRecord } from './durable-session-primary.js';

export interface DurableSessionControlRequest {
  larkAppId: string;
  sessionKey?: string;
  sessionId: string;
  action: 'close' | 'resume';
}

export type DurableSessionControlRequestResult =
  | { ok: true; outcome: 'closed' | 'active'; alreadyClosed?: boolean }
  | {
      ok: true;
      outcome: 'closed_with_residual';
      residual: { reason?: string; taskId?: string };
      alreadyClosed?: boolean;
    }
  /**
   * 关闭已排入持久 inbox，但在等待窗口内还没提交（远端 compute 删除 + 自动快照
   * 可能要 50–60 秒）。这不是失败：operation 已经入队，consumer 会继续执行；
   * 调用方应提示「关闭中」并轮询会话状态，而不是报错。只用于 close：resume
   * 仍按原样在超时后返回 `durable_control_timeout`。
   */
  | { ok: true; outcome: 'closing'; pending: true; operationId: string }
  | { ok: false; error: string };

function resultObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function closeResidual(value: unknown): { reason?: string; taskId?: string } | undefined {
  const raw = resultObject(value);
  if (!raw) return undefined;
  const reason = typeof raw.reason === 'string' ? raw.reason : undefined;
  const taskId = typeof raw.taskId === 'string' ? raw.taskId : undefined;
  return reason || taskId ? { ...(reason ? { reason } : {}), ...(taskId ? { taskId } : {}) } : undefined;
}

/**
 * 排入一个已鉴权的非卡片生命周期动作，并等待结果进入 canonical Session 快照。
 * operation id 绑定读到的 revision：不确定 HTTP 请求的重试复用同一副作用，
 * 后续 resume/close 产生新 revision 后则会获得新的 id。
 */
export async function requestDurableSessionControl(input: {
  store: DurableCoordinationStore;
  request: DurableSessionControlRequest;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): Promise<DurableSessionControlRequestResult> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const timeoutMs = input.timeoutMs ?? 45_000;
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  let canonicalKey = input.request.sessionKey;
  let initial = canonicalKey
    ? await input.store.readSession(canonicalKey)
    : undefined;
  if (!initial && input.store.listSessions) {
    let afterSessionKey: string | undefined;
    for (let page = 0; page < 40; page += 1) {
      const listed = await input.store.listSessions({
        ...(afterSessionKey ? { afterSessionKey } : {}),
        limit: 256,
      });
      initial = listed.records.find(candidate => {
        try {
          const parsed = parseDurablePrimarySessionRecord(candidate);
          return parsed.session.sessionId === input.request.sessionId
            && parsed.session.larkAppId === input.request.larkAppId;
        } catch {
          return false;
        }
      });
      if (initial || !listed.nextSessionKey) break;
      afterSessionKey = listed.nextSessionKey;
    }
    canonicalKey = initial?.sessionKey;
  }
  if (!initial) return { ok: false, error: 'durable_session_not_found' };
  canonicalKey ??= initial.sessionKey;
  const canonical = parseDurablePrimarySessionRecord(initial);
  if (canonical.session.sessionId !== input.request.sessionId
      || canonical.session.larkAppId !== input.request.larkAppId) {
    return { ok: false, error: 'durable_session_identity_changed' };
  }
  const targetStatus = input.request.action === 'close' ? 'closed' : 'active';
  const alreadyAtTarget = (
    snapshot: ReturnType<typeof parseDurablePrimarySessionRecord>,
  ): DurableSessionControlRequestResult => {
    const residual = input.request.action === 'close'
      ? closeResidual(resultObject(snapshot.controls.at(-1)?.result)?.residual)
      : undefined;
    return input.request.action === 'close'
      ? residual
        ? { ok: true, outcome: 'closed_with_residual', residual, alreadyClosed: true }
        : { ok: true, outcome: 'closed', alreadyClosed: true }
      : { ok: true, outcome: 'active' };
  };
  if (canonical.session.status === targetStatus) return alreadyAtTarget(canonical);
  const operationId = [
    'trusted-host.session-control',
    input.request.larkAppId,
    input.request.sessionId,
    String(initial.revision),
    input.request.action,
  ].join(':');
  const event = durableDirectSessionControlEvent({
    source: 'trusted-host',
    larkAppId: input.request.larkAppId,
    operationId,
    action: input.request.action,
    sessionId: input.request.sessionId,
    rootId: storedSessionAnchorId(canonical.session),
    cardMessageId: canonical.session.streamCardId,
    now: now(),
  });
  const inserted = await input.store.enqueueInbox(event);
  if (inserted.kind === 'conflict') {
    return { ok: false, error: 'durable_control_conflict' };
  }
  const deadline = now() + timeoutMs;
  // 截止后再读一次快照：等待最后一个间隔里提交的结果不应被当成「仍在进行」。
  for (let finalCheck = now() >= deadline; ; finalCheck = now() >= deadline) {
    const currentRecord = await input.store.readSession(canonicalKey);
    if (!currentRecord) return { ok: false, error: 'durable_session_disappeared' };
    const current = parseDurablePrimarySessionRecord(currentRecord);
    if (current.session.sessionId !== input.request.sessionId) {
      return { ok: false, error: 'durable_session_identity_changed' };
    }
    const committed = current.controls.find(item => item.operationId === operationId);
    if (committed) {
      const result = resultObject(committed.result);
      if (current.session.status === targetStatus) {
        const residual = input.request.action === 'close'
          ? closeResidual(result?.residual)
          : undefined;
        return input.request.action === 'close'
          ? residual
            ? {
                ok: true,
                outcome: 'closed_with_residual',
                residual,
                ...(result?.alreadyClosed === true ? { alreadyClosed: true } : {}),
              }
            : {
                ok: true,
                outcome: 'closed',
                ...(result?.alreadyClosed === true ? { alreadyClosed: true } : {}),
              }
          : { ok: true, outcome: 'active' };
      }
      return {
        ok: false,
        error: typeof result?.error === 'string'
          ? result.error
          : 'durable_control_not_applied',
      };
    }
    if (finalCheck) {
      // 另一条路径（卡片、`/close`）已先把会话关掉：本 operation 之后只会是幂等
      // no-op，按「已关闭」回答，不必让调用方再轮询。
      if (current.session.status === targetStatus) return alreadyAtTarget(current);
      break;
    }
    await wait(pollIntervalMs);
  }
  // 走到这里说明：operation 已入队（inserted / duplicate），会话仍在、身份没变，
  // 只是还没提交。close 返回「已受理、进行中」，让调用方轮询而不是误报失败；
  // resume 保持原有的超时错误。
  return input.request.action === 'close'
    ? { ok: true, outcome: 'closing', pending: true, operationId }
    : { ok: false, error: 'durable_control_timeout' };
}
