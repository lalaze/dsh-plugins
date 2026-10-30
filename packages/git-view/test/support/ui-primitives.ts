import { createElement as h } from 'react';

/** DSH's `@deepseek-ai/dsh-client-ui-primitives`, which the web shell provides at run time, reduced to plain elements. */
const glyph = () => h('span', { 'data-icon': '' });
export const FileTypeIcon = glyph, IconChevronDownOutlineRegular = glyph, IconFolderCloseRegular = glyph, IconFolderOpenRegular = glyph;
export const StateDot = ({ state }: { state: string }) => h('span', { 'data-state': state });
export const MarkdownText = ({ text }: { text: string }) => h('div', null, text);
export const languageForPath = () => undefined;
export const useCodeHighlighter = () => () => undefined;
export const writeClipboard = async () => true;
export const Menu = ({ trigger }: { trigger?: unknown }) => h('div', null, trigger as never);
const tabs = ({ items, value, onChange }: { items: { key?: string; value?: string; label: unknown }[]; value: string; onChange(next: string): void }) =>
  h('div', { role: 'tablist' }, items.map(item => { const key = item.key ?? item.value ?? ''; return h('button', { key, type: 'button', role: 'tab', 'aria-selected': key === value, onClick: () => onChange(key) }, item.label as never); }));
export const SegmentedTabs = tabs, SegmentedControl = tabs;
