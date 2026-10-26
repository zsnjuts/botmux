/** Identity shared by reply-card producers and the card parser. Current cards
 * use a multi-code-point invisible text sentinel. A single invisible separator
 * can occur in ordinary text, so it is not sufficiently specific on its own.
 *
 * This differs from the historical zero-width Markdown link: Lark could drop
 * that link while simplifying a card, whereas U+2063 plain text survives the
 * round trip. Repeating the known-surviving character keeps the marker hidden
 * while making an accidental match in user-authored text vanishingly unlikely. */
export const REPLY_CARD_FOOTER_ELEMENT_ID = 'botmux_reply_footer';
export const REPLY_CARD_FOOTER_MARKER = '\u2063\u2063\u2063\u2063';

/** Find the canonical footer only in documented Card 2.0 component slots.
 * Ordinary reply cards place it at body top level; voice-enabled cards place
 * it directly in a `column_set` column. Callback values and arbitrary business
 * JSON are deliberately not traversed. */
export function findReplyCardFooterComponent(
  elements: unknown,
): Record<string, unknown> | undefined {
  if (!Array.isArray(elements)) return undefined;
  for (const element of elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
    const component = element as Record<string, unknown>;
    if (component.tag === 'markdown'
        && component.element_id === REPLY_CARD_FOOTER_ELEMENT_ID) return component;
    if (component.tag !== 'column_set' || !Array.isArray(component.columns)) continue;
    for (const column of component.columns) {
      if (!column || typeof column !== 'object' || Array.isArray(column)) continue;
      const columnComponent = column as Record<string, unknown>;
      if (columnComponent.tag !== 'column') continue;
      const footer = findReplyCardFooterComponent(columnComponent.elements);
      if (footer) return footer;
    }
  }
  return undefined;
}

/** Detect a reserved-id collision in the same documented component slots,
 * including a malformed non-markdown component that cannot serve as footer. */
export function containsReplyCardFooterElementId(elements: unknown): boolean {
  if (!Array.isArray(elements)) return false;
  for (const element of elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
    const component = element as Record<string, unknown>;
    if (component.element_id === REPLY_CARD_FOOTER_ELEMENT_ID) return true;
    if (component.tag !== 'column_set' || !Array.isArray(component.columns)) continue;
    for (const column of component.columns) {
      if (!column || typeof column !== 'object' || Array.isArray(column)) continue;
      const columnComponent = column as Record<string, unknown>;
      if (columnComponent.tag === 'column'
          && containsReplyCardFooterElementId(columnComponent.elements)) return true;
    }
  }
  return false;
}

/** Promoted H1/H2 heading widgets encode their original ATX level in the
 * element id. Lark strips `text_size` when a message is read back, so the id
 * is the only carrier that survives server normalization (same production
 * mechanism as the footer id above); the parser rebuilds `#` / `##` from it
 * so cross-session reads keep the heading hierarchy. */
export function replyCardHeadingElementId(level: 1 | 2, seq: number): string {
  return `botmux_md_h${level}_${seq}`;
}
export const REPLY_CARD_HEADING_ELEMENT_ID_RE = /^botmux_md_h([12])_\d+$/;
