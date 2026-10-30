/**
 * 「关闭已受理、仍在进行」（HTTP 202 `{ outcome: 'closing', pending: true }`）之后的
 * 状态轮询。durable-primary 下关闭一个正在跑轮次的 Remote Runner 会话要删远端
 * compute 并自动快照，常常超过 daemon 的等待窗口；关闭本身稍后会成功，所以页面
 * 只显示「关闭中…」并轮询，直到会话真的变成 closed，或超时后明确告诉操作者。
 *
 * 不依赖 DOM / React，便于在 vitest 里直接测。
 */

export interface SessionStatusRow {
  sessionId?: unknown;
  status?: unknown;
}

export interface WaitForSessionsClosedOptions {
  /** 拉一次会话快照；返回 undefined 或抛错都只算这一轮没拿到，继续轮询。 */
  fetchSessions?: () => Promise<SessionStatusRow[] | undefined>;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export interface WaitForSessionsClosedResult {
  closed: string[];
  /** 超时仍未确认关闭的会话。 */
  pending: string[];
}

export const CLOSE_PENDING_POLL_INTERVAL_MS = 3_000;
export const CLOSE_PENDING_POLL_TIMEOUT_MS = 180_000;

async function fetchDashboardSessions(): Promise<SessionStatusRow[] | undefined> {
  const r = await fetch('/api/sessions', { cache: 'no-store' });
  if (!r.ok) return undefined;
  const body = await r.json().catch(() => undefined) as { sessions?: unknown } | undefined;
  return Array.isArray(body?.sessions) ? body.sessions as SessionStatusRow[] : undefined;
}

/**
 * 轮询直到每个会话 `status === 'closed'`，或者从快照里消失（Dashboard 视角下
 * 行已不在，也就无可再关）。快照拉取失败不算会话失败，只是这一轮没有新信息。
 */
export async function waitForSessionsClosed(
  sessionIds: readonly string[],
  options: WaitForSessionsClosedOptions = {},
): Promise<WaitForSessionsClosedResult> {
  const fetchSessions = options.fetchSessions ?? fetchDashboardSessions;
  const intervalMs = options.intervalMs ?? CLOSE_PENDING_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? CLOSE_PENDING_POLL_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const remaining = new Set(sessionIds);
  const closed: string[] = [];
  const deadline = now() + timeoutMs;
  while (remaining.size > 0 && now() < deadline) {
    await wait(intervalMs);
    let rows: SessionStatusRow[] | undefined;
    try {
      rows = await fetchSessions();
    } catch {
      rows = undefined;
    }
    if (!rows) continue;
    const byId = new Map<string, SessionStatusRow>();
    for (const row of rows) {
      if (typeof row?.sessionId === 'string') byId.set(row.sessionId, row);
    }
    for (const id of [...remaining]) {
      const row = byId.get(id);
      if (!row || row.status === 'closed') {
        remaining.delete(id);
        closed.push(id);
      }
    }
  }
  return { closed, pending: [...remaining] };
}
