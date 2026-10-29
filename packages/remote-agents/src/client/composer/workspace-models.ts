import { symbols } from '@deepseek-ai/cordis';
import { api } from '../api.js';
import { ui } from '../i18n.js';

interface Selection { provider: string; model: string; reasoningEffort?: string }
interface Snapshot {
  current: Selection | null;
  groups: readonly { id: string; models: readonly { id: string }[] }[];
  failures?: readonly { id: string }[];
  routable?: boolean | null; status?: string; error?: string | null; retainedEffort?: string;
}
export interface Directory {
  store: { getSnapshot(): Snapshot; subscribe(listener: () => void): () => void };
  load(): Promise<unknown>; select(selection: Selection): Promise<unknown>;
  disposed?: boolean;
}
export interface Admission { hostIds: string[] }
const remote = (provider: string) => provider === 'remote-cli' || provider.startsWith('remote-cli-');
const unavailable = () => ui('This remote model does not belong to the current workspace machine. Select a matching workspace and model.');

/** One session's filtered view, shared by the native picker and /model. Never changes the host catalog. */
export function workspaceDirectory<D extends Directory>(source: D, options: { key(): string; check(signal: AbortSignal): Promise<Admission> }) {
  let disposed = false, key = options.key(), admission: Admission | undefined, request: AbortController | undefined;
  let pending: Promise<Admission | undefined> | undefined;
  let previous: { source: Snapshot; admission?: Admission; key: string; pending: boolean; value: Snapshot } | undefined;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const off = source.store.subscribe(publish);
  const allowed = (selection: Selection, accepted: Admission | undefined) => !remote(selection.provider) || !!accepted?.hostIds.includes(selection.model.split('/')[0]);
  const currentAdmission = () => key === options.key() ? admission : undefined;
  const getSnapshot = (): Snapshot => {
    const snapshot = source.store.getSnapshot(), accepted = currentAdmission(), currentKey = options.key(), checking = !!pending;
    if (disposed) return snapshot;
    if (previous && previous.source === snapshot && previous.admission === accepted && previous.key === currentKey && previous.pending === checking) return previous.value;
    const groups = snapshot.groups.flatMap(group => {
      if (!remote(group.id)) return [group];
      const models = group.models.filter(model => allowed({ provider: group.id, model: model.id }, accepted));
      return models.length ? [{ ...group, models }] : [];
    });
    const blocked = snapshot.current && remote(snapshot.current.provider) && !groups.some(group => group.id === snapshot.current!.provider && group.models.some(model => model.id === snapshot.current!.model));
    const value: Snapshot = { ...snapshot, groups,
      ...(snapshot.failures ? { failures: snapshot.failures.filter(failure => !remote(failure.id) || !!accepted?.hostIds.length) } : {}),
      ...(blocked ? { current: null, retainedEffort: undefined, routable: false, error: checking ? null : unavailable() } : {}),
      ...(checking && !accepted ? { status: 'loading' } : {}),
    };
    previous = { source: snapshot, admission: accepted, key: currentKey, pending: checking, value }; return value;
  };
  const invalidate = () => {
    request?.abort(); request = undefined; pending = undefined; admission = undefined; previous = undefined; publish();
  };
  const refresh = (): Promise<Admission | undefined> => {
    if (disposed) return Promise.resolve(undefined);
    const nextKey = options.key();
    if (pending && key === nextKey) return pending;
    request?.abort();
    if (key !== nextKey) admission = undefined;
    key = nextKey;
    const controller = new AbortController(); request = controller;
    pending = (async () => {
      let result: Admission;
      try {
        result = await options.check(controller.signal);
        if (!result || !Array.isArray(result.hostIds) || !result.hostIds.every(id => typeof id === 'string' && id.length > 0)) throw new Error('Invalid workspace admission');
      } catch { result = { hostIds: [] }; }
      if (disposed || controller.signal.aborted || request !== controller || key !== options.key()) return undefined;
      admission = result; request = undefined; pending = undefined; publish(); return result;
    })();
    publish(); return pending;
  };
  const load = async () => {
    await Promise.all([source.load(), refresh()]);
    while (!disposed && (key !== options.key() || pending)) await refresh();
    return getSnapshot();
  };
  const select = async (selection: Selection) => {
    if (remote(selection.provider)) {
      const accepted = await refresh();
      if (disposed || !accepted || accepted !== currentAdmission() || !allowed(selection, accepted)) {
        return { ok: false, error: { code: 'remote/workspace-mismatch', message: unavailable() } };
      }
    }
    return source.select(selection);
  };
  const store = { ...source.store, getSnapshot, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const view = new Proxy(source, { get(target, property) {
    if (property === 'store') return store;
    if (property === 'load') return load;
    if (property === 'select') return select;
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { view, refresh, invalidate,
    changed() { if (!disposed && key !== options.key()) void refresh(); },
    dispose() { if (disposed) return; disposed = true; off(); invalidate(); listeners.clear(); },
  };
}

export interface WorkspaceClient {
  effect(factory: () => () => void): void;
  modelDirectories: { directoryFor(sessionId: string): Directory };
  sessions: { list: { getSnapshot(): { byId: Record<string, { cwd?: string }> } | undefined; subscribe(listener: () => void): () => void } };
  workspaces: { list: { getSnapshot(): { items: readonly { path: string; workspaceId: string }[] } | undefined; subscribe(listener: () => void): () => void } };
}
export function installWorkspaceModels(ctx: WorkspaceClient): void {
  ctx.effect(() => {
    const scoped = ctx.modelDirectories;
    const resolver = (scoped as unknown as Record<symbol, typeof scoped>)[symbols.original] ?? scoped;
    const original = resolver.directoryFor, views = new Map<string, { source: Directory; wrapper: ReturnType<typeof workspaceDirectory> }>();
    const directoryFor = (id: string) => {
      const source = original.call(resolver, id), previous = views.get(id);
      if (previous?.source === source) return previous.wrapper.view;
      previous?.wrapper.dispose();
      const wrapper = workspaceDirectory(source, {
        key: () => {
          const cwd = ctx.sessions.list.getSnapshot()?.byId[id]?.cwd;
          const workspace = ctx.workspaces.list.getSnapshot()?.items.filter(row => cwd === row.path || cwd?.startsWith(row.path.endsWith('/') ? row.path : `${row.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
          return JSON.stringify([cwd, workspace?.workspaceId, workspace?.path]);
        },
        check: signal => api<Admission>('workspaceModels', { sessionId: id }, signal),
      });
      views.set(id, { source, wrapper }); void wrapper.refresh(); return wrapper.view;
    };
    resolver.directoryFor = directoryFor;
    const visit = (update: (entry: ReturnType<typeof workspaceDirectory>) => void) => {
      for (const [id, entry] of views) {
        if (entry.source.disposed) { entry.wrapper.dispose(); views.delete(id); } else update(entry.wrapper);
      }
    };
    const changed = () => visit(view => view.changed());
    const refresh = () => visit(view => { view.invalidate(); void view.refresh(); });
    const offSession = ctx.sessions.list.subscribe(changed), offWorkspace = ctx.workspaces.list.subscribe(changed);
    const events = ['focus', 'remote-agents-updated', 'omc-remote-workspaces', 'omc-ssh-boxes'];
    for (const event of events) window.addEventListener(event, refresh);
    return () => {
      if (resolver.directoryFor === directoryFor) resolver.directoryFor = original;
      offSession(); offWorkspace(); for (const event of events) window.removeEventListener(event, refresh);
      for (const { wrapper } of views.values()) wrapper.dispose(); views.clear();
    };
  });
}
