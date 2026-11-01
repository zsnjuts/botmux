/**
 * Remote Runner final answer: do not repeat a link the requester was already
 * @-mentioned with earlier in the same turn.
 *
 * A TAE turn typically sends an authorization / confirmation link through
 * `botmux send --mention-back` and then ends with a final answer that pastes
 * the very same link again, so the topic shows it twice. The host deliberately
 * never suppresses a final because of progress messages (see
 * `shouldSuppressBridgeEmit`): the final is the turn's answer. This module only
 * rewrites the duplicated link inside that answer — the prose stays — and is
 * fail-open: anything it cannot classify is delivered unchanged.
 *
 * Scope is intentionally narrow: only links from a DELIVERED, NON-final
 * outbound message that mentioned the REQUESTER count, keyed by the exact turn
 * and dispatch attempt. A plain progress note's link is not something the user
 * was pointed at, so the final keeps it.
 */
import type {
  RemoteRunnerOutboundMessage,
  RemoteRunnerOutboundMessageResult,
} from '../adapters/backend/remote-runner-protocol.js';
import { extractHttpUrlSpans } from './link-ref-extractor.js';
import { markdownCodeLiteralRanges } from './link-ref-resolver.js';

export interface RemoteFinalLinkHints {
  /** Replaces a bare URL (or `<url>` autolink). */
  bare: string;
  /** Replaces `[label](url)`, keeping the visible label. */
  labeled(label: string): string;
}

interface Range {
  start: number;
  end: number;
}

interface MarkdownLink extends Range {
  label: string;
  destination: string;
  image: boolean;
}

const HTTP_URL_RE = /^https?:\/\//iu;

function inRanges(ranges: readonly Range[], index: number): Range | undefined {
  return ranges.find(range => range.start <= index && index < range.end);
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Parse `(destination "title")` starting right after `](`. Returns the
 * destination and the index just past the closing `)`, or null. */
function parseDestination(text: string, from: number): { destination: string; end: number } | null {
  let cursor = from;
  const skipBlanks = () => { while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1; };
  skipBlanks();
  let destination: string;
  if (text[cursor] === '<') {
    const close = text.indexOf('>', cursor + 1);
    if (close < 0) return null;
    destination = text.slice(cursor + 1, close);
    if (/[\n<]/u.test(destination)) return null;
    cursor = close + 1;
  } else {
    const start = cursor;
    let depth = 0;
    while (cursor < text.length) {
      const char = text[cursor]!;
      if (char === '\\') { cursor += 2; continue; }
      if (/\s/u.test(char)) break;
      if (char === '(') depth += 1;
      else if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      cursor += 1;
    }
    destination = text.slice(start, cursor);
  }
  skipBlanks();
  const quote = text[cursor];
  if (quote === '"' || quote === '\'') {
    const close = text.indexOf(quote, cursor + 1);
    if (close < 0 || text.slice(cursor, close).includes('\n')) return null;
    cursor = close + 1;
    skipBlanks();
  }
  if (text[cursor] !== ')') return null;
  return { destination, end: cursor + 1 };
}

/** Inline Markdown links/images whose destination is an http(s) URL. */
function markdownLinks(text: string, code: readonly Range[]): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const literal = inRanges(code, index);
    if (literal) { index = literal.end - 1; continue; }
    if (text[index] !== '[' || isEscaped(text, index)) continue;
    let depth = 1;
    let close = index + 1;
    for (; close < text.length && text[close] !== '\n'; close += 1) {
      if (text[close] === '\\') { close += 1; continue; }
      if (text[close] === '[') depth += 1;
      else if (text[close] === ']' && --depth === 0) break;
    }
    if (depth !== 0 || text[close + 1] !== '(') continue;
    const parsed = parseDestination(text, close + 2);
    if (!parsed || !HTTP_URL_RE.test(parsed.destination)) continue;
    const image = index > 0 && text[index - 1] === '!' && !isEscaped(text, index - 1);
    links.push({
      start: image ? index - 1 : index,
      end: parsed.end,
      label: text.slice(index + 1, close),
      destination: parsed.destination,
      image,
    });
    index = parsed.end - 1;
  }
  return links;
}

/** Bare URLs outside `excluded`. Excluded regions are blanked (same length, so
 * offsets stay valid) because a space is a hard URL terminator for the shared
 * extractor — a URL can then neither start inside nor run into them. */
function bareUrls(text: string, excluded: readonly Range[]): Array<Range & { url: string }> {
  // split('') keeps UTF-16 offsets aligned with `text` (a surrogate pair stays two slots).
  const chars = text.split('');
  for (const range of excluded) chars.fill(' ', range.start, range.end);
  return extractHttpUrlSpans(chars.join('')).map(span => {
    // `<url>` autolink: replace the brackets together with the URL.
    const autolink = text[span.start - 1] === '<' && text[span.end] === '>';
    return {
      start: autolink ? span.start - 1 : span.start,
      end: autolink ? span.end + 1 : span.end,
      url: span.originalUrl,
    };
  });
}

/** The URLs an outbound message showed to the user, in first-seen order. Code
 * spans count too: the user still received the link text. */
export function outboundMessageLinkUrls(content: string): string[] {
  const links = markdownLinks(content, []);
  const urls = [
    ...links.map(link => link.destination),
    ...bareUrls(content, links).map(span => span.url),
  ];
  return [...new Set(urls)];
}

/** Whether an outbound message's links are "already delivered to the
 * requester": it reached Lark, it is not the final itself, and it @-mentioned
 * the requester (`--mention-back`). */
export function outboundLinksReachedRequester(
  message: Pick<RemoteRunnerOutboundMessage, 'responseKind' | 'mention'>,
  result: RemoteRunnerOutboundMessageResult,
): boolean {
  return result.outcome === 'delivered'
    && message.responseKind !== 'final'
    && message.mention === 'requester';
}

/**
 * Replace links in `finalText` that were already delivered to the requester:
 * `[label](url)` → `hints.labeled(label)`, bare / autolinked URL →
 * `hints.bare`. Fenced code blocks, inline code and images are left untouched.
 * Returns the original text when nothing matches, on any error, and when the
 * rewrite would leave nothing visible.
 */
export function dedupeRemoteFinalLinks(
  finalText: string,
  deliveredUrls: ReadonlySet<string> | undefined,
  hints: RemoteFinalLinkHints,
): string {
  if (!deliveredUrls || deliveredUrls.size === 0 || !finalText) return finalText;
  try {
    const code = markdownCodeLiteralRanges(finalText);
    const links = markdownLinks(finalText, code);
    const edits: Array<Range & { replacement: string }> = [];
    for (const link of links) {
      if (link.image || !deliveredUrls.has(link.destination)) continue;
      const label = link.label.trim();
      const replacement = !label || HTTP_URL_RE.test(label) ? hints.bare : hints.labeled(label);
      edits.push({ start: link.start, end: link.end, replacement });
    }
    for (const span of bareUrls(finalText, [...code, ...links])) {
      if (deliveredUrls.has(span.url)) edits.push({ ...span, replacement: hints.bare });
    }
    if (edits.length === 0) return finalText;
    edits.sort((left, right) => left.start - right.start);
    let output = '';
    let cursor = 0;
    for (const edit of edits) {
      output += finalText.slice(cursor, edit.start) + edit.replacement;
      cursor = edit.end;
    }
    output += finalText.slice(cursor);
    return output.trim() ? output : finalText;
  } catch {
    return finalText;
  }
}

/**
 * Per-turn record of links already delivered to the requester, keyed by the
 * exact `turnId` + dispatch attempt so a retried attempt never inherits the
 * previous attempt's sends. Bounded on both axes; the oldest turn is evicted
 * first, and the worker clears a turn once its final has been handled.
 */
export class RemoteFinalLinkLedger {
  private readonly turns = new Map<string, Set<string>>();

  constructor(
    private readonly maxTurns = 8,
    private readonly maxUrlsPerTurn = 32,
  ) {}

  private static key(turnId: string, dispatchAttempt: number | undefined): string {
    return `${turnId}\0${dispatchAttempt ?? ''}`;
  }

  record(turnId: string, dispatchAttempt: number | undefined, content: string): void {
    const urls = outboundMessageLinkUrls(content);
    if (urls.length === 0) return;
    const key = RemoteFinalLinkLedger.key(turnId, dispatchAttempt);
    let delivered = this.turns.get(key);
    if (!delivered) {
      delivered = new Set();
      this.turns.set(key, delivered);
      while (this.turns.size > this.maxTurns) {
        this.turns.delete(this.turns.keys().next().value!);
      }
    }
    for (const url of urls) {
      if (delivered.size >= this.maxUrlsPerTurn) break;
      delivered.add(url);
    }
  }

  deliveredUrls(turnId: string, dispatchAttempt: number | undefined): ReadonlySet<string> | undefined {
    return this.turns.get(RemoteFinalLinkLedger.key(turnId, dispatchAttempt));
  }

  clear(turnId: string, dispatchAttempt: number | undefined): void {
    this.turns.delete(RemoteFinalLinkLedger.key(turnId, dispatchAttempt));
  }
}
