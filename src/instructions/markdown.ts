import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

/**
 * Renders owner-authored Markdown to sanitized HTML for display. Markdown source may legally
 * contain raw HTML (CommonMark permits it), so `marked`'s output alone is not safe to inject:
 * every render is piped through DOMPurify, which strips script-capable tags/attributes (script,
 * on* handlers, style) and rejects unsafe link/image protocols (its default `ALLOWED_URI_REGEXP`
 * permits only http(s), ftp, mailto, tel, and a handful of other inert schemes — never
 * `javascript:` or `data:`). Pure and side-effect free beyond DOMPurify's internal DOM use.
 */
export function renderMarkdownToSafeHtml(markdown: string): string {
  const rawHtml = marked.parse(markdown, { async: false });
  return DOMPurify.sanitize(rawHtml, {
    FORBID_TAGS: ['style'],
    FORBID_ATTR: ['style'],
  });
}
