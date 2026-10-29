import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fileViewStyles } from './styles.js';

/** Rendered Markdown. Raw HTML in the source stays text, and unsafe link protocols are dropped. */
export function MarkdownPreview({ source, className }: { source: string; className?: string }) {
  return <div className={['fv-markdown', className].filter(Boolean).join(' ')}><style>{fileViewStyles}</style>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{source}</ReactMarkdown>
  </div>;
}
