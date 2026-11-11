/**
 * /fix in a conversation: the bug goes to the repository that conversation works in, and a card follows it there. In a
 * task's own conversation the same command sends the fix back with what was typed.
 */
import { randomUUID } from 'node:crypto';
import { fail, messageOf, render, say } from './domain.js';
import { parseFix } from './fixline.js';
import { COMMAND, MARK, rowText } from './shared.js';
export { COMMAND };
const MAX_PICTURES = 8;
const machine = (location) => location?.kind === 'remote' ? location.hostId : 'local';
/**
 * DSH treats a session with no turn as blank: it shows the start page whatever rows the session holds, and hands the
 * session out again as the next new conversation. An empty finished turn makes it a conversation without calling a model.
 */
function ensureConversation(agent) {
    if (agent.phase?.kind !== 'idle' || agent.phase.lastTurn || agent.session.deriveMessages?.().length)
        return;
    agent.session.append('turn/start', { turn: 1 });
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    agent.phase.lastTurn = 1;
}
export class FixCommand {
    host;
    /** Only this process knows the mark, so a card cannot be forged by typing. */
    mark = `${MARK}${randomUUID()}:`;
    last;
    constructor(host) {
        this.host = host;
    }
    now() { return this.host.now?.() ?? Date.now(); }
    /** The line that puts card number `card` of a task into a conversation. */
    cardLine(key, card) { return `/${COMMAND} ${this.mark}${card}:${key}`; }
    /** The conversation that took the newest typed /fix: the new-conversation page does not open it by itself. */
    lastCommand(maxAge) { return this.last && this.now() - this.last.at <= maxAge ? this.last.sessionId : undefined; }
    row(task, meta = {}) { return { kind: 'success', text: rowText(`${task.item.ref} · ${task.item.title}`, { key: task.key, ...meta }) }; }
    async handle({ agent, rawInput, attachments = [] }) {
        const input = rawInput.trim(), { store, tasks } = this.host;
        if (input.startsWith(this.mark)) {
            const [, card, key] = /^(\d+):(.+)$/su.exec(input.slice(this.mark.length)) ?? [], task = key ? store.tasks[key] : undefined;
            return task ? this.row(task, { card: Number(card), home: true }) : { kind: 'error', text: 'This task is gone.' };
        }
        this.last = { sessionId: agent.id, at: this.now() };
        try {
            ensureConversation(agent);
            if (attachments.some(block => block.type !== 'image' || !block.attachment))
                throw fail('Only pictures can be sent along with /fix');
            const pictures = attachments.map(block => block.attachment);
            if (pictures.length > MAX_PICTURES)
                throw fail('At most {count} pictures', { count: String(MAX_PICTURES) });
            // In a task's own conversation there is one thing a person can mean: this is what is still wrong.
            const own = Object.values(store.tasks).find(task => task.sessionId === agent.id);
            if (own) {
                if (!input && !pictures.length)
                    return this.row(own);
                if (/^(?:repo|branch|仓库|分支)\s*[=＝:：]/iu.test(input))
                    throw fail('This conversation belongs to {ref}: what you type after /fix here is sent back to its models. File another bug from a conversation of the project.', { ref: own.item.ref });
                await tasks.sendBack(own.key, input, [], pictures);
                return { kind: 'success', text: rowText(`${own.item.ref}: sent back`, { said: pictures.length ? say('Sent back with {count} pictures: {note}', { count: String(pictures.length), note: input }) : say('Sent back: {note}', { note: input }) }) };
            }
            const line = parseFix(input);
            if (!line.title && !pictures.length)
                throw fail('Say what is wrong after /fix, and paste screenshots if they help. repo=<name> and branch=<name> may lead the line.');
            let route;
            try {
                route = await this.route(agent, line.repo);
            }
            catch (error) {
                // Not a repository of this DSH: another one may run fixes for the machine this conversation works on.
                const folder = this.host.folder(agent), handed = folder ? await this.host.handOver?.(folder, line, pictures) : undefined;
                if (!handed || !folder)
                    throw store.settings.routes.length ? error : fail('Nothing can take this bug yet. Add the repository in Settings → Autofix here; or, if another DSH should run the fix, add it there and switch on taking bugs from other DSHes.');
                return { kind: 'success', text: rowText(`${handed.ref} · ${handed.title}`, { key: handed.key, at: folder }) };
            }
            const branch = line.branch || route.defaultBranch || (await this.host.inspect(route.project).catch(() => undefined))?.defaultBase || '';
            if (!branch)
                throw fail('{route} has no default branch; choose a branch for this bug', { route: route.name });
            const { key } = await this.host.createManual({ title: line.title || 'See the attached pictures', body: line.body, attached: pictures.length, assignment: { routeId: route.id, branch } });
            return this.row(await tasks.start(key, pictures));
        }
        catch (error) {
            const said = messageOf(error);
            return { kind: 'error', text: rowText(render(said), { said }) };
        }
    }
    /** The repository a bug typed here belongs to: the one named, or the one this conversation works in. */
    async route(agent, name) {
        const { routes } = this.host.store.settings, names = routes.map(route => route.name).join(', ');
        if (!routes.length)
            throw fail('Add a repository in Settings → Autofix so bugs have somewhere to go.');
        if (name) {
            const wanted = name.toLowerCase(), exact = routes.filter(route => route.name.toLowerCase() === wanted || route.id.toLowerCase() === wanted);
            const found = exact.length ? exact : routes.filter(route => route.name.toLowerCase().startsWith(wanted));
            if (found.length !== 1)
                throw fail('No repository is called {name}. There are: {names}', { name, names });
            return found[0];
        }
        const folder = this.host.folder(agent);
        if (folder) {
            const exact = routes.find(route => route.project === folder);
            if (exact)
                return exact;
            // A conversation in a fix's worktree is still about that fix's repository.
            const task = Object.values(this.host.store.tasks).find(entry => entry.workspacePath === folder), known = task && routes.find(route => route.id === task.routeId);
            if (known)
                return known;
            // Another workspace of the same repository: the same main folder on the same machine.
            const here = await this.host.inspect(folder).catch(() => undefined);
            if (here?.repository) {
                for (const route of routes) {
                    const there = await this.host.inspect(route.project).catch(() => undefined);
                    if (there?.repository === here.repository && machine(there.location) === machine(here.location))
                        return route;
                }
            }
        }
        if (routes.length === 1)
            throw fail('This conversation is not in {route}. Open a conversation there, or start the line with repo={route}.', { route: routes[0].name });
        throw fail('This conversation is not in a repository Autofix knows. Start the line with repo=<name>. There are: {names}', { names });
    }
}
