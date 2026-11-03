import { createHash } from 'node:crypto';
import { modePermission, type DshPermission, type Task } from '../core/domain.js';
import { chatModelId, chatProviderId } from './native-chat.js';
import type { ChatProjects } from './projects.js';

/** What a continued conversation runs: its CLI's model route, reasoning effort and the permission matching its mode. */
export interface AdoptedSelection { provider: string; model: string; reasoningEffort?: string; permission?: DshPermission }
/** The DSH operations that put a continued session in the sidebar. */
export interface AdoptionHost {
  /** The local folder of the remote workspace for this directory, created when missing. */
  anchor(hostId: string, cwd: string, signal: AbortSignal): Promise<string>;
  /** The DSH workspace for a local folder, added when missing. */
  workspace(path: string): Promise<string>;
  /** DSH conversations by id, and whether each is still blank. */
  sessions(): Promise<Map<string, { blank: boolean }>>;
  /** Create the conversation with this id, or reuse it while blank; DSH answers with the id it used. */
  create(workspaceId: string, sessionId: string): Promise<string>;
  select(sessionId: string, selection: AdoptedSelection): Promise<void>;
  rename(sessionId: string, title: string): Promise<void>;
  /** Start the conversation's first turn, which shows the saved history. */
  wake(sessionId: string): void;
  warn?(message: string): void;
}

/** The same task always maps to the same conversation, so an interrupted adoption reuses the blank one it made. */
export function adoptedSessionId(instance: string, taskId: string): string {
  const h = createHash('sha256').update(`${instance}\0${taskId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | parseInt(h[16], 16) & 3).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Which step of an adoption failed: only the SSH step says anything about the host. */
class AdoptionError extends Error {
  constructor(readonly step: 'history' | 'anchor' | 'workspace' | 'create' | 'select' | 'rename', cause: unknown) {
    super(`${step}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
const step = async <T>(name: AdoptionError['step'], run: () => Promise<T>): Promise<T> => {
  try { return await run(); } catch (error) { throw new AdoptionError(name, error); }
};
/** Started by another DSH, as a conversation rather than a delegated background task, and not yet continued here. */
const adoptable = (task: Task) => !!task.shared?.imported && task.origin !== 'dsh' && !task.chat && !task.archived && !!task.agentId && !!task.native && task.state !== 'creating';

/**
 * Sessions another DSH started on a shared host become main conversations here, in their remote workspace and on
 * the same CLI session, so they can be continued. Each opens with its saved history; nothing is sent to the CLI.
 */
export class SharedChatAdoption {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private readonly controller = new AbortController();
  /** Tasks that failed, retried later with a growing delay; a host that cannot be reached is not asked again each round. */
  private readonly retries = new Map<string, { at: number; delay: number }>();
  constructor(private readonly projects: ChatProjects, private readonly host: AdoptionHost, private readonly options: { first?: number; every?: number } = {}) {}
  start(): void {
    const schedule = (delay: number) => {
      if (this.controller.signal.aborted) return;
      this.timer = setTimeout(() => { void this.run().finally(() => schedule(this.options.every ?? 30_000)); }, delay);
      this.timer.unref?.();
    };
    schedule(this.options.first ?? 5000);
  }
  close(): void { this.controller.abort(); clearTimeout(this.timer); }
  /** One pass over the shared sessions; passes never overlap. */
  run(): Promise<void> {
    return this.running ??= this.round().catch(error => this.host.warn?.(`Continuing shared remote conversations failed: ${String(error)}`)).finally(() => { this.running = undefined; });
  }
  private async round(): Promise<void> {
    const store = this.projects.service.store, signal = this.controller.signal;
    const due = (task: Task) => (this.retries.get(task.id)?.at ?? 0) <= Date.now();
    // Oldest first: DSH lists conversations by their latest change, so the newest session ends up on top.
    const candidates = store.tasks(t => adoptable(t) && due(t)).sort((a, b) => (a.updatedAt ?? a.createdAt).localeCompare(b.updatedAt ?? b.createdAt));
    // A history not shown yet, because DSH quit first or the conversation was never saved, is shown again.
    const unshown = store.tasks(t => t.chat?.history === 'pending' && !!t.shared?.imported && due(t));
    if (!candidates.length && !unshown.length) return;
    const listed = await this.host.sessions(), instance = (await store.instance()).id, unreachable = new Set<string>();
    for (const task of [...unshown, ...candidates]) {
      if (signal.aborted) return;
      if (unreachable.has(task.hostId)) continue;
      const bound = task.chat?.sessionId, known = bound ? listed.get(bound) : undefined;
      // Its first turn started: DSH wakes it again when the conversation opens.
      if (bound && known && !known.blank) continue;
      try {
        if (await this.adopt(task, bound ?? adoptedSessionId(instance, task.id), listed, signal)) this.retries.delete(task.id);
      } catch (error) {
        if (signal.aborted) return;
        // A host that cannot be reached waits for the next round; a folder removed from it, or a DSH step, fails alone.
        if (error instanceof AdoptionError && error.step === 'anchor' && !/Not a readable directory/.test(error.message)) unreachable.add(task.hostId);
        const delay = Math.min((this.retries.get(task.id)?.delay ?? 30_000) * 2, 30 * 60_000);
        if (!this.retries.has(task.id)) this.host.warn?.(`Could not continue the shared remote conversation "${task.title}" here: ${error instanceof Error ? error.message : String(error)}`);
        this.retries.set(task.id, { at: Date.now() + delay, delay });
      }
    }
  }
  /** False while the host's catalog is not ready to run this session's CLI; it is tried again next round. */
  private async adopt(task: Task, wanted: string, listed: Map<string, { blank: boolean }>, signal: AbortSignal): Promise<boolean> {
    const selection = this.selection(task);
    if (!selection) return false;
    // A session never opened here has its history copied when it is first read, once the host's registry is reachable.
    // Until then it reads as empty, and the conversation would open without its history.
    if (!(await step('history', () => this.projects.service.timeline(task.id)))?.entries.length) return false;
    const path = await step('anchor', () => this.host.anchor(task.hostId, task.cwd, signal));
    signal.throwIfAborted();
    const workspaceId = await step('workspace', () => this.host.workspace(path));
    // A conversation already holding this session's history, as after the host was removed and added again, is kept.
    const existing = listed.get(wanted);
    const sessionId = existing && !existing.blank ? wanted : await step('create', () => this.host.create(workspaceId, wanted));
    await step('select', () => this.host.select(sessionId, selection));
    await step('rename', () => this.host.rename(sessionId, task.title));
    let bind = false;
    await this.projects.service.store.update(state => {
      const saved = state.tasks.find(t => t.id === task.id);
      // A history not shown yet moves to the conversation DSH answered with; any other binding stays.
      if (!saved || saved.chat && !saved.chat.history && saved.chat.sessionId !== sessionId) return;
      saved.chat = { ...saved.chat, sessionId, route: selection.model, history: 'pending' };
      bind = true;
    });
    if (bind) this.host.wake(sessionId);
    return true;
  }
  private selection(task: Task): AdoptedSelection | undefined {
    const project = this.projects.hosts().find(p => p.hostId === task.hostId);
    const provider = project?.providers.find(p => p.id === task.provider && p.status === 'ready');
    if (!project || !provider?.models.length) return;
    // A model the CLI no longer lists continues on its first one; the picker can change it.
    const model = provider.models.find(m => m.id === task.model) ?? provider.models[0];
    const effort = task.thinkingOptionId && model.thinkingOptions?.some(o => o.id === task.thinkingOptionId) ? task.thinkingOptionId : undefined;
    const permission = modePermission(task.provider, task.modeId);
    return { provider: chatProviderId(task.provider), model: chatModelId(project.id, task.provider, model.id), ...(effort ? { reasoningEffort: effort } : {}), ...(permission ? { permission } : {}) };
  }
}
