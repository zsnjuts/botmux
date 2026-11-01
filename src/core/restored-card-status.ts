/**
 * Restart-time status check for a surviving streaming card.
 *
 * A card's status lives only in its header text (「🖥️ Claude · 标题 — 工作中」);
 * the daemon does not persist it. After a restart the header is read back from
 * Lark, and only a card whose header still claims the CLI is running is
 * reconciled. Pure helpers — worker-pool owns the I/O.
 */
import { SUPPORTED_LOCALES, t } from '../i18n/index.js';

/** Header labels of the statuses that say "the CLI is running this turn". */
const WORKING_STATUS_KEYS = [
  'card.status.starting',
  'card.status.working',
  'card.status.analyzing',
  'card.status.stalled',
] as const;

/** Templated variants of those statuses (Remote Runner startup stage, startup
 *  and run timers). Only their literal text before the first placeholder is
 *  stable — e.g. 「启动中 · 」, 「工作中 · 已运行 」. */
const WORKING_STATUS_TEMPLATE_KEYS = [
  'card.status.starting_stage',
  'card.status.starting_stage_elapsed',
  'card.status.starting_elapsed',
  'card.status.working_elapsed',
] as const;

let workingLabels: { exact: Set<string>; prefixes: string[] } | undefined;

function workingStatusLabels(): { exact: Set<string>; prefixes: string[] } {
  if (!workingLabels) {
    const exact = new Set(
      SUPPORTED_LOCALES.flatMap(locale => WORKING_STATUS_KEYS.map(key => t(key, undefined, locale))),
    );
    const prefixes = new Set<string>();
    // A status may carry a suffix after ' · ' (「工作中 · 已运行 3 分」).
    for (const label of exact) prefixes.add(`${label} · `);
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of WORKING_STATUS_TEMPLATE_KEYS) {
        const template = t(key, undefined, locale);
        const literal = template.slice(0, template.indexOf('{') < 0 ? template.length : template.indexOf('{'));
        // A template with no literal lead would match any status.
        if (literal.trim()) prefixes.add(literal);
      }
    }
    workingLabels = { exact, prefixes: [...prefixes] };
  }
  return workingLabels;
}

function titleText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return undefined;
}

/** Header title of a card message as returned by `GET /im/v1/messages/:id`:
 *  the original card JSON (`user_card_content`) or Lark's simplified
 *  `{ title, elements }` form. Undefined for a withdrawn or non-card message. */
export function cardMessageTitle(detail: unknown): string | undefined {
  const item = (detail as { items?: unknown[] } | undefined)?.items?.[0] as
    { deleted?: unknown; msg_type?: unknown; body?: { content?: unknown } } | undefined;
  if (!item || item.deleted === true) return undefined;
  if (item.msg_type !== undefined && item.msg_type !== 'interactive') return undefined;
  const raw = item.body?.content;
  if (typeof raw !== 'string') return undefined;
  let card: any;
  try { card = JSON.parse(raw); } catch { return undefined; }
  if (!card || typeof card !== 'object') return undefined;
  return titleText(card.header?.title) ?? titleText(card.title);
}

/** True when `title` is a botmux streaming card whose status label says the
 *  CLI is still running (启动中 / 工作中 / 正在分析 / 长时间无进展, any locale),
 *  including their suffixed forms (「启动中 · 正在创建沙箱 · 12 秒」、
 *  「工作中 · 已运行 3 分 20 秒」). */
export function streamingCardTitleClaimsWork(title: string | undefined): boolean {
  if (!title || !title.startsWith('🖥️')) return false;
  const sep = title.lastIndexOf(' — ');
  if (sep < 0) return false;
  const status = title.slice(sep + ' — '.length).trim();
  const labels = workingStatusLabels();
  return labels.exact.has(status) || labels.prefixes.some(prefix => status.startsWith(prefix));
}

/** The message was sent by this bot. Lark labels a bot sender `app` in message
 *  lists, but other surfaces of the same API have said `bot`; accept either, or
 *  an app_id-typed id (as deferred-topic-claim does). The fence that matters is
 *  equality with this bot's own app id. */
function isOwnAppSender(sender: Record<string, any> | undefined, larkAppId: string): boolean {
  if (!sender || sender.id !== larkAppId) return false;
  const idType = sender.id_type ?? sender.sender_id_type;
  return sender.sender_type === 'app' || sender.sender_type === 'bot' || idType === 'app_id';
}

/** Streaming cards in a listed message window (Lark `im/v1/messages` items)
 *  that this bot posted before `postedBefore` and that still claim work while
 *  being no session's live card. Older builds left these behind: a type-ahead
 *  turn whose card was never parked, or a frozen-card list overwritten after a
 *  restart — nothing tracks them, so nothing would ever withdraw them. */
export function staleWorkingCardIds(
  messages: readonly unknown[],
  opts: { larkAppId: string; liveCardIds: ReadonlySet<string>; postedBefore: number },
): string[] {
  const ids: string[] = [];
  for (const m of messages as Array<Record<string, any> | null | undefined>) {
    if (!m || m.deleted === true || m.msg_type !== 'interactive') continue;
    if (!isOwnAppSender(m.sender, opts.larkAppId)) continue;
    const id = m.message_id;
    if (typeof id !== 'string' || !id || opts.liveCardIds.has(id)) continue;
    const createdAt = Number(m.create_time);
    if (!Number.isFinite(createdAt) || createdAt >= opts.postedBefore) continue;
    if (streamingCardTitleClaimsWork(cardMessageTitle({ items: [m] }))) ids.push(id);
  }
  return ids;
}
