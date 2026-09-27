import { GUEST_SCROLLBAR_CSS } from '@novacode/sdk';

/** Append instead of matching tags inside untrusted comments, scripts, or templates.
 * Browsers accept the style after the document; its doctype and authored CSP stay intact.
 */
export const injectGuestDocumentStyles = (html) => `${html}\n<style data-novacode-guest-styles>${GUEST_SCROLLBAR_CSS}</style>`;
