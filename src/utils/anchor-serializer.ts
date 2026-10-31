/**
 * Per-anchor async serializer for Lark event handling.
 *
 * botmux's message handlers (handleThreadReply / handleNewTopic) are invoked
 * fire-and-forget from the WSClient event callback, so two messages addressed to
 * the SAME conversational unit (thread root or chat) are otherwise processed
 * concurrently. A fast second message then interleaves with the first's async
 * session-spawn. The concrete failure this fixes: `botmux dispatch` seeds a
 * thread, sends a `/repo <path>` prime (which creates the session and forks the
 * CLI worker — several awaits), then immediately sends the brief kickoff. The
 * kickoff's handler runs mid-spawn, finds `worker === null` with `pendingRepo`
 * already cleared, and falls into daemon.ts's "worker not running → re-fork with
 * resume" branch, which clobbers the in-flight spawn and drops the kickoff.
 *
 * Serializing per anchor makes the kickoff wait until the prime's handler fully
 * completes (worker live), so it routes as an ordinary follow-up that the worker
 * queues. Distinct anchors keep running concurrently, so unrelated threads/chats
 * are unaffected.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Max time the NEXT work waits for the previous same-anchor work before starting
 * anyway. The ordering we actually need (dispatch's /repo prime → brief kickoff)
 * completes in ~1s; this only bounds the damage when a handler is slow or hangs.
 * Without it, one stuck handler blocks the anchor's queue forever — so a busy bot
 * MISSES every subsequent @ to that chat/thread (observed: a reviewer had to be
 * re-@-ed because "上一条可能没触发到你"). Past the cap we fall back to the prior
 * concurrent behavior for that pair (lose strict order, never lose the message).
 */
const SERIALIZE_MAX_WAIT_MS = 5000;

/**
 * Queue `work` so it runs only after any previously-queued work for the same
 * `anchor` has settled (resolved OR rejected — a failing handler never blocks
 * the next message) OR `capMs` elapses (a slow/hung handler must not block the
 * queue indefinitely). Returns a promise that settles with `work`'s outcome, so
 * callers can still attach `.catch` for logging. Different anchors are
 * independent and run concurrently.
 */
export function serializeByAnchor<T>(
  anchor: string,
  work: () => Promise<T>,
  capMs: number = SERIALIZE_MAX_WAIT_MS,
): Promise<T> {
  const prev = queues.get(anchor) ?? Promise.resolve();
  // Wait for `prev` to settle, but no longer than `capMs` — `prev.then` swallows
  // its outcome (one handler's failure must not stall the queue), and the race
  // with a timer bounds head-of-line blocking when `prev` is slow/hung.
  const settledOrCapped = capMs > 0
    ? Promise.race([prev.then(() => {}, () => {}), new Promise<void>(res => setTimeout(res, capMs))])
    : prev.then(() => {}, () => {});
  const next = settledOrCapped.then(work);
  queues.set(anchor, next);
  // Garbage-collect the entry once this call is the tail of the chain, so the
  // map doesn't grow unbounded across the daemon's lifetime. Swallow `next`'s
  // outcome on a *separate* chain (so this cleanup never surfaces as an
  // unhandled rejection); the rejection itself is still delivered to the caller
  // via the returned `next`.
  void next.then(() => {}, () => {}).then(() => {
    if (queues.get(anchor) === next) queues.delete(anchor);
  });
  return next;
}

interface PartitionLanes {
  /** Settles once the latest keyless (barrier) work and everything before it settled. */
  barrier: Promise<void>;
  /** Tail of each ordering key's chain started since that barrier. */
  keys: Map<string, Promise<void>>;
  pending: number;
}

const partitions = new Map<string, PartitionLanes>();

/**
 * Same ordering rule as the durable Inbox claim (Mew #100), applied in process:
 * work with an ordering key waits only for earlier work of the same key and for
 * earlier keyless work; keyless work is a barrier that waits for everything
 * queued before it in the partition, and everything queued after waits for it.
 * No cap: the claim lease, not a timer, bounds how long one row may hold its lane.
 */
export function serializeByOrderingKey<T>(
  partition: string,
  orderingKey: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  let lanes = partitions.get(partition);
  if (!lanes) {
    lanes = { barrier: Promise.resolve(), keys: new Map(), pending: 0 };
    partitions.set(partition, lanes);
  }
  const gate = orderingKey === undefined
    ? Promise.all([lanes.barrier, ...lanes.keys.values()])
    : Promise.all([lanes.barrier, lanes.keys.get(orderingKey) ?? Promise.resolve()]);
  const next = gate.then(work);
  const settled = next.then(() => {}, () => {});
  if (orderingKey === undefined) {
    lanes.barrier = settled;
    lanes.keys.clear();
  } else {
    lanes.keys.set(orderingKey, settled);
  }
  lanes.pending++;
  const current = lanes;
  void settled.then(() => {
    current.pending--;
    if (orderingKey !== undefined && current.keys.get(orderingKey) === settled) {
      current.keys.delete(orderingKey);
    }
    if (current.pending === 0 && partitions.get(partition) === current) partitions.delete(partition);
  });
  return next;
}

/** Test-only: clear all queues between cases. */
export function __resetAnchorQueues(): void {
  queues.clear();
  partitions.clear();
}
