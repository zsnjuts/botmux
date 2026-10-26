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

const ELEMENT_CONTAINER_TAGS = new Set([
  'column',
  'collapsible_panel',
  'div',
  'form',
  'interactive_container',
  'note',
]);

function visitCardComponents(
  elements: unknown,
  visit: (component: Record<string, unknown>) => boolean | void,
): boolean {
  if (!Array.isArray(elements)) return false;
  for (const element of elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
    const component = element as Record<string, unknown>;
    if (visit(component) === true) return true;
    if (component.tag === 'column_set') {
      if (visitCardComponents(component.columns, visit)) return true;
    } else if (component.tag === 'action') {
      if (visitCardComponents(component.actions, visit)) return true;
    } else if (typeof component.tag === 'string'
        && ELEMENT_CONTAINER_TAGS.has(component.tag)
        && visitCardComponents(component.elements, visit)) return true;
  }
  return false;
}

/** Find the canonical footer only in documented Card 2.0 component slots.
 * Ordinary reply cards place it at body top level; voice-enabled cards place
 * it directly in a `column_set` column. Callback values and arbitrary business
 * JSON are deliberately not traversed. */
export function findReplyCardFooterComponent(
  elements: unknown,
): Record<string, unknown> | undefined {
  let footer: Record<string, unknown> | undefined;
  visitCardComponents(elements, component => {
    if (component.tag === 'markdown'
        && component.element_id === REPLY_CARD_FOOTER_ELEMENT_ID) {
      footer = component;
      return true;
    }
  });
  return footer;
}

/** Detect a reserved-id collision in the same documented component slots,
 * including a malformed non-markdown component that cannot serve as footer. */
export function containsReplyCardFooterElementId(elements: unknown): boolean {
  return countReplyCardFooterElementIds(elements) > 0;
}

/** Count reserved footer ids in the same real component slots. Provider
 * receipt verification requires exactly one, including malformed collisions. */
export function countReplyCardFooterElementIds(elements: unknown): number {
  let count = 0;
  visitCardComponents(elements, component => {
    if (component.element_id === REPLY_CARD_FOOTER_ELEMENT_ID) count += 1;
  });
  return count;
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
