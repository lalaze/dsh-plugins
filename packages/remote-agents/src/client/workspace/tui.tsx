import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CLAUDE_LAUNCHER } from '../../workspace/domain.js';
import { api } from '../api.js';
import { useCurrentModel } from '../composer/usage.js';
import { localizeError, ui, useLocale } from '../i18n.js';
import type { Client } from '../index.js';

/** The right sidebar terminal's slot key; its body is reused so the TUI looks and behaves like every DSH terminal. */
const TERMINAL_TAB = '@deepseek-ai/dsh-client-ui-sidebar-terminal', SHELL_KEY = 'dsh.terminal.shell';
const CACHE_KEY = 'remote-agents.tui.sessions', GENERATION_KEY = 'remote-agents.tui.generation';
const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces[/\\]/;
/** The chat provider of the remote Claude Code; only its models offer the TUI. */
const CLAUDE_PROVIDER = 'remote-cli-claude';
const TITLE_INTERVAL = 15_000;
/** Terminals beside a conversation stay small; this one is the conversation, so it reads at about the chat's size. */
const TUI_FONT_SIZE = 14;
/**
 * The terminal as the conversation area: a column as wide as the chat's, over whatever wallpaper the window has, up to
 * the window's edge rather than the chat's scrollbar gutter, as it scrolls by itself. Each
 * background is a literal rgba(): DSH hands the computed color to xterm, whose parser rejects other translucent forms,
 * and xterm drops the alpha to get the opaque color it checks text contrast against.
 */
const viewStyles = `div:has(>[data-slot="conversation.session"] [data-remote-agents-tui]){scrollbar-gutter:auto;margin-right:0}
[data-remote-agents-tui] [data-sidebar-terminal]{padding-top:0}
[data-remote-agents-tui] [data-sidebar-terminal]>div:has(>.xterm){background:rgba(255,255,255,.62)!important;-webkit-backdrop-filter:blur(18px) saturate(1.15);backdrop-filter:blur(18px) saturate(1.15);padding:18px max(24px,calc((100% - 1040px)/2))!important}
body[data-ds-dark-theme] [data-remote-agents-tui] [data-sidebar-terminal]>div:has(>.xterm){background:rgba(21,21,23,.62)!important}
[data-remote-agents-tui] .xterm-scrollable-element,[data-remote-agents-tui] .xterm-viewport,[data-remote-agents-tui] .xterm-screen{background:transparent!important}`;
const startStyles = `.ra-tui-start{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);outline:none;background:transparent;cursor:pointer}
.ra-tui-start:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ra-tui-start:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.ra-tui-start:disabled{cursor:default;opacity:.5}
.ra-tui-start[data-failed]{box-shadow:0 0 0 1px var(--dsw-alias-state-danger,#d64545)}`;

interface SlotEntry { component: unknown; options: { id?: string; key?: string } }
interface Slots {
  inject(name: string, factory: () => unknown): unknown;
  register(spec: Record<string, unknown>, component: React.FC<any>): unknown;
  entries(name: string): readonly SlotEntry[];
  subscribe(name: string, listener: () => void): () => void;
}
interface TerminalState { issue?: string; phase: string }
interface TerminalModel { state: { getSnapshot(): TerminalState; subscribe(listener: () => void): () => void } }
interface Terminals {
  view(sessionId: string, key: string, contentId: string, terminalId?: string, shellPath?: string): TerminalModel;
  launchShells(sessionId: string, signal: AbortSignal): Promise<{ shells: readonly { path: string; name: string }[] }>;
  close(sessionId: string, key: string, contentId: string): void;
}
interface Services {
  slots: Slots; terminals: Terminals; t: unknown; title(sessionId: string): string | undefined;
  theme: { getSnapshot(): unknown; subscribe(listener: () => void): () => void };
}
type SessionList = { getSnapshot(): { byId?: Record<string, { cwd?: string; blank?: boolean; title?: string }> }; subscribe(listener: () => void): () => void };

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage may be unavailable */ }
};

/** Which conversations are TUI ones. Cached in the browser: DSH picks the view and composer before any request returns. */
class TuiStore {
  private ids = new Set<string>();
  private readonly listeners = new Set<() => void>();
  constructor() {
    try { this.ids = new Set(JSON.parse(read(CACHE_KEY) ?? '[]') as string[]); } catch { /* a damaged cache only delays the view */ }
  }
  has = (id: string | undefined) => id !== undefined && this.ids.has(id);
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(ids: Iterable<string>) {
    this.ids = new Set(ids); write(CACHE_KEY, JSON.stringify([...this.ids]));
    for (const listener of this.listeners) listener();
  }
  add(id: string) { this.set([...this.ids, id]); }
}

const terminalKey = (generation: number) => `remote-agents-tui-${generation}`;
const terminalContent = (sessionId: string, generation: number) => `remote-agents-tui:${sessionId}:${generation}`;
const savedGeneration = (sessionId: string) => Number(read(`${GENERATION_KEY}.${sessionId}`)) || 0;

/**
 * Archiving a TUI conversation ends its Claude Code, as DSH ends nothing itself; unarchiving resumes it in a new terminal.
 * @param archived - DSH's archive set.
 * @param isTui - whether a conversation is a TUI one.
 * @param close - ends the conversation's terminal; a conversation with none is left alone.
 * @param closed - archived conversations already handled, kept between calls.
 */
export function closeArchived(archived: readonly string[], isTui: (id: string) => boolean, close: (id: string) => void, closed: Set<string>): void {
  for (const id of closed) if (!archived.includes(id)) closed.delete(id);
  for (const id of archived) if (isTui(id) && !closed.has(id)) { closed.add(id); close(id); }
}

type TerminalTheme = { fontSizes?: { terminal?: number } };
const enlarged = new WeakMap<object, unknown>();
/** The theme DSH's terminal reads its font from, at no less than the TUI's size. The same theme gives the same object, as the terminal compares them. */
export function tuiTheme(theme: unknown): unknown {
  const sizes = (theme as TerminalTheme | null)?.fontSizes;
  if (!sizes || typeof sizes.terminal !== 'number' || sizes.terminal >= TUI_FONT_SIZE) return theme;
  let result = enlarged.get(theme as object);
  if (!result) { result = { ...(theme as object), fontSizes: { ...sizes, terminal: TUI_FONT_SIZE } }; enlarged.set(theme as object, result); }
  return result;
}

/** A terminal that ended is replaced by a new one, so each generation names its own DSH terminal. */
function useGeneration(sessionId: string): [number, () => void] {
  const key = `${GENERATION_KEY}.${sessionId}`;
  const [generation, setGeneration] = useState(() => savedGeneration(sessionId));
  return [generation, () => setGeneration(value => { write(key, String(value + 1)); return value + 1; })];
}

function TuiTerminal({ sessionId, services, shell, generation, restart }: { sessionId: string; services: Services; shell: string; generation: number; restart: () => void }) {
  const { slots, terminals, theme, t } = services;
  const key = terminalKey(generation);
  const model = useMemo(() => terminals.view(sessionId, key, terminalContent(sessionId, generation), undefined, shell), [terminals, sessionId, key, generation, shell]);
  const state = useSyncExternalStore(model.state.subscribe.bind(model.state), () => model.state.getSnapshot());
  // DSH remembers the shell of every terminal it creates. Starting a TUI should not change what New terminal opens.
  useEffect(() => {
    const remembered = read(SHELL_KEY);
    const off = model.state.subscribe(() => {
      if (['idle', 'loading'].includes(model.state.getSnapshot().phase)) return;
      write(SHELL_KEY, remembered); off();
    });
    return off;
  }, [model]);
  // After DSH restarted the terminal is gone; a new one resumes the same Claude session.
  useEffect(() => { if (state.issue === 'missingTerminal') restart(); }, [state.issue]);
  const Body = slots.entries('sidebar.right.pane.tab').find(entry => entry.options.key === TERMINAL_TAB)?.component as React.FC<any> | undefined;
  if (!Body) return <div className="ra-empty" role="alert">{ui("DSH's terminal is not available")}</div>;
  return <Body view={() => model} t={t}
    useTabInfo={() => ({ tab: { id: key, visible: true, actions: { openTab: restart } } })}
    useTerminal={() => useSyncExternalStore(model.state.subscribe.bind(model.state), () => model.state.getSnapshot())}
    useTheme={(select: (value: unknown) => unknown) => select(tuiTheme(useSyncExternalStore(theme.subscribe, theme.getSnapshot)))} />;
}

/** The conversation area of a TUI conversation. */
function TuiView({ sessionId, services }: { sessionId: string; services: Services }) {
  useLocale();
  const [generation, restart] = useGeneration(sessionId);
  const root = useRef<HTMLDivElement>(null);
  // Claude Code titles the conversation after its first exchange, and may again later.
  useEffect(() => {
    const controller = new AbortController();
    const sync = () => {
      if (document.visibilityState === 'hidden') return;
      void api('tuiTitle', { sessionId, current: services.title(sessionId) }, controller.signal).catch(() => {});
    };
    sync();
    const timer = setInterval(sync, TITLE_INTERVAL);
    return () => { clearInterval(timer); controller.abort(); };
  }, [services, sessionId]);
  // Selecting the conversation is what starts typing in it. The terminal's own chunk loads late, so wait for its input.
  useEffect(() => {
    let frame = 0;
    const until = Date.now() + 5000;
    const focus = () => {
      const input = root.current?.querySelector<HTMLElement>('.xterm-helper-textarea');
      if (input) input.focus(); else if (Date.now() < until) frame = requestAnimationFrame(focus);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [sessionId, generation]);
  const [shell, setShell] = useState<string>(), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    services.terminals.launchShells(sessionId, controller.signal).then(({ shells }) => {
      const found = shells.find(item => item.name.replace(/\.cmd$/i, '') === CLAUDE_LAUNCHER);
      if (found) setShell(found.path); else setError(ui('The Remote Claude shell is not available in this conversation'));
    }, cause => { if (!controller.signal.aborted) setError(localizeError(cause instanceof Error ? cause.message : String(cause))); });
    return () => controller.abort();
  }, [services, sessionId]);
  return <div ref={root} data-remote-agents-tui="" style={{ flex: '1 1 0', minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <style>{viewStyles}</style>
    {shell ? <TuiTerminal key={generation} sessionId={sessionId} services={services} shell={shell} generation={generation} restart={restart} />
      : <div className="ra-empty" role={error ? 'alert' : 'status'} style={{ margin: 'auto' }}>{error || ui('Starting Claude Code…')}</div>}
  </div>;
}

/** Claude Code's mascot, as its terminal banner draws it: each column is one half of a character cell, each row half its height. */
function ClaudeMascot() {
  return <svg viewBox="0 0 16 10" width="24" height="15" aria-hidden="true" shapeRendering="crispEdges">
    <path fill="#D97757" d="M2 0h12v2H2zM2 2h2v2H2zM5 2h6v2H5zM12 2h2v2h-2zM0 4h16v2H0zM2 6h12v2H2zM3 8h1v2H3zM5 8h1v2H5zM10 8h1v2h-1zM12 8h1v2h-1z" />
    <path fill="#000" d="M4 2h1v2H4zM11 2h1v2h-1z" />
  </svg>;
}

/** Offered in a new conversation of a remote workspace while a remote Claude model is selected; DSH lists it once started. */
function StartButton({ sessionId, sessions, store }: { sessionId?: string; sessions: SessionList; store: TuiStore }) {
  useLocale();
  const session = useSyncExternalStore(sessions.subscribe, () => (sessionId === undefined ? undefined : sessions.getSnapshot()?.byId?.[sessionId]));
  const selection = useCurrentModel(sessionId);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (sessionId === undefined || !session?.blank || !session.cwd || !REMOTE_ANCHOR.test(session.cwd) || store.has(sessionId) || selection?.provider !== CLAUDE_PROVIDER) return null;
  const start = () => {
    setBusy(true); setError('');
    api('tuiStart', { sessionId, model: selection.model, effort: selection.reasoningEffort }).then(() => store.add(sessionId), cause => setError(localizeError(cause instanceof Error ? cause.message : String(cause)))).finally(() => setBusy(false));
  };
  return <><style>{startStyles}</style>
    <button type="button" className="ra-tui-start" data-remote-agents-tui-start="" data-failed={error ? '' : undefined} disabled={busy} onClick={start}
      aria-label={ui('Start in TUI')} title={error ? `${ui('Could not start the TUI')}: ${error}` : ui('Start this conversation in the Claude Code terminal interface')}>
      <ClaudeMascot />
    </button></>;
}

/**
 * Conversations that are the interactive Claude Code: a row in the workspace list, with the terminal as the conversation
 * area and no composer. DSH's chat view entry is swapped in place, as git-view's takeover does, so the tab row stays as it
 * is and DSH's chat is untouched elsewhere.
 */
export function installTuiSessions(ctx: Client): void {
  ctx.inject?.(['webTerminals', 'theme', 'sessions', 'locale', 'workspaces'], scoped => {
    const get = scoped.get as (name: string) => unknown;
    const slots = scoped.slots as unknown as Slots, terminals = get('webTerminals') as Terminals | undefined;
    const sessions = (get('sessions') as { list?: SessionList } | undefined)?.list;
    const themes = get('theme') as { getTheme(): unknown } | undefined;
    const workspaces = (get('workspaces') as { list?: { getSnapshot(): { archivedSessionIds?: readonly string[] } | undefined; subscribe(listener: () => void): () => void } } | undefined)?.list;
    const on = (scoped as unknown as { on(event: string, listener: () => void): () => void }).on;
    if (!terminals || !sessions || !themes || typeof slots.entries !== 'function' || typeof slots.subscribe !== 'function') return;
    const store = new TuiStore();
    const services: Services = { slots, terminals, title: id => sessions.getSnapshot()?.byId?.[id]?.title,
      t: (get('locale') as { bind(namespace: string): unknown }).bind('sidebarTerminal'),
      theme: { getSnapshot: () => themes.getTheme(), subscribe: listener => on.call(scoped, 'theme/change', listener) } };
    scoped.effect(() => {
      const controller = new AbortController();
      void api<{ sessions: string[] }>('tuiSessions', {}, controller.signal).then(value => store.set(value.sessions), () => {});
      return () => controller.abort();
    });
    slots.inject('conversation.view', () => {
      const taken = new Map<SlotEntry, { own: unknown; wrapper: React.FC<any> }>();
      const sync = () => {
        for (const entry of slots.entries('conversation.view')) {
          if (entry.options.id !== 'chat' || taken.has(entry)) continue;
          const Own = entry.component as React.FC<any>;
          const wrapper: React.FC<any> = props => {
            const tui = useSyncExternalStore(store.subscribe, () => store.has(props.sessionId));
            return tui ? <TuiView sessionId={props.sessionId} services={services} /> : <Own {...props} />;
          };
          taken.set(entry, { own: Own, wrapper });
          entry.component = wrapper;
        }
      };
      sync();
      const off = slots.subscribe('conversation.view', sync);
      return () => {
        off();
        for (const [entry, { own, wrapper }] of taken) if (entry.component === wrapper) entry.component = own;
        taken.clear();
      };
    });
    if (workspaces) scoped.effect(() => {
      const closed = new Set<string>();
      const sync = () => closeArchived(workspaces.getSnapshot()?.archivedSessionIds ?? [], store.has, id => {
        const generation = savedGeneration(id);
        terminals.close(id, terminalKey(generation), terminalContent(id, generation));
      }, closed);
      sync();
      const offWorkspaces = workspaces.subscribe(sync), offStore = store.subscribe(sync);
      return () => { offWorkspaces(); offStore(); };
    });
    // DSH elects the composer when its slot changes, so registering again makes it look at the current TUI list.
    const hideComposer = () => slots.inject('conversation.composer', () => slots.register({ name: 'conversation.composer', select: ({ sessionId }: { sessionId?: string }) => (store.has(sessionId) ? true : null) }, () => null)) as (() => void) | undefined;
    scoped.effect(() => {
      let release = hideComposer();
      const off = store.subscribe(() => { release?.(); release = hideComposer(); });
      return () => { off(); release?.(); };
    });
    slots.inject('conversation.input.left', () => slots.register({ name: 'conversation.input.left', id: 'remote-agents-tui-start', order: 90 },
      (props: { sessionId?: string }) => <StartButton sessionId={props.sessionId} sessions={sessions} store={store} />));
  });
}
