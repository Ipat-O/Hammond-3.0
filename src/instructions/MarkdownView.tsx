import { useMemo } from 'react';

import { renderMarkdownToSafeHtml } from './markdown';

export interface MarkdownViewProps {
  markdown: string;
  emptyText?: string;
  className?: string;
  'aria-label'?: string;
}

/** Renders sanitized Markdown for display. Never used for owner input — see the paired textarea for that. */
export function MarkdownView({
  markdown,
  emptyText = '(nothing composed yet)',
  className,
  'aria-label': ariaLabel,
}: MarkdownViewProps) {
  const html = useMemo(() => renderMarkdownToSafeHtml(markdown), [markdown]);

  if (!markdown.trim()) {
    return (
      <div
        className={`markdown-view markdown-view-empty ${className ?? ''}`}
        aria-label={ariaLabel}
      >
        {emptyText}
      </div>
    );
  }

  return (
    <div
      className={`markdown-view ${className ?? ''}`}
      aria-label={ariaLabel}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
