/**
 * /fix in a conversation: the bug goes to the repository that conversation works in, and a card follows it there. In a
 * task's own conversation the same command sends the fix back with what was typed.
 */
import { randomUUID } from 'node:crypto';
import { fail, messageOf, render, say, type Route, type Task } from './domain.js';
import { parseFix, type FixLine } from './fixline.js';
import type { ManualInput } from './manual.js';
import { COMMAND, MARK, rowText, type RowMeta } from './shared.js';
export { COMMAND };
import type { Store } from './store.js';
import type { RunChoice } from './tasks.js';
import type { Location, ProjectDetail } from './workplaces.js';

export type RowResult = { kind: 'success' | 'error'; text: string };
/** A conversation's live agent, as far as this command reads it. */
export interface LiveAgent {
  id: string; phase?: { kind?: string; lastTurn?: number };
  session: { append(type: string, payload: unknown): unknown; deriveMessages?(): unknown[] };
}
export interface Invocation { agent: LiveAgent; rawInput: string; attachments?: readonly { type: string; attachment?: unknown }[] }
export interface CommandHost {
  store: Store;
  tasks: { start(key: string, pictures?: readonly unknown[], choice?: RunChoice): Promise<Task>; sendBack(key: string, feedback: string, pictures?: readonly never[], kept?: readonly unknown[]): Promise<Task> };
  createManual(input: ManualInput & { assignment: { routeId: string; branch: string } }): Promise<{ key: string }>;
  inspect(project: string): Promise<ProjectDetail>;
  /** The folder a conversation works in, when DSH can say. */
  folder(agent: LiveAgent): string | undefined;
  /** Names a conversation that had nothing in it before the line was typed there, so it is not left untitled. */
  title?(agent: LiveAgent, title: string): Promise<void>;
  /** Another DSH that runs fixes for the machine a folder is on: hands the bug to it, or answers undefined when there is none. */
  handOver?(folder: string, line: FixLine, pictures: readonly unknown[], how?: Handed): Promise<{ key: string; ref: string; title: string } | undefined>;
  now?(): number;
}
/** What goes with a task to the DSH that runs it. */
export type Handed = RunChoice & { kind?: 'feature' };
/**
 * A task that did not come from a typed /fix: /flow hands in something to build, with where it goes and what it runs
 * with already read from its own line.
 */
export interface TakeOptions extends Handed { repo?: string; branch?: string }
const MAX_PICTURES = 8;
const machine = (location: Location | undefined) => location?.kind === 'remote' ? location.hostId : 'local';

/**
 * DSH treats a session with no turn as blank: it shows the start page whatever rows the session holds, and hands the
 * session out again as the next new conversation. An empty finished turn makes it a conversation without calling a model.
 */
function ensureConversation(agent: LiveAgent): boolean {
  if (agent.phase?.kind !== 'idle' || agent.phase.lastTurn || agent.session.deriveMessages?.().length) return false;
  agent.session.append('turn/start', { turn: 1 });
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  agent.phase.lastTurn = 1;
  return true;
}

export class FixCommand {
  /** Only this process knows the mark, so a card cannot be forged by typing. */
  private readonly mark = `${MARK}${randomUUID()}:`;
  private last: { sessionId: string; at: number } | undefined;
  constructor(private readonly host: CommandHost) {}
  private now(): number { return this.host.now?.() ?? Date.now(); }

  /** The line that puts card number `card` of a task into a conversation. */
  cardLine(key: string, card: number): string { return `/${COMMAND} ${this.mark}${card}:${key}`; }
  /** The conversation that took the newest typed /fix: the new-conversation page does not open it by itself. */
  lastCommand(maxAge: number): string | undefined { return this.last && this.now() - this.last.at <= maxAge ? this.last.sessionId : undefined; }

  private row(task: Task, meta: RowMeta = {}): RowResult { return { kind: 'success', text: rowText(`${task.item.ref} · ${task.item.title}`, { key: task.key, ...meta }) }; }

  async handle({ agent, rawInput, attachments = [] }: Invocation): Promise<RowResult> {
    const input = rawInput.trim(), { store } = this.host;
    if (input.startsWith(this.mark)) {
      const [, card, key] = /^(\d+):(.+)$/su.exec(input.slice(this.mark.length)) ?? [], task = key ? store.tasks[key] : undefined;
      return task ? this.row(task, { card: Number(card), home: true }) : { kind: 'error', text: 'This task is gone.' };
    }
    return this.take(agent, input, attachments);
  }

  /**
   * What was typed becomes a task in the repository the conversation works in, and the row that follows it. `options`
   * are for a task another plugin hands in (/flow in a worktree of its own): what kind it is, and what its line chose.
   */
  async take(agent: LiveAgent, text: string, attachments: readonly { type: string; attachment?: unknown }[] = [], options: TakeOptions = {}): Promise<RowResult> {
    const input = text.trim(), { store, tasks } = this.host, feature = options.kind === 'feature';
    const how: Handed = { ...(feature ? { kind: 'feature' as const } : {}), ...(options.models ? { models: options.models } : {}), ...(options.rounds ? { rounds: options.rounds } : {}) };
    this.last = { sessionId: agent.id, at: this.now() };
    try {
      // A conversation that began with this line is named after what was typed, like one that began with a message.
      const blank = ensureConversation(agent), name = async (title: string) => { if (blank && title) await this.host.title?.(agent, [...title].slice(0, 60).join('').trim()).catch(() => undefined); };
      if (attachments.some(block => block.type !== 'image' || !block.attachment)) throw fail(feature ? 'Only pictures can go along with a flow that runs in a worktree of its own' : 'Only pictures can be sent along with /fix');
      const pictures = attachments.map(block => block.attachment);
      if (pictures.length > MAX_PICTURES) throw fail('At most {count} pictures', { count: String(MAX_PICTURES) });
      // In a task's own conversation there is one thing a person can mean: this is what is still wrong.
      const own = Object.values(store.tasks).find(task => task.sessionId === agent.id);
      if (own) {
        if (!input && !pictures.length) return this.row(own);
        if (options.repo || options.branch || /^(?:repo|branch|仓库|分支)\s*[=＝:：]/iu.test(input)) throw fail('This conversation belongs to {ref}: what you type after /fix here is sent back to its models. File another bug from a conversation of the project.', { ref: own.item.ref });
        await tasks.sendBack(own.key, input, [], pictures);
        return { kind: 'success', text: rowText(`${own.item.ref}: sent back`, { said: pictures.length ? say('Sent back with {count} pictures: {note}', { count: String(pictures.length), note: input }) : say('Sent back: {note}', { note: input }) }) };
      }
      const line = { ...parseFix(input), ...(options.repo ? { repo: options.repo } : {}), ...(options.branch ? { branch: options.branch } : {}) };
      if (!line.title && !pictures.length) throw fail(feature ? 'Say what to build' : 'Say what is wrong after /fix, and paste screenshots if they help. repo=<name> and branch=<name> may lead the line.');
      let route: Route;
      try { route = await this.route(agent, line.repo); }
      catch (error) {
        // Not a repository of this DSH: another one may run fixes for the machine this conversation works on.
        const folder = this.host.folder(agent), handed = folder ? await this.host.handOver?.(folder, line, pictures, how) : undefined;
        if (!handed || !folder) throw store.settings.routes.length ? error : fail('Nothing can take this bug yet. Add the repository in Settings → Autofix here; or, if another DSH should run the fix, add it there and switch on taking bugs from other DSHes.');
        await name(line.title);
        return { kind: 'success', text: rowText(`${handed.ref} · ${handed.title}`, { key: handed.key, at: folder }) };
      }
      const branch = line.branch || route.defaultBranch || (await this.host.inspect(route.project).catch(() => undefined))?.defaultBase || '';
      if (!branch) throw fail('{route} has no default branch; choose a branch for this bug', { route: route.name });
      const { key } = await this.host.createManual({ title: line.title || 'See the attached pictures', body: line.body, attached: pictures.length, assignment: { routeId: route.id, branch }, ...(feature ? { kind: 'feature' } : {}) });
      const task = await tasks.start(key, pictures, how);
      await name(line.title);
      return this.row(task);
    } catch (error) {
      const said = messageOf(error);
      return { kind: 'error', text: rowText(render(said), { said }) };
    }
  }

  /** The repository a bug typed here belongs to: the one named, or the one this conversation works in. */
  private async route(agent: LiveAgent, name: string | undefined): Promise<Route> {
    const { routes } = this.host.store.settings, names = routes.map(route => route.name).join(', ');
    if (!routes.length) throw fail('Add a repository in Settings → Autofix so bugs have somewhere to go.');
    if (name) {
      const wanted = name.toLowerCase(), exact = routes.filter(route => route.name.toLowerCase() === wanted || route.id.toLowerCase() === wanted);
      const found = exact.length ? exact : routes.filter(route => route.name.toLowerCase().startsWith(wanted));
      if (found.length !== 1) throw fail('No repository is called {name}. There are: {names}', { name, names });
      return found[0];
    }
    const folder = this.host.folder(agent);
    if (folder) {
      const exact = routes.find(route => route.project === folder);
      if (exact) return exact;
      // A conversation in a fix's worktree is still about that fix's repository.
      const task = Object.values(this.host.store.tasks).find(entry => entry.workspacePath === folder), known = task && routes.find(route => route.id === task.routeId);
      if (known) return known;
      // Another workspace of the same repository: the same main folder on the same machine.
      const here = await this.host.inspect(folder).catch(() => undefined);
      if (here?.repository) {
        for (const route of routes) {
          const there = await this.host.inspect(route.project).catch(() => undefined);
          if (there?.repository === here.repository && machine(there.location) === machine(here.location)) return route;
        }
      }
    }
    if (routes.length === 1) throw fail('This conversation is not in {route}. Open a conversation there, or start the line with repo={route}.', { route: routes[0].name });
    throw fail('This conversation is not in a repository Autofix knows. Start the line with repo=<name>. There are: {names}', { names });
  }
}
