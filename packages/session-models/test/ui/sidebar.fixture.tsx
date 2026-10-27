import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { apply } from '../../src/client/index.js';
import type { SessionList, Sessions } from '../../src/client/overlay.js';

// Host markup and CSS copied from dsh-client-ui-workspace Rows and ui-primitives StateDot (0.2.1-rc.2).
const HOST_CSS = `
:root{color-scheme:light dark;--dsw-alias-label-primary:#1f2328;--dsw-alias-label-tertiary:#7d848b;--dsw-alias-state-success-primary:#22a559;--dsw-alias-state-warn-primary:#e8a317;--dsw-alias-state-error-primary:#e5484d;--sidebar:rgba(255,255,255,.72)}
@media (prefers-color-scheme:dark){:root{--dsw-alias-label-primary:#e6e8ea;--dsw-alias-label-tertiary:#8a9096;--sidebar:rgba(20,22,26,.55)}}
body{margin:0;min-height:100vh;font:13px system-ui;background:linear-gradient(135deg,#5b6b4a,#2a3b4f 45%,#7a5530)}
.sidebar{width:300px;padding:8px;background:var(--sidebar);backdrop-filter:blur(8px)}
.sessionRow{border-radius:8px;padding:0 8px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);align-items:center;display:flex;gap:0;height:32px}
.slot{width:16px;height:20px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;display:inline-flex}
.title{flex:1;margin:0 6px 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.time{color:var(--dsw-alias-label-tertiary);font-size:12px}
.vh{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}
.dot{position:relative;display:inline-block;flex:none}
.dot::after{content:'';position:absolute;inset:20%;border-radius:50%;background:currentColor}
.dot[data-state='done']{color:var(--dsw-alias-state-success-primary)}
.dot[data-state='warning']{color:var(--dsw-alias-state-warn-primary)}
.dot[data-state='error']{color:var(--dsw-alias-state-error-primary)}
.spinner{flex:none;color:var(--dsw-alias-label-tertiary)}
.spinnerTrack,.spinnerArc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.spinnerTrack{opacity:.25}
.spinnerArc{stroke-dasharray:18 150;stroke-dashoffset:-3}
.mark{display:inline-flex}
.hoverCard{margin:12px 8px;width:280px;padding:12px;border-radius:10px;background:#2b2f33}
.hoverContent{flex-direction:column;gap:8px;display:flex}
.hoverTitle{color:#fff;font-size:14px;line-height:20px}
.hoverTime{color:#cfd3d6;font-size:12px;line-height:16px}
.hoverStatus{color:#adb2b8;align-items:center;gap:8px;font-size:12px;line-height:20px;display:flex}
`;

interface Row { id: string; title: string; state: 'done' | 'warning' | 'error' | 'ongoing' | 'idle'; schedule?: boolean; archived?: boolean; wrapped?: boolean; remote?: boolean; selection?: [string, string] }
const ROWS: Row[] = [
  { id: 'claude-done', title: 'Refactor the sync worker', state: 'done', selection: ['remote-cli-claude', 'p1/claude/sonnet'] },
  { id: 'openai-running', title: 'Generate the session title', state: 'ongoing', selection: ['remote-cli-codex', 'p1/codex/gpt-5.1-codex'] },
  { id: 'deepseek-warning', title: 'Waiting for approval', state: 'warning', selection: ['deepseek', 'deepseek-chat'] },
  { id: 'gemini-idle', title: 'Greeting', state: 'idle', selection: ['remote-cli-antigravity', 'p1/antigravity/gemini-3-pro'] },
  { id: 'qwen-schedule', title: 'Nightly report', state: 'idle', schedule: true, selection: ['dashscope', 'qwen3-coder-plus'] },
  { id: 'kimi-error', title: 'Failed run', state: 'error', selection: ['moonshot', 'kimi-k2'] },
  { id: 'generic-done', title: 'Local llama', state: 'done', selection: ['ollama', 'llama3.3'] },
  // Host builds that wrap the status dot must still get the corner badge, not a dot over the logo.
  { id: 'grok-wrapped', title: 'Install Git on this machine', state: 'done', wrapped: true, selection: ['remote-cli-grok', 'p1/grok/grok-4'] },
  // An idle row shows the host's leading slot; another plugin's remote-session mark fills the whole cell there.
  { id: 'openai-remote', title: 'Remote workspace chat', state: 'idle', remote: true, selection: ['remote-cli-codex', 'p1/codex/gpt-5.5'] },
  { id: 'unread-done', title: 'Never opened in this window', state: 'done' },
  { id: 'archived', title: 'Archived chat', state: 'done', archived: true, selection: ['anthropic', 'claude-opus-4-1'] },
];

function StateDot({ state }: { state: Row['state'] }) {
  if (state === 'ongoing') return <svg className="spinner" data-state="ongoing" width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
    <g><circle className="spinnerTrack" cx="12" cy="12" r="9.5" /><circle className="spinnerArc" cx="12" cy="12" r="9.5" /></g>
  </svg>;
  return <span className="dot" data-state={state} style={{ width: 10, height: 10 }} aria-hidden="true" />;
}
function SessionRow({ row }: { row: Row }) {
  const status = <><StateDot state={row.state} /><span className="vh">{row.state}</span></>;
  const remote = <div data-slot="sidebar.session.row.leading" style={{ display: 'contents' }}>
    <span data-dsh-remote-mark="" role="img" aria-label="Remote session" style={{ width: 16, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#2fb36b' }} />
    </span>
  </div>;
  const leading = row.remote ? remote : row.state !== 'idle'
    ? row.wrapped ? <span className="mark">{status}</span> : status
    : row.schedule && <span className="mark" data-session-schedule-mark=""><svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg><span className="vh">1 task</span></span>;
  return <div className="sessionRow" data-row-key={`session:${row.id}`} role="treeitem" aria-description={row.archived ? 'Archived' : undefined}>
    <span className="slot">{!row.archived && leading}</span>
    <span className="title">{row.title}</span>
    <span className="time">1m</span>
  </div>;
}

const selection = ([provider, model]: [string, string]) => ({ modelSelection: { lastUsed: null, next: { provider, model } } });
let list: SessionList = { projectionsBySession: Object.fromEntries(ROWS.filter(r => r.selection).map(r => [r.id, { state: 'idle', values: selection(r.selection!) }])) };
const listListeners = new Set<() => void>();
const refreshed: string[] = [];
const sessions: Sessions = {
  list: { getSnapshot: () => list, subscribe(listener) { listListeners.add(listener); return () => { listListeners.delete(listener); }; } },
  async refreshProjections(id) {
    refreshed.push(id);
    await new Promise(resolve => setTimeout(resolve, 50));
    const values = id === 'unread-done' ? selection(['xai', 'grok-4']) : {};
    list = { projectionsBySession: { ...list.projectionsBySession, [id]: { state: 'ready', values } } };
    for (const listener of listListeners) listener();
  },
};

let active = 'en', revision = 0;
const localeListeners = new Set<() => void>();
const locale = {
  register: () => () => {},
  subscribe(listener: () => void) { localeListeners.add(listener); return () => { localeListeners.delete(listener); }; },
  getSnapshot: () => ({ active, revision }),
};

let Hover: React.FC<{ sessionId: string }> | undefined;
const client = {
  get: (name: string) => name === 'locale' ? locale : undefined,
  effect: (factory: () => () => void) => { factory(); },
  slots: { inject: (_name: string, factory: () => void) => factory(), register: (_spec: unknown, component: React.FC<{ sessionId: string }>) => { Hover = component; } },
  inject: (_services: string[], factory: (scoped: unknown) => void) => factory({ ...client, sessions }),
};

const style = document.createElement('style'); style.textContent = HOST_CSS; document.head.append(style);
const container = document.createElement('div'); document.body.append(container);
const root = createRoot(container);
flushSync(() => root.render(<div className="sidebar" role="tree">{ROWS.map(row => <SessionRow key={row.id} row={row} />)}</div>));
apply(client as unknown as Parameters<typeof apply>[0]);
const hover = document.createElement('div'); document.body.append(hover);
createRoot(hover).render(<div className="hoverCard"><div className="hoverContent">
  <div className="hoverTitle">Refactor the sync worker</div>
  <div className="hoverTime">1 minute ago</div>
  {Hover && <Hover sessionId="claude-done" />}
  <div className="hoverStatus"><StateDot state="done" /><span>Completed</span></div>
</div></div>);

Object.assign(window, { fixture: {
  refreshed,
  setLocale(next: string) { active = next; revision++; for (const listener of localeListeners) listener(); },
} });
