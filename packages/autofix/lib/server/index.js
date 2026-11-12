import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { COMMAND, FixCommand } from './command.js';
import { Conversations } from './conversations.js';
import { Folders } from './folders.js';
import { API_PATH, createHandler } from './http.js';
import { ManualSource } from './manual.js';
import { missingPlugins } from './needs.js';
import { RelayClient, RelayServer } from './relay.js';
import { AutofixService, Sources } from './service.js';
import { LocalFiles, Store } from './store.js';
import { Tasks } from './tasks.js';
import { Workplaces } from './workplaces.js';
export const name = 'dsh-autofix';
export const inject = ['connection', 'commands'];
export { API_PATH, COMMAND };
const LAST_COMMAND_AGE = 15_000;
/** How other DSHes name this one; made once and kept. */
async function identityOf(file) {
    const name = hostname().replace(/\.local$/u, '') || 'DSH';
    try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        if (typeof saved.id === 'string' && saved.id)
            return { id: saved.id, name };
    }
    catch { /* The first start. */ }
    const id = randomUUID();
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ id }), { mode: 0o600 });
    return { id, name };
}
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export async function apply(ctx) {
    // Other plugins' services are looked up when they are needed: plugins load in any order, and may be updated while this one runs.
    const lookup = (wanted) => ctx.get(wanted);
    const store = new Store(new LocalFiles(stateDir()));
    await store.open();
    const sources = new Sources(), workplaces = new Workplaces(lookup);
    const conversations = new Conversations(lookup);
    // Late, because the command needs the tasks and the tasks announce through the command.
    let command;
    const tasks = new Tasks({
        store, source: id => sources.get(id), workplaces, conversations,
        announce: async (task) => { if (command && task.sessionId)
            await conversations.command(task.sessionId, command.cardLine(task.key, task.cards ?? 1)); },
    });
    // Bugs can always be typed in; every other source is a plugin of its own.
    const manual = new ManualSource(join(stateDir(), 'manual'));
    sources.register(manual);
    // A repository can be another DSH's to fix: both reach the machine that holds it, and meet there.
    const relayClient = new RelayClient({ machine: folder => workplaces.machine(folder), inspect: folder => workplaces.inspect(folder), readImage: ref => conversations.image(ref) });
    let relayServer;
    const service = new AutofixService({ store, tasks, sources, workplaces, manual, folders: new Folders(lookup), relay: () => relayServer?.status ?? [], needs: () => missingPlugins(lookup) });
    const served = relayServer = new RelayServer({
        store, tasks, identity: await identityOf(join(stateDir(), 'identity.json')),
        machine: project => workplaces.machine(project), inspect: project => workplaces.inspect(project),
        createManual: input => service.createManual(input), view: key => service.task(key), diff: key => service.diff(key),
    });
    served.start();
    ctx.effect(() => () => served.stop());
    const fix = command = new FixCommand({
        store, tasks, createManual: input => service.createManual(input), inspect: project => workplaces.inspect(project),
        handOver: (folder, line, pictures) => relayClient.file(folder, line, pictures),
        folder: agent => { try {
            return lookup('workingDirectory')?.get(agent.session);
        }
        catch {
            return undefined;
        } },
    });
    ctx.connection.fetch.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: createHandler(service, tasks, { lastCommand: () => fix.lastCommand(LAST_COMMAND_AGE) }, relayClient) });
    ctx.effect(() => ctx.commands.register({
        name: COMMAND, recordInput: false,
        description: 'hand a bug to models: it is fixed in its own worktree, and nothing is pushed before you accept it',
        input: { hint: '[repo=name] [branch=name] <what is wrong>', attachments: true },
        handler: invocation => fix.handle(invocation),
    }));
    // Sources are plugins of their own: an issue tracker, an alert, anything that knows about bugs.
    ctx.provide('autofix', { version: 1, register: source => service.register(source), submit: (sourceId, items) => service.submit(sourceId, items) });
    ctx.effect(() => () => tasks.close());
}
