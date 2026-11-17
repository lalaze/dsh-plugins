import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { COMMAND, FixCommand, type Invocation, type LiveAgent, type RowResult } from './command.js';
import { Conversations } from './conversations.js';
import type { Autofix } from './domain.js';
import { Folders } from './folders.js';
import { API_PATH, createHandler } from './http.js';
import { ManualSource } from './manual.js';
import { missingPlugins } from './needs.js';
import { AutofixService, Sources } from './service.js';
import { LocalFiles, Store } from './store.js';
import { runChoice, Tasks } from './tasks.js';
import { Workplaces } from './workplaces.js';

export const name = 'dsh-autofix';
export const inject = ['connection', 'commands'];
export { API_PATH, COMMAND };
export type { Autofix, Item, ItemEvent, Message, Source } from './domain.js';
/** DSH's commands, as far as this plugin uses them. */
interface Commands { register(definition: { name: string; description: string; recordInput?: boolean; input?: { hint: string; attachments?: boolean }; handler(invocation: Invocation): Promise<RowResult> }): () => void }
const LAST_COMMAND_AGE = 15_000;
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);

export async function apply(ctx: Context): Promise<void> {
  // Other plugins' services are looked up when they are needed: plugins load in any order, and may be updated while this one runs.
  const lookup = (wanted: string) => ctx.get(wanted as never) as unknown;
  const store = new Store(new LocalFiles(stateDir()));
  await store.open();
  const sources = new Sources(), workplaces = new Workplaces(lookup);
  const conversations = new Conversations(lookup);
  // Late, because the command needs the tasks and the tasks announce through the command.
  let command: FixCommand | undefined;
  const tasks = new Tasks({
    store, source: id => sources.get(id), workplaces, conversations,
    announce: async task => { if (command && task.sessionId) await conversations.command(task.sessionId, command.cardLine(task.key, task.cards ?? 1)); },
  });
  // Bugs can always be typed in; every other source is a plugin of its own.
  const manual = new ManualSource(join(stateDir(), 'manual'));
  sources.register(manual);
  const service = new AutofixService({ store, tasks, sources, workplaces, manual, folders: new Folders(lookup), needs: () => missingPlugins(lookup) });
  const fix = command = new FixCommand({
    store, tasks, createManual: input => service.createManual(input), inspect: project => workplaces.inspect(project),
    title: async (agent, title) => { await (lookup('sessionController') as { rename?(input: { sessionId: string; title: string }): Promise<unknown> } | undefined)?.rename?.({ sessionId: agent.id, title }); },
    folder: agent => { try { return (lookup('workingDirectory') as { get(session: unknown): string } | undefined)?.get(agent.session); } catch { return undefined; } },
  });
  ctx.connection.fetch.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: createHandler(service, tasks, { lastCommand: () => fix.lastCommand(LAST_COMMAND_AGE) }) });
  ctx.effect(() => (ctx as unknown as { commands: Commands }).commands.register({
    name: COMMAND, recordInput: false,
    description: 'hand a bug to models: it is fixed in its own worktree, and nothing is pushed before you accept it',
    input: { hint: '[repo=name] [branch=name] <what is wrong>', attachments: true },
    handler: invocation => fix.handle(invocation),
  }));
  // Sources are plugins of their own: an issue tracker, an alert, anything that knows about bugs.
  ctx.provide('autofix', {
    version: 1, register: source => service.register(source), submit: (sourceId, items) => service.submit(sourceId, items),
    // Another plugin's words are checked like a page's: only what a task can carry gets through.
    file: input => fix.take(input.agent as LiveAgent, typeof input.text === 'string' ? input.text : '', (Array.isArray(input.attachments) ? input.attachments : []) as { type: string; attachment?: unknown }[], {
      ...(input.kind === 'feature' ? { kind: 'feature' as const } : {}), ...runChoice(input),
      ...(typeof input.repo === 'string' && input.repo.trim() ? { repo: input.repo.trim().slice(0, 200) } : {}), ...(typeof input.branch === 'string' && input.branch.trim() ? { branch: input.branch.trim().slice(0, 200) } : {}),
    }),
  } satisfies Autofix);
  ctx.effect(() => () => tasks.close());
}
