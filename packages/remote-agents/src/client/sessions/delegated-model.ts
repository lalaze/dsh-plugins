import { PROVIDER_LABELS, type AgentSummary } from '@dsh-plugins/remote-core/domain.js';

export const DELEGATED_SLOT = 'conversation.session.header.actions';
export const DELEGATED_ID = 'subagent-catalog';
export const REMOTE_PREFIX = 'remote-cli:';
export const remoteCatalogId = (id: string) => `${REMOTE_PREFIX}${id}`;
export const isRemoteCatalogId = (id: unknown): id is string => typeof id === 'string' && id.startsWith(REMOTE_PREFIX);
export interface CatalogAddress { parentSessionId: string; childSessionId: string; mode: string }
export interface CatalogRow { id: string; createdAt: number; mode: string; label?: string }
export interface CatalogProjection {
  state: string;
  error?: unknown;
  values: { subagentCatalog?: CatalogRow[]; [key: string]: unknown };
  [key: string]: unknown;
}
export interface CatalogSummary {
  title?: string;
  running?: boolean;
  origin?: string;
  projectionValues?: Record<string, unknown>;
  [key: string]: unknown;
}
/** Only the native menu's read view, never a durable Session or writable sessions store. */
export interface CatalogState {
  projectionsBySession: Record<string, CatalogProjection>;
  byId: Record<string, CatalogSummary>;
  [key: string]: unknown;
}
export function ownedDelegations(agents: readonly AgentSummary[], sessionId: string): AgentSummary[] {
  const seen = new Set<string>();
  return agents.filter(agent => {
    if (!agent.delegated || agent.chatSessionId || agent.ownerSessionId !== sessionId || !agent.id || seen.has(agent.id)) return false;
    seen.add(agent.id); return true;
  });
}
/** No wall-clock duration, inferred completion, or invented token counters. Idle is not proof of success. */
export function mergeDelegatedCatalog(state: CatalogState, sessionId: string, agents: readonly AgentSummary[]): CatalogState {
  const owned = ownedDelegations(agents, sessionId);
  if (!owned.length) return state;
  const projections = { ...state.projectionsBySession }, summaries = { ...state.byId };
  const parent = projections[sessionId];
  const rows = [...(parent?.values.subagentCatalog ?? [])];
  const seen = new Set(rows.map(row => row.id));
  for (const agent of owned) {
    const id = remoteCatalogId(agent.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const createdAt = Date.parse(agent.createdAt);
    rows.push({ id, createdAt: Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : 0, mode: 'one-shot', label: `Remote CLI · ${PROVIDER_LABELS[agent.provider] ?? agent.provider} · ${agent.title}` });
    summaries[id] = {
      title: [agent.model, agent.status, agent.archived ? 'archived' : '', agent.reconnecting ? 'reconnecting' : '', agent.error].filter(Boolean).join(' · '),
      running: agent.status === 'running' || agent.status === 'starting',
      // Omitting timing and tokenUsage is intentional: AgentSummary does not establish either.
      projectionValues: {},
    };
    // Empty, ready child catalogs stop native expansion from fetching a remote pseudo ID.
    projections[id] = { state: 'idle', values: { subagentCatalog: [] } };
  }
  // Keep the native parent's loading/error/migration state and its other projections intact.
  projections[sessionId] = { ...(parent ?? { state: 'idle' }), values: { ...parent?.values, subagentCatalog: rows } };
  return { ...state, projectionsBySession: projections, byId: summaries };
}

/** Consume EVERY reserved address, including unknown/stale ones; only true native IDs pass through. */
export function routeCatalogAddress(address: CatalogAddress, sessionId: string, agents: readonly AgentSummary[], remote: (agent: AgentSummary) => void, native: (address: CatalogAddress) => unknown): unknown {
  if (isRemoteCatalogId(address.parentSessionId)) return;
  if (!isRemoteCatalogId(address.childSessionId)) return native(address);
  if (address.parentSessionId !== sessionId) return;
  const agent = ownedDelegations(agents, sessionId).find(agent => remoteCatalogId(agent.id) === address.childSessionId);
  if (agent) remote(agent);
}

export interface CatalogEntry<Component = unknown> {
  component: Component;
  options: { id?: string; priority?: number; order?: number; [key: string]: unknown };
  inject?: unknown;
  locale?: unknown;
}
export interface CatalogSlots<Component = unknown> {
  entries(name: string): readonly CatalogEntry<Component>[];
  subscribe(name: string, listener: () => void): () => void;
  register(spec: Record<string, unknown>, component: Component): unknown;
}
/** Follow the original registration's lifetime, not store updates or React renders. */
export function decorateCatalogSlot<Component>(slots: CatalogSlots<Component>, wrap: (entry: CatalogEntry<Component>) => Component): () => void {
  let original: CatalogEntry<Component> | undefined, wrapper: Component | undefined, dispose: (() => void) | undefined;
  let stopped = false, syncing = false;
  const sync = () => {
    if (stopped || syncing) return;
    syncing = true;
    try {
      const entries = slots.entries(DELEGATED_SLOT);
      const next = entries.find(entry => entry.options.id === DELEGATED_ID && (entry.options.priority ?? 0) === 0);
      const oursPresent = wrapper !== undefined && entries.some(entry => entry.component === wrapper);
      if (next === original && (next === undefined || oursPresent)) return;
      dispose?.(); dispose = undefined; original = next; wrapper = undefined;
      // Never replace a missing native component or another plugin's decorator with a fake menu.
      if (!next || slots.entries(DELEGATED_SLOT).some(entry => entry.options.id === DELEGATED_ID && entry.options.priority === -10)) return;
      wrapper = wrap(next);
      const cleanup = slots.register({ ...next.options, name: DELEGATED_SLOT, id: DELEGATED_ID, priority: -10, inject: next.inject, locale: next.locale }, wrapper);
      if (typeof cleanup === 'function') dispose = cleanup as () => void;
    } finally { syncing = false; }
  };
  // Retain no service/global mutable cache; disposal removes the exact registration and subscription.
  const unsubscribe = slots.subscribe(DELEGATED_SLOT, sync);
  sync();
  return () => { if (stopped) return; stopped = true; unsubscribe(); dispose?.(); dispose = undefined; original = undefined; wrapper = undefined; };
}

interface PollOptions {
  request: (sessionId: string, signal: AbortSignal) => Promise<AgentSummary[]>;
  accept: (agents: AgentSummary[]) => void;
  error: (error: unknown) => void;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}
/** Serial polling with an epoch guard as well as abort (transports may ignore cancellation). */
export function pollDelegations(sessionId: string, options: PollOptions): () => void {
  const controller = new AbortController(); let epoch = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    const requestEpoch = ++epoch;
    try {
      const agents = await options.request(sessionId, controller.signal);
      if (!controller.signal.aborted && requestEpoch === epoch) options.accept(ownedDelegations(agents, sessionId));
    } catch (error) { if (!controller.signal.aborted && requestEpoch === epoch) options.error(error); }
    if (!controller.signal.aborted && requestEpoch === epoch) timer = (options.schedule ?? setTimeout)(() => void poll(), 2000);
  };
  void poll();
  return () => { epoch++; controller.abort(); if (timer !== undefined) (options.cancel ?? clearTimeout)(timer); };
}
