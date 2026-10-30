import React from 'react';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { languageOf } from '@dsh-plugins/file-view/kinds';
import { installDecorations } from './decorations.js';
import { DiffTab, fileAddress, sessionFileAddress } from './diff-tab.js';
import { ComposerBridge } from './dock.js';
import { installLocale, ui, useLocale } from './i18n.js';
import { GitArtwork } from './icons.js';
import { GitPanel } from './panel.js';
import { cwdOf, rootsInView, setSessions, useCwd, type Sessions } from './sessions.js';
import { StatusCache } from './status.js';
import { styles } from './styles.js';
import { takeOverGitPanel, type ViewSlots } from './takeover.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  inject?(services: string[], factory: (scoped: Client) => void): unknown;
  slots: ViewSlots & { inject(name: string, factory: () => unknown): unknown };
}
type Definition = Record<string, unknown> & { id: string; kind: string };
interface Tabs { register(definition: Definition): () => void; candidates?(address: string): readonly unknown[] }
interface Previews {
  register(definition: Record<string, unknown>): () => void;
  getSnapshot(): readonly { id: string; priority?: string; extensions: readonly string[] }[];
  subscribe?(listener: () => void): () => void;
}
type OpenResource = (address: string, options?: Record<string, unknown>) => void;
interface SidebarRight { openResource: OpenResource }
type TabProps = { sessionId: string; useTabInfo(): { tab: { navigation: { address: string; revision?: number }; actions?: { openResource?(address: string, options?: Record<string, unknown>): void } } } };

/** The tab kinds this plugin adds: the Git view, and a changed file's diff. */
export const GIT_KIND = 'git-view/git', DIFF_KIND = 'git-view/diff', PREVIEW_ID = 'git-view/preview';
/** In DSH's own file preview, the diff is one of the viewers to choose from for these code and text files. */
const PREVIEW_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'dart', 'lua', 'pl', 'r',
  'scala', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'sql', 'graphql', 'proto', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'md', 'markdown'];
/** Local status refreshes this often while DSH is visible; remote status is fresh for longer, see status.ts. */
const POLL_MS = 4000;
const cache = new StatusCache();

/** The Git view of the conversation the tab belongs to; a changed file opens its diff beside it. */
function GitTab({ sessionId, openResource }: { sessionId: string; openResource: OpenResource }) {
  useLocale();
  const cwd = useCwd(sessionId);
  const openDiff = (path: string) => { openResource(sessionFileAddress(sessionId, path), { kind: DIFF_KIND }); return true; };
  return <><style>{styles}</style>{cwd
    ? <GitPanel key={`${sessionId}\0${cwd}`} sessionId={sessionId} cwd={cwd} cache={cache} openDiff={openDiff} />
    : <div className="gv"><div className="gv-head"><span>Git</span></div><p className="gv-empty">{ui('Open a conversation in a project folder to see its Git repository')}</p></div>}</>;
}
/** A changed file is a diff only while Git reports it changed; DSH's other viewers keep every other file. */
const claims = (address: string) => {
  const parsed = fileAddress(address), cwd = parsed && cwdOf(parsed.sessionId);
  if (!parsed || !cwd || languageOf(parsed.path) === undefined) return false;
  if (!cache.known(cwd)) void cache.ensure(cwd);
  return cache.isChanged(cwd, parsed.path);
};

export const name = 'dsh-git-view-client';
// The desktop language bridge initializes asynchronously; wait for it before registering UI.
export const inject = ['slots', 'locale'];
/**
 * Git for each conversation's workspace, on this machine or on a Remote Agents remote machine: a Git tab in the right
 * sidebar, diffs of changed files and change marks in file lists. In Remote Agents workspaces it also stands in for
 * dsh-git-panel's tab, see takeover.tsx.
 */
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  ctx.inject?.(['sessions'], scoped => {
    const sessions = (scoped as { get?(name: string): unknown }).get?.('sessions') as Sessions | undefined;
    if (!sessions?.list) return;
    scoped.effect(() => {
      setSessions(sessions);
      const refresh = () => { if (document.visibilityState === 'visible') for (const root of new Set([...rootsInView(), ...cache.active()])) void cache.ensure(root); };
      const off = sessions.list.subscribe(refresh), timer = setInterval(refresh, POLL_MS);
      window.addEventListener('focus', refresh);
      const marks = installDecorations(cache, root => { void cache.ensure(root); });
      refresh();
      return () => { off(); clearInterval(timer); window.removeEventListener('focus', refresh); marks(); setSessions(undefined); };
    });
  });
  ctx.inject?.(['sidebarRightTabs', 'sidebarRight', 'sessions'], scoped => {
    const tabs = (scoped as { get?(name: string): unknown }).get?.('sidebarRightTabs') as Tabs | undefined;
    const sidebar = (scoped as { get?(name: string): unknown }).get?.('sidebarRight') as SidebarRight | undefined;
    if (!tabs || typeof tabs.register !== 'function' || typeof sidebar?.openResource !== 'function') return;
    // Tab-local actions discard `kind` on supported DSH hosts. The public navigator preserves the explicit viewer.
    // Called synchronously from the visible tab's click, so its active conversation/pane supplies placement.
    const openResource: OpenResource = (address, options) => sidebar.openResource(address, options);
    /** The viewer DSH would use for the file without this plugin, for "Open the file". */
    const viewer = (address: string) => {
      for (const candidate of tabs.candidates?.(address) ?? []) {
        const kind = typeof candidate === 'string' ? candidate : (candidate as { kind?: unknown } | undefined)?.kind;
        if (typeof kind === 'string' && kind !== DIFF_KIND) return kind;
      }
    };
    scoped.effect(() => {
      const disposers = [
        tabs.register({ id: GIT_KIND, kind: GIT_KIND, priority: 'extension', title: () => 'Git',
          guide: [{ id: 'git-view', order: 12, title: () => ui('Git'), description: () => ui('Branches, commits, changes and conflicts'), icon: GitArtwork }] }),
        // A longer pattern than other file viewers', so a changed file opens as its diff.
        tabs.register({ id: DIFF_KIND, kind: DIFF_KIND, priority: 'extension', patterns: ['dsh-resource://file/session/**'], canOpen: claims,
          title: (address: string) => `± ${fileAddress(address)?.path.split('/').pop() ?? ui('Changes')}` }),
      ];
      return () => { for (const dispose of disposers) dispose(); };
    });
    scoped.slots.inject('sidebar.right.pane.tab', () => {
      const Git: React.FC<TabProps> = props => <GitTab {...props} openResource={openResource} />;
      const Diff: React.FC<TabProps> = ({ useTabInfo }) => {
        const { tab } = useTabInfo();
        return <DiffTab key={tab.navigation.address} address={tab.navigation.address} revision={tab.navigation.revision} cache={cache} tools={{ ...tab.actions, openResource }} viewers={viewer} />;
      };
      const disposers = [scoped.slots.register({ name: 'sidebar.right.pane.tab', key: GIT_KIND }, Git), scoped.slots.register({ name: 'sidebar.right.pane.tab', key: DIFF_KIND }, Diff)];
      return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose(); };
    });
    scoped.slots.inject('conversation.view', () => takeOverGitPanel(scoped.slots, ({ sessionId }) => <GitTab sessionId={sessionId} openResource={openResource} />));
  });
  // DSH's file preview offers the diff among its viewers, also for a file whose changes are not known yet.
  ctx.inject?.(['documentPreviews'], scoped => {
    const previews = (scoped as { get?(name: string): unknown }).get?.('documentPreviews') as Previews | undefined;
    if (!previews || typeof previews.register !== 'function' || typeof previews.getSnapshot !== 'function') return;
    scoped.effect(() => {
      // An alternative only: offered for suffixes DSH's own viewers show, in their band and registered after them, so it is
      // never the viewer a file opens with. The extension band would rank it first for every such file.
      let registered: (() => void) | undefined, offered = '';
      const update = () => {
        const builtin = new Set(previews.getSnapshot().filter(d => d.id !== PREVIEW_ID && d.priority === 'builtin').flatMap(d => d.extensions));
        const extensions = PREVIEW_EXTENSIONS.filter(extension => builtin.has(extension));
        if (extensions.join() === offered) return;
        offered = extensions.join(); registered?.();
        registered = extensions.length ? previews.register({ id: PREVIEW_ID, extensions, priority: 'builtin', title: () => ui('Git diff'), loading: 'text-pages', wrap: true }) : undefined;
      };
      update();
      const off = previews.subscribe?.(update);
      return () => { off?.(); registered?.(); };
    });
    scoped.slots.inject('sidebar.right.tab.document', () => scoped.slots.register({ name: 'sidebar.right.tab.document', key: PREVIEW_ID },
      ({ resourceAddress }: { resourceAddress?: string }) => resourceAddress ? <DiffTab key={resourceAddress} address={resourceAddress} cache={cache} /> : null));
  });
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'git-view-composer', order: 100 }, ComposerBridge));
}
