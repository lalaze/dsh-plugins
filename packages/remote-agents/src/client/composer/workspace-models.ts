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

/**
 * What a new conversation runs when the model it inherited cannot run in its workspace. On a remote machine: the same CLI
 * and model there, that CLI's first, any CLI there. Otherwise, or with none of those: the last local model, the first local one.
 */
export function fallbackModel(groups: Snapshot['groups'], current: Selection, accepted: Admission, lastLocal?: Selection): Selection | undefined {
  const tail = (model: string) => model.split('/').slice(1).join('/');
  const local = groups.filter(group => !remote(group.id));
  if (accepted.hostIds.length) {
    const here = groups.filter(group => remote(group.id) && group.models.length);
    const same = here.find(group => group.id === current.provider);
    const match = same?.models.find(model => tail(model.id) === tail(current.model));
    if (match) return { provider: current.provider, model: match.id, ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}) };
    const group = same ?? here[0];
    if (group) return { provider: group.id, model: group.models[0].id };
  }
  if (lastLocal && local.some(group => group.id === lastLocal.provider && group.models.some(model => model.id === lastLocal.model))) return lastLocal;
  const first = local.find(group => group.models.length);
  return first && { provider: first.id, model: first.models[0].id };
}

/** One session's filtered view, shared by the native picker and /model. Never changes the host catalog. */
export function workspaceDirectory<D extends Directory>(source: D, options: {
  key(): string; check(signal: AbortSignal): Promise<Admission>;
  remember?(selection: Selection & { reasoningEffort: string }): Promise<unknown>;
  /** Whether the conversation has not started. Only such a conversation gets a model chosen for it. */
  blank?(): boolean;
  /** Give this conversation the model without changing the default for later ones. */
  adopt?(selection: Selection): Promise<unknown>;
  lastLocal?(): Selection | undefined;
  rememberLocal?(selection: Selection): void;
}) {
  let disposed = false, key = options.key(), admission: Admission | undefined, request: AbortController | undefined;
  let pending: Promise<Admission | undefined> | undefined, preferenceError: string | undefined;
  let previous: { source: Snapshot; admission?: Admission; key: string; pending: boolean; value: Snapshot } | undefined;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const allowed = (selection: Selection, accepted: Admission | undefined) => !remote(selection.provider) || !!accepted?.hostIds.includes(selection.model.split('/')[0]);
  const currentAdmission = () => key === options.key() ? admission : undefined;
  // Once per inherited model, so a refused or impossible choice leaves the picker asking instead of retrying.
  let adopted: string | undefined;
  const adoptFallback = () => {
    const snapshot = source.store.getSnapshot(), accepted = currentAdmission(), current = snapshot.current;
    if (disposed || pending || !accepted || !current || !options.adopt || !options.blank?.() || allowed(current, accepted)) return;
    const attempt = JSON.stringify([key, current.provider, current.model]);
    if (adopted === attempt) return;
    const visible = snapshot.groups.map(group => remote(group.id) ? { ...group, models: group.models.filter(model => allowed({ provider: group.id, model: model.id }, accepted)) } : group);
    const choice = fallbackModel(visible, current, accepted, options.lastLocal?.());
    if (!choice) return;
    adopted = attempt;
    options.adopt(choice).catch(() => {});
  };
  const off = source.store.subscribe(() => { publish(); adoptFallback(); });
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
      ...(preferenceError ? { error: preferenceError } : {}),
      ...(snapshot.failures ? { failures: snapshot.failures.filter(failure => !remote(failure.id) || !!accepted?.hostIds.length) } : {}),
      ...(blocked ? { current: null, retainedEffort: undefined, routable: false, error: checking ? null : unavailable() } : {}),
      ...(checking && !accepted ? { status: 'loading' } : {}),
    };
    previous = { source: snapshot, admission: accepted, key: currentKey, pending: checking, value }; return value;
  };
  const invalidate = () => {
    request?.abort(); request = undefined; pending = undefined; admission = undefined; previous = undefined; preferenceError = undefined; publish();
  };
  const refresh = (): Promise<Admission | undefined> => {
    if (disposed) return Promise.resolve(undefined);
    const nextKey = options.key();
    if (pending && key === nextKey) return pending;
    request?.abort();
    if (key !== nextKey) { admission = undefined; preferenceError = undefined; }
    key = nextKey;
    const controller = new AbortController(); request = controller;
    pending = (async () => {
      let result: Admission;
      try {
        result = await options.check(controller.signal);
        if (!result || !Array.isArray(result.hostIds) || !result.hostIds.every(id => typeof id === 'string' && id.length > 0)) throw new Error('Invalid workspace admission');
      } catch { result = { hostIds: [] }; }
      if (disposed || controller.signal.aborted || request !== controller || key !== options.key()) return undefined;
      admission = result; request = undefined; pending = undefined; publish(); adoptFallback(); return result;
    })();
    publish(); return pending;
  };
  const load = async () => {
    await Promise.all([source.load(), refresh()]);
    while (!disposed && (key !== options.key() || pending)) await refresh();
    return getSnapshot();
  };
  const select = async (selection: Selection) => {
    if (preferenceError) { preferenceError = undefined; previous = undefined; publish(); }
    if (remote(selection.provider)) {
      const accepted = await refresh();
      if (disposed || !accepted || accepted !== currentAdmission() || !allowed(selection, accepted)) {
        return { ok: false, error: { code: 'remote/workspace-mismatch', message: unavailable() } };
      }
    }
    const selectedKey = options.key(), result = await source.select(selection);
    if (!remote(selection.provider) && result && typeof result === 'object' && 'ok' in result && result.ok === true) options.rememberLocal?.(selection);
    // Persist explicit successful choices immediately, even when no message is sent. Merely loading
    // a saved conversation (or a failed/no-longer-admitted selection) must never rewrite the default.
    if (result && typeof result === 'object' && 'ok' in result && result.ok === true
      && !disposed && selectedKey === options.key() && remote(selection.provider) && selection.reasoningEffort !== undefined && options.remember) {
      try { await options.remember({ ...selection, reasoningEffort: selection.reasoningEffort }); }
      catch {
        const message = ui('Failed to save the thinking level. Select it again to retry.');
        if (!disposed && selectedKey === options.key()) { preferenceError = message; previous = undefined; publish(); }
        return { ok: false, error: { code: 'remote/preference-save-failed', message } };
      }
    }
    return result;
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

const LAST_LOCAL = 'dsh-remote-agents.lastLocalModel.v1';
/** The last local model chosen in this browser, which a new local conversation falls back on. */
function lastLocal(): Selection | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_LOCAL) ?? 'null') as Partial<Selection> | null;
    return value && typeof value.provider === 'string' && typeof value.model === 'string'
      ? { provider: value.provider, model: value.model, ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}) } : undefined;
  } catch { return undefined; }
}
function rememberLocal(selection: Selection): void {
  try { localStorage.setItem(LAST_LOCAL, JSON.stringify(selection)); } catch { /* the first local model is used instead */ }
}

export interface WorkspaceClient {
  effect(factory: () => () => void): void;
  modelDirectories: { directoryFor(sessionId: string): Directory };
  sessions: { list: { getSnapshot(): { byId: Record<string, { cwd?: string; blank?: boolean }> } | undefined; subscribe(listener: () => void): () => void } };
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
        remember: selection => api('setChatEffort', { ...selection }),
        blank: () => ctx.sessions.list.getSnapshot()?.byId[id]?.blank === true,
        adopt: selection => api('adoptChatModel', { sessionId: id, ...selection }),
        lastLocal, rememberLocal,
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
