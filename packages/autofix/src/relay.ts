/**
 * Bugs handed from one DSH to another through the machine that holds the repository. The DSH that runs fixes says there
 * which repositories it serves, takes the requests it finds, and keeps each task's state there; a DSH where a person
 * types /fix writes a request and follows the task from those files.
 */
import { randomUUID } from 'node:crypto';
import { fail, Failure, messageOf, type ItemImage, type Message, type Route, type Task } from './domain.js';
import type { Handed } from './command.js';
import type { FixLine } from './fixline.js';
import { EXTENSIONS } from './pictures.js';
import type { State } from './service.js';
import { fileName, Spool, SPOOL_ROOT } from './spool.js';
import type { Store } from './store.js';
import { runChoice, type RunChoice } from './tasks.js';
import type { Machine, ProjectDetail } from './workplaces.js';

type TaskView = State['tasks'][number];
export interface ServedRoute { id: string; name: string; repository: string; defaultBranch: string; accept: Route['accept'] }
/** What the DSH that runs fixes says about itself on a machine; `at` is when it last did. */
export interface Published { executor: string; name: string; at: number; routes: ServedRoute[] }
export type RelayRequest =
  | { id: string; kind: 'file'; routeId: string; branch: string; title: string; body: string; pictures: string[]; feature?: boolean; models?: RunChoice['models']; rounds?: number }
  | { id: string; kind: 'sendBack'; key: string; feedback: string; pictures: string[] }
  | { id: string; kind: 'accept' | 'stop' | 'retryReport' | 'removeWorkspace'; key: string };
type Ask = RelayRequest extends infer R ? R extends { id: string } ? Omit<R, 'id' | 'pictures'> : never : never;
export type RelayDone = { ok: true; key?: string; ref?: string; title?: string } | { ok: false; said: Message };
export interface RemoteTask { task: TaskView; route: Pick<Route, 'id' | 'name' | 'accept'> }
export interface Diff { stat: string; patch: string; truncated: boolean }

const HEARTBEAT = 20_000;
/** Longer than a few missed beats, and than the two computers' clocks may differ. */
const FRESH = 180_000;
const ID = /^[0-9a-f-]{36}$/u;
const MEDIA = Object.keys(EXTENSIONS);
const MAX_PICTURES = 8, MAX_REPORT = 20_000;

/**
 * A task as another DSH's card needs it: without the steps' full results, which stay in the conversation, and without
 * what is only true this second (a file read later would show it as now).
 */
function slim({ progress: _progress, ...task }: TaskView): TaskView {
  const flow = task.flow && { ...task.flow, steps: task.flow.steps.map(({ body: _body, ...step }) => step), ...(task.flow.report ? { report: task.flow.report.slice(0, MAX_REPORT) } : {}) };
  return { ...task, events: task.events.slice(-8), ...(flow ? { flow } : {}) };
}

export interface ServerHost {
  store: Store;
  machine(project: string): Promise<Machine>;
  inspect(project: string): Promise<ProjectDetail>;
  createManual(input: { title: string; body: string; images: { name: string; mediaType: string; data: string }[]; assignment: { routeId: string; branch: string }; kind?: 'feature' }): Promise<{ key: string }>;
  view(key: string): TaskView | undefined;
  diff(key: string): Promise<Diff>;
  tasks: {
    start(key: string, pictures?: readonly unknown[], choice?: RunChoice): Promise<Task>; sendBack(key: string, feedback: string, pictures?: readonly ItemImage[]): Promise<Task>;
    accept(key: string): Promise<Task>; stop(key: string): boolean; retryReport(key: string): Promise<Task>; removeWorkspace(key: string): Promise<Task>;
  };
  /** This DSH, as other DSHes will name it. */
  identity: { id: string; name: string };
  now?(): number;
  root?: string;
}
interface Group { label: string; machine: Machine; routes: ServedRoute[] }

/** The side that runs fixes. Nothing happens unless the settings say other DSHes may hand bugs in. */
export class RelayServer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = false;
  private readonly repositories = new Map<string, { repository: string; at: number }>();
  private readonly beats = new Map<string, { at: number; said: string }>();
  private readonly published = new Map<string, { group: string; state: string; commit?: string }>();
  /** For the settings page: the machines served, and what went wrong on the last round. */
  status: { label: string; routes: string[]; error?: string }[] = [];
  constructor(private readonly host: ServerHost) {}
  private now(): number { return this.host.now?.() ?? Date.now(); }

  /** Often enough that a person who typed /fix is answered at once, seldom enough to be nothing to the machine. */
  start(everyMs = 4000): void {
    const round = () => { this.timer = setTimeout(() => { void this.tick().finally(() => { if (!this.stopped) round(); }); }, everyMs); this.timer.unref?.(); };
    round();
  }
  stop(): void { this.stopped = true; clearTimeout(this.timer); }

  /** One round on every machine that holds a repository of the settings. A machine that fails does not stop the others. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { settings } = this.host.store;
      if (!settings.run.relay) { this.status = []; return; }
      const groups = new Map<string, Group>(), status: RelayServer['status'] = [];
      for (const route of settings.routes) {
        try {
          const machine = await this.host.machine(route.project), id = machine.location.kind === 'remote' ? `remote:${machine.location.hostId}` : 'local';
          let known = this.repositories.get(route.project);
          if (!known || this.now() - known.at > 600_000) {
            const repository = (await this.host.inspect(route.project)).repository;
            if (!repository) throw new Error('This DSH cannot tell where the repository is');
            known = { repository, at: this.now() }; this.repositories.set(route.project, known);
          }
          const group = groups.get(id) ?? { label: machine.location.kind === 'remote' ? machine.location.host : 'this computer', machine, routes: [] };
          group.routes.push({ id: route.id, name: route.name, repository: known.repository, defaultBranch: route.defaultBranch, accept: route.accept });
          groups.set(id, group);
        } catch (error) { status.push({ label: route.name, routes: [route.name], error: error instanceof Error ? error.message : String(error) }); }
      }
      for (const [id, group] of groups) {
        try { await this.serve(id, group); status.push({ label: group.label, routes: group.routes.map(route => route.name) }); }
        catch (error) { status.push({ label: group.label, routes: group.routes.map(route => route.name), error: error instanceof Error ? error.message : String(error) }); }
      }
      this.status = status;
    } finally { this.running = false; }
  }

  private async serve(id: string, group: Group): Promise<void> {
    const spool = new Spool(group.machine, this.host.root ?? SPOOL_ROOT), { identity } = this.host, said = JSON.stringify(group.routes), beat = this.beats.get(id);
    if (!beat || beat.said !== said || this.now() - beat.at >= HEARTBEAT) {
      await spool.writeJson('executor.json', { executor: identity.id, name: identity.name, at: this.now(), routes: group.routes } satisfies Published);
      this.beats.set(id, { at: this.now(), said });
    }
    for (const entry of await spool.collect('inbox', 'done')) {
      if (!ID.test(entry.name)) { await spool.remove(`inbox/${entry.name}.json`).catch(() => undefined); continue; }
      let done: RelayDone;
      try { done = await this.handle(spool, group, { ...(JSON.parse(entry.text) as RelayRequest), id: entry.name }); }
      catch (error) { done = { ok: false, said: messageOf(error) }; }
      await spool.writeJson(`done/${entry.name}.json`, done);
      await spool.remove(`inbox/${entry.name}.json`);
      await spool.remove(`inbox/${entry.name}`).catch(() => undefined);
    }
    await this.publish(id, group, spool);
  }

  /** A request is another computer's word: checked like anything typed into a page. */
  private async handle(spool: Spool, group: Group, request: RelayRequest): Promise<RelayDone> {
    const { tasks, store } = this.host;
    const pictures = async (): Promise<{ name: string; mediaType: string; data: Buffer }[]> => {
      const types = 'pictures' in request && Array.isArray(request.pictures) ? request.pictures.slice(0, MAX_PICTURES) : [], read = [];
      for (const [index, mediaType] of types.entries()) {
        if (!MEDIA.includes(mediaType)) throw fail('Only PNG, JPEG, WebP and GIF pictures can be sent along');
        const name = `${index + 1}.${EXTENSIONS[mediaType]}`, data = await spool.read(`inbox/${request.id}/${name}`);
        if (!data) throw fail('Picture {index} did not arrive', { index: String(index + 1) });
        read.push({ name, mediaType, data });
      }
      return read;
    };
    if (request.kind === 'file') {
      if (!group.routes.some(route => route.id === request.routeId)) throw fail('The repository this bug was assigned to is no longer in the settings');
      const images = (await pictures()).map(picture => ({ name: picture.name, mediaType: picture.mediaType, data: picture.data.toString('base64') }));
      const { key } = await this.host.createManual({ title: String(request.title ?? ''), body: String(request.body ?? ''), images, assignment: { routeId: request.routeId, branch: String(request.branch ?? '') }, ...(request.feature === true ? { kind: 'feature' as const } : {}) });
      const task = await tasks.start(key, [], runChoice(request));
      return { ok: true, key, ref: task.item.ref, title: task.item.title };
    }
    const task = store.tasks[String(request.key)];
    if (!task || !group.routes.some(route => route.id === task.routeId)) throw fail('There is no task for this bug');
    if (request.kind === 'sendBack') await tasks.sendBack(task.key, String(request.feedback ?? '').slice(0, 8000), await pictures());
    else if (request.kind === 'accept') await tasks.accept(task.key);
    else if (request.kind === 'stop') tasks.stop(task.key);
    else if (request.kind === 'retryReport') await tasks.retryReport(task.key);
    else if (request.kind === 'removeWorkspace') await tasks.removeWorkspace(task.key);
    else throw fail('This DSH does not know that request; update dsh-autofix on it');
    return { ok: true, key: task.key };
  }

  /** Each task of these repositories as it is now, written when it changed; a fix that waits for a person comes with its changes. */
  private async publish(id: string, group: Group, spool: Spool): Promise<void> {
    const mine = new Set<string>();
    for (const stored of Object.values(this.host.store.tasks)) {
      const route = group.routes.find(entry => entry.id === stored.routeId), view = route && this.host.view(stored.key);
      if (!route || !view) continue;
      mine.add(view.key);
      const state = `${view.updatedAt}:${view.status}:${view.running}:${view.cards ?? 0}:${view.events.length}:${view.flow?.steps.map(step => step.status).join() ?? ''}`, before = this.published.get(view.key), name = fileName(view.key);
      if (before?.state !== state) await spool.writeJson(`tasks/${name}.json`, { task: slim(view), route: { id: route.id, name: route.name, accept: route.accept } } satisfies RemoteTask);
      let commit = before?.commit;
      if (view.status === 'review' && view.commit && view.commit !== commit) {
        const diff = await this.host.diff(view.key).catch(() => undefined);
        if (diff) { await spool.writeJson(`tasks/${name}.diff.json`, diff); commit = view.commit; }
      }
      this.published.set(view.key, { group: id, state, ...(commit ? { commit } : {}) });
    }
    for (const [key, entry] of this.published) {
      if (entry.group !== id || mine.has(key)) continue;
      await spool.remove(`tasks/${fileName(key)}.json`).catch(() => undefined);
      await spool.remove(`tasks/${fileName(key)}.diff.json`).catch(() => undefined);
      this.published.delete(key);
    }
  }
}

export interface ClientHost {
  machine(folder: string): Promise<Machine>;
  inspect(folder: string): Promise<ProjectDetail>;
  /** A picture DSH keeps, as its bytes. */
  readImage(ref: unknown): Promise<{ data: Uint8Array; mediaType: string }>;
  now?(): number;
  root?: string;
  /** How long to wait for the other DSH to take a request. */
  waitMs?: number;
  pollMs?: number;
}

/** The side a person types into, when the repository is another DSH's to fix. `folder` is always a workspace of this DSH. */
export class RelayClient {
  constructor(private readonly host: ClientHost) {}
  private now(): number { return this.host.now?.() ?? Date.now(); }
  private async spool(folder: string): Promise<Spool> { return new Spool(await this.host.machine(folder), this.host.root ?? SPOOL_ROOT); }

  /** Hands a bug typed in a conversation to the DSH that runs fixes for that folder's machine. Undefined when there is none. */
  async file(folder: string, line: FixLine, pictures: readonly unknown[], how: Handed = {}): Promise<{ key: string; ref: string; title: string } | undefined> {
    const here = await this.host.inspect(folder).catch(() => undefined);
    if (!here?.repository) return undefined;
    const spool = await this.spool(folder), published = await spool.readJson<Published>('executor.json');
    if (!published || !Array.isArray(published.routes)) return undefined;
    if (this.now() - published.at > FRESH) throw fail('{name} runs fixes for this machine but is not answering. Is its DSH running, with taking bugs from other DSHes switched on?', { name: published.name });
    const names = published.routes.map(route => route.name).join(', '), wanted = line.repo?.toLowerCase();
    const named = wanted ? published.routes.filter(route => route.name.toLowerCase() === wanted || route.name.toLowerCase().startsWith(wanted)) : [];
    const route = wanted ? (named.length === 1 ? named[0] : undefined) : published.routes.find(entry => entry.repository === here.repository);
    if (!route) throw wanted ? fail('No repository is called {name}. There are: {names}', { name: line.repo!, names }) : fail('{name} runs fixes on this machine, but not for this repository. It has: {names}', { name: published.name, names });
    const branch = line.branch || route.defaultBranch;
    if (!branch) throw fail('{route} has no default branch; choose a branch for this bug', { route: route.name });
    const read: ItemImage[] = [];
    for (const ref of pictures) read.push(await this.host.readImage(ref));
    const done = await this.send(spool, published.name, { kind: 'file', routeId: route.id, branch, title: line.title || 'See the attached pictures', body: line.body,
      ...(how.kind === 'feature' ? { feature: true } : {}), ...(how.models ? { models: how.models } : {}), ...(how.rounds ? { rounds: how.rounds } : {}) }, read);
    return { key: done.key!, ref: done.ref ?? '', title: done.title ?? line.title };
  }
  /** Something a person decided about a task the other DSH runs. */
  async act(folder: string, ask: Ask, pictures: readonly ItemImage[] = []): Promise<void> {
    const spool = await this.spool(folder), published = await spool.readJson<Published>('executor.json');
    await this.send(spool, published?.name ?? 'The other DSH', ask, pictures);
  }
  async task(folder: string, key: string): Promise<RemoteTask | undefined> { return (await this.spool(folder)).readJson<RemoteTask>(`tasks/${fileName(key)}.json`); }
  async diff(folder: string, key: string): Promise<Diff> {
    const diff = await (await this.spool(folder)).readJson<Diff>(`tasks/${fileName(key)}.diff.json`);
    if (!diff) throw fail('The changes are not here yet');
    return diff;
  }

  /** The pictures first, the request last, so the other DSH never finds one without the other; then its answer. */
  private async send(spool: Spool, name: string, ask: Ask, pictures: readonly ItemImage[]): Promise<Extract<RelayDone, { ok: true }>> {
    if (pictures.length > MAX_PICTURES) throw fail('At most {count} pictures', { count: String(MAX_PICTURES) });
    const id = randomUUID(), types: string[] = [];
    for (const [index, picture] of pictures.entries()) {
      const extension = EXTENSIONS[picture.mediaType];
      if (!extension) throw fail('Only PNG, JPEG, WebP and GIF pictures can be sent along');
      await spool.write(`inbox/${id}/${index + 1}.${extension}`, picture.data);
      types.push(picture.mediaType);
    }
    await spool.writeJson(`inbox/${id}.json`, { ...ask, ...(ask.kind === 'file' || ask.kind === 'sendBack' ? { pictures: types } : {}) });
    const wait = this.host.waitMs ?? 45_000, every = this.host.pollMs ?? 1000, until = Date.now() + wait;
    for (;;) {
      const done = await spool.readJson<RelayDone>(`done/${id}.json`).catch(() => undefined);
      if (done) {
        await spool.remove(`done/${id}.json`).catch(() => undefined);
        if (!done.ok) throw new Failure(done.said);
        return done;
      }
      if (Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, every));
    }
    // Not taken: it must not be carried out later, when nobody expects it any more.
    await spool.remove(`inbox/${id}.json`).catch(() => undefined);
    await spool.remove(`inbox/${id}`).catch(() => undefined);
    throw fail('{name} did not take this within {seconds} s. Is its DSH running, with taking bugs from other DSHes switched on?', { name, seconds: String(Math.round(wait / 1000)) });
  }
}
