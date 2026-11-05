import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TUI_LAUNCHERS, type TuiCli } from '../../workspace/domain.js';
import { api } from '../api.js';
import { useCurrentModel } from '../composer/usage.js';
import { localizeError, ui, useLocale } from '../i18n.js';
import type { Client } from '../index.js';
import { fileStyles, sendTuiFile, TuiDropTarget, TuiFileStatus, TuiUploads, useFilePaste, useUploadedPaths } from './tui-files.js';
import { restoreRemoteTerminals } from './terminal-restore.js';
import { useTeamLine } from './tui-team.js';

/** The right sidebar terminal's slot key; its body is reused so the TUI looks and behaves like every DSH terminal. */
const TERMINAL_TAB = '@deepseek-ai/dsh-client-ui-sidebar-terminal', SHELL_KEY = 'dsh.terminal.shell';
const CACHE_KEY = 'remote-agents.tui.sessions', CODEX_CACHE_KEY = 'remote-agents.tui.codex', GENERATION_KEY = 'remote-agents.tui.generation';
const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces[/\\]/;
const CLI_NAMES: Record<TuiCli, string> = { claude: 'Claude Code', codex: 'Codex' };
/** Only these chat providers' models offer the TUI. */
const PROVIDER_CLIS: Record<string, TuiCli | undefined> = { 'remote-cli-claude': 'claude', 'remote-cli-codex': 'codex' };
const TITLE_INTERVAL = 15_000;
/**
 * A terminal cell is about 0.6em wide, so a Chinese glyph (1em) leaves a gap in its two cells (1.2em) and the text reads
 * spaced out. The usual fix is a font drawn 2:1, which every machine would have to install. This scales the system's
 * own CJK font to nearly fill the cells instead, for these characters only.
 */
const CJK_FONT = 'RA TUI CJK', CJK_SCALE = '112%';
const CJK_RANGE = 'U+2E80-2FDF,U+3000-30FF,U+3100-312F,U+31A0-31BF,U+3400-4DBF,U+4E00-9FFF,U+AC00-D7AF,U+F900-FAFF,U+FE30-FE4F,U+FF00-FFEF,U+20000-2FFFF';
const cjkFace = (weight: number, faces: string[]) => `@font-face{font-family:"${CJK_FONT}";font-weight:${weight};size-adjust:${CJK_SCALE};unicode-range:${CJK_RANGE};src:${faces.map(face => `local("${face}")`).join(',')}}`;
/**
 * The terminal as the conversation area: a centered column over a faint trace of whatever wallpaper the window has (more
 * than this and a busy image turns the background muddy), up to
 * the window's edge rather than the chat's scrollbar gutter, as it scrolls by itself. Each
 * background is a literal rgba(): DSH hands the computed color to xterm, whose parser rejects other translucent forms,
 * and xterm drops the alpha to get the opaque color it checks text contrast against.
 */
const viewStyles = `${cjkFace(400, ['PingFang SC', 'PingFang SC Regular', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Hiragino Sans GB'])}
${cjkFace(700, ['PingFang SC Semibold', 'Microsoft YaHei Bold', 'Noto Sans CJK SC Bold', 'Hiragino Sans GB W6'])}
div:has(>[data-slot="conversation.session"] [data-remote-agents-tui]){scrollbar-gutter:auto;margin-right:0}
[data-remote-agents-tui] [data-sidebar-terminal]{padding-top:0}
[data-remote-agents-tui] [data-sidebar-terminal]>div:has(>.xterm){background:rgba(255,255,255,.92)!important;-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);padding:18px max(24px,calc((100% - 900px)/2))!important}
body[data-ds-dark-theme] [data-remote-agents-tui] [data-sidebar-terminal]>div:has(>.xterm){background:rgba(21,21,23,.92)!important}
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
interface TerminalState { issue?: string; phase: string; writable?: boolean }
interface TerminalModel { state: { getSnapshot(): TerminalState; subscribe(listener: () => void): () => void } }
interface Terminals {
  view(sessionId: string, key: string, contentId: string, terminalId?: string, shellPath?: string): TerminalModel;
  launchShells(sessionId: string, signal: AbortSignal): Promise<{ shells: readonly { path: string; name: string }[] }>;
  close(sessionId: string, key: string, contentId: string): void;
}
interface Services {
  slots: Slots; terminals: Terminals; uploads: TuiUploads; t: unknown; title(sessionId: string): string | undefined; cli(sessionId: string): TuiCli;
  theme: { getSnapshot(): unknown; subscribe(listener: () => void): () => void };
}
type SessionList = { getSnapshot(): { byId?: Record<string, { cwd?: string; blank?: boolean; title?: string }> }; subscribe(listener: () => void): () => void };

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage may be unavailable */ }
};

/** Which conversations are TUI ones, and which of them run Codex. Cached in the browser: DSH picks the view and composer before any request returns. */
class TuiStore {
  private ids = new Set<string>();
  private codex = new Set<string>();
  private readonly listeners = new Set<() => void>();
  constructor() {
    try {
      this.ids = new Set(JSON.parse(read(CACHE_KEY) ?? '[]') as string[]);
      this.codex = new Set(JSON.parse(read(CODEX_CACHE_KEY) ?? '[]') as string[]);
    } catch { /* a damaged cache only delays the view */ }
  }
  has = (id: string | undefined) => id !== undefined && this.ids.has(id);
  cli = (id: string): TuiCli => (this.codex.has(id) ? 'codex' : 'claude');
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(ids: Iterable<string>, codex: Iterable<string> = []) {
    this.ids = new Set(ids); this.codex = new Set(codex);
    write(CACHE_KEY, JSON.stringify([...this.ids])); write(CODEX_CACHE_KEY, JSON.stringify([...this.codex]));
    for (const listener of this.listeners) listener();
  }
  add(id: string, cli: TuiCli) { this.set([...this.ids, id], cli === 'codex' ? [...this.codex, id] : this.codex); }
}

const terminalKey = (generation: number) => `remote-agents-tui-${generation}`;
const terminalContent = (sessionId: string, generation: number) => `remote-agents-tui:${sessionId}:${generation}`;
const savedGeneration = (sessionId: string) => Number(read(`${GENERATION_KEY}.${sessionId}`)) || 0;

/**
 * Archiving a TUI conversation ends its CLI, as DSH ends nothing itself; unarchiving resumes it in a new terminal.
 * @param archived - DSH's archive set.
 * @param isTui - whether a conversation is a TUI one.
 * @param close - ends the conversation's terminal; a conversation with none is left alone.
 * @param closed - archived conversations already handled, kept between calls.
 */
export function closeArchived(archived: readonly string[], isTui: (id: string) => boolean, close: (id: string) => void, closed: Set<string>): void {
  for (const id of closed) if (!archived.includes(id)) closed.delete(id);
  for (const id of archived) if (isTui(id) && !closed.has(id)) { closed.add(id); close(id); }
}

type TerminalTheme = { fontFamilies?: { terminal?: string } };
const withCjk = new WeakMap<object, unknown>();
/** The theme DSH's terminal reads its fonts from, with the scaled CJK font ahead of DSH's own stack. The same theme gives the same object, as the terminal compares them. */
export function tuiTheme(theme: unknown): unknown {
  const families = (theme as TerminalTheme | null)?.fontFamilies;
  if (!families) return theme;
  let result = withCjk.get(theme as object);
  if (!result) {
    result = { ...(theme as object), fontFamilies: { ...families, terminal: [families.terminal, `"${CJK_FONT}"`].filter(Boolean).join(', ') } };
    withCjk.set(theme as object, result);
  }
  return result;
}

/** A terminal that ended is replaced by a new one, so each generation names its own DSH terminal. */
function useGeneration(sessionId: string): [number, () => void] {
  const key = `${GENERATION_KEY}.${sessionId}`;
  const [generation, setGeneration] = useState(() => savedGeneration(sessionId));
  return [generation, () => setGeneration(value => { write(key, String(value + 1)); return value + 1; })];
}

function TuiTerminal({ root, sessionId, services, shell, generation, restart }: { root: React.RefObject<HTMLElement | null>; sessionId: string; services: Services; shell: string; generation: number; restart: () => void }) {
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
  // After DSH restarted the terminal is gone; a new one resumes the same CLI session.
  useEffect(() => { if (state.issue === 'missingTerminal') restart(); }, [state.issue]);
  useUploadedPaths(root, sessionId, services.uploads, model.state, services.cli(sessionId));
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
  const cli = services.cli(sessionId);
  const [generation, restart] = useGeneration(sessionId);
  const root = useRef<HTMLDivElement>(null);
  useFilePaste(root, picked => services.uploads.add(sessionId, picked));
  // Typed in the terminal, /team reaches DSH rather than the CLI, which has no such command.
  useTeamLine(root, async line => { await api('tuiTeam', { sessionId, line }); }, message => services.uploads.report(sessionId, message));
  const [reports, setReports] = useState(0);
  // The CLI's title comes after the first exchange, and may change later.
  useEffect(() => {
    const controller = new AbortController();
    const sync = () => {
      if (document.visibilityState === 'hidden') return;
      void api<{ waiting?: number }>('tuiTitle', { sessionId, current: services.title(sessionId) }, controller.signal).then(value => setReports(value.waiting ?? 0), () => {});
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
  // xterm measures each character once, so the font has to be there before the terminal opens. A machine without any of
  // the faces just uses its usual fallback.
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let alive = true;
    const ready = () => { if (alive) setFontReady(true); };
    const timer = setTimeout(ready, 1000);
    void Promise.all(['400', '700'].map(weight => document.fonts?.load(`${weight} 13px "${CJK_FONT}"`, '中'))).then(ready, ready);
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // What the launcher reads to give the CLI the team tools has to be there first. The CLI starts without them on a failure.
    Promise.all([services.terminals.launchShells(sessionId, controller.signal), api('tuiPrepare', { sessionId }, controller.signal).catch(() => {})]).then(([{ shells }]) => {
      const found = shells.find(item => item.name.replace(/\.cmd$/i, '') === TUI_LAUNCHERS[cli]);
      if (found) setShell(found.path); else setError(ui('The {shell} shell is not available in this conversation', { shell: TUI_LAUNCHERS[cli] }));
    }, cause => { if (!controller.signal.aborted) setError(localizeError(cause instanceof Error ? cause.message : String(cause))); });
    return () => controller.abort();
  }, [services, sessionId]);
  return <div ref={root} data-remote-agents-tui="" style={{ position: 'relative', flex: '1 1 0', minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <style>{viewStyles}{fileStyles}</style>
    {shell && fontReady ? <TuiTerminal key={generation} root={root} sessionId={sessionId} services={services} shell={shell} generation={generation} restart={restart} />
      : <div className="ra-empty" role={error ? 'alert' : 'status'} style={{ margin: 'auto' }}>{error || ui('Starting {cli}…', { cli: CLI_NAMES[cli] })}</div>}
    <TuiFileStatus sessionId={sessionId} uploads={services.uploads} notice={reports ? ui('Team messages waiting for an empty prompt: {count}', { count: reports }) : undefined} />
  </div>;
}

/** Claude Code's mascot, as its terminal banner draws it: each column is one half of a character cell, each row half its height. */
function ClaudeMascot({ width = 24 }: { width?: number }) {
  return <svg viewBox="0 0 16 10" width={width} height={width * 10 / 16} aria-hidden="true" shapeRendering="crispEdges">
    <path fill="#D97757" d="M2 0h12v2H2zM2 2h2v2H2zM5 2h6v2H5zM12 2h2v2h-2zM0 4h16v2H0zM2 6h12v2H2zM3 8h1v2H3zM5 8h1v2H5zM10 8h1v2h-1zM12 8h1v2h-1z" />
    <path fill="#000" d="M4 2h1v2H4zM11 2h1v2h-1z" />
  </svg>;
}

/**
 * Codex's logo, from @lobehub/icons-static-svg (see THIRD_PARTY_NOTICES.md): the outline of its single-color version in the
 * colors of its full-color one, without that one's white plate, with the prompt white as in Codex's own app icon.
 */
function CodexMark({ size }: { size: number }) {
  // Each its own: a gradient inside a hidden copy of the button would leave the others with none.
  const gradient = `ra-codex-${useId().replace(/\W/g, '')}`;
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <defs><linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="0" y2="24"><stop stopColor="#B1A7FF" /><stop offset=".5" stopColor="#7A9DFF" /><stop offset="1" stopColor="#3941FF" /></linearGradient></defs>
    <path fill={`url(#${gradient})`} d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457z" />
    <path fill="#fff" d="M7.282 8.307a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
  </svg>;
}
/** @param large - for the drop notice rather than the button. */
const CliMark = ({ cli, large = false }: { cli: TuiCli; large?: boolean }) => (cli === 'codex' ? <CodexMark size={large ? 72 : 20} /> : <ClaudeMascot width={large ? 96 : 24} />);

/** Offered in a new conversation of a remote workspace while a remote Claude or Codex model is selected; DSH lists it once started. */
function StartButton({ sessionId, sessions, store }: { sessionId?: string; sessions: SessionList; store: TuiStore }) {
  useLocale();
  const session = useSyncExternalStore(sessions.subscribe, () => (sessionId === undefined ? undefined : sessions.getSnapshot()?.byId?.[sessionId]));
  const selection = useCurrentModel(sessionId);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const cli = selection ? PROVIDER_CLIS[selection.provider] : undefined;
  if (sessionId === undefined || !session?.blank || !session.cwd || !REMOTE_ANCHOR.test(session.cwd) || store.has(sessionId) || !selection || !cli) return null;
  const start = () => {
    setBusy(true); setError('');
    api('tuiStart', { sessionId, cli, model: selection.model, effort: selection.reasoningEffort }).then(() => store.add(sessionId, cli), cause => setError(localizeError(cause instanceof Error ? cause.message : String(cause)))).finally(() => setBusy(false));
  };
  return <><style>{startStyles}</style>
    <button type="button" className="ra-tui-start" data-remote-agents-tui-start="" data-failed={error ? '' : undefined} disabled={busy} onClick={start}
      aria-label={ui('Start in TUI')} title={error ? `${ui('Could not start the TUI')}: ${error}` : ui('Start this conversation in the {cli} terminal interface', { cli: CLI_NAMES[cli] })}>
      <CliMark cli={cli} />
    </button></>;
}

/**
 * Conversations that are the interactive Claude Code or Codex: a row in the workspace list, with the terminal as the conversation
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
    scoped.effect(() => restoreRemoteTerminals(terminals));
    const store = new TuiStore();
    const services: Services = { slots, terminals, uploads: new TuiUploads(sendTuiFile), cli: store.cli, title: id => sessions.getSnapshot()?.byId?.[id]?.title,
      t: (get('locale') as { bind(namespace: string): unknown }).bind('sidebarTerminal'),
      theme: { getSnapshot: () => themes.getTheme(), subscribe: listener => on.call(scoped, 'theme/change', listener) } };
    scoped.effect(() => {
      const controller = new AbortController();
      void api<{ sessions: string[]; codex?: string[] }>('tuiSessions', {}, controller.signal).then(value => store.set(value.sessions, value.codex), () => {});
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
        void api('tuiEnd', { sessionId: id }).catch(() => {});
      }, closed);
      sync();
      const offWorkspaces = workspaces.subscribe(sync), offStore = store.subscribe(sync);
      return () => { offWorkspaces(); offStore(); };
    });
    // DSH elects the composer when its slot changes, so registering again makes it look at the current TUI list.
    const NoComposer = ({ sessionId }: { sessionId: string }) => <TuiDropTarget sessionId={sessionId} uploads={services.uploads} cli={CLI_NAMES[store.cli(sessionId)]} icon={<CliMark cli={store.cli(sessionId)} large />} />;
    const hideComposer = () => slots.inject('conversation.composer', () => slots.register({ name: 'conversation.composer', select: ({ sessionId }: { sessionId?: string }) => (store.has(sessionId) ? true : null) }, NoComposer)) as (() => void) | undefined;
    scoped.effect(() => {
      let release = hideComposer();
      const off = store.subscribe(() => { release?.(); release = hideComposer(); });
      return () => { off(); release?.(); };
    });
    slots.inject('conversation.input.left', () => slots.register({ name: 'conversation.input.left', id: 'remote-agents-tui-start', order: 90 },
      (props: { sessionId?: string }) => <StartButton sessionId={props.sessionId} sessions={sessions} store={store} />));
  });
}
