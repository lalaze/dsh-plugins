import { ACTIVE, fail, Failure, messageOf, say } from './domain.js';
import { addedLines, blocked, changedFiles, chooseScript, commands, touched, warnings } from './gate.js';
import { MANUAL } from './manual.js';
import { prefixKey, projectKey } from './pool.js';
import { branchName, commitMessage, conversationTitle, mergeMessage, taskGoal } from './prompts.js';
const ROLES = ['plan', 'implement', 'review'];
const MAX_ROUNDS = 10;
/** Checked, because it may come from another computer: a model per step as short text, and a sensible number of rounds. */
export function runChoice(raw) {
    const input = raw && typeof raw === 'object' ? raw : {}, given = input.models && typeof input.models === 'object' ? input.models : {};
    const models = Object.fromEntries(ROLES.flatMap(role => typeof given[role] === 'string' && given[role].trim() && given[role].length <= 300 ? [[role, given[role].trim()]] : []));
    const rounds = typeof input.rounds === 'number' && Number.isSafeInteger(input.rounds) && input.rounds >= 1 && input.rounds <= MAX_ROUNDS ? input.rounds : undefined;
    return { ...(Object.keys(models).length ? { models } : {}), ...(rounds ? { rounds } : {}) };
}
const TEST_TIMEOUT = 30 * 60_000;
const GIT_NETWORK_TIMEOUT = 160_000;
const TAIL = 4000;
const STEP_BODY = 4000;
const PACKAGE_JSON_LIMIT = 512 * 1024;
const short = (commit) => commit.slice(0, 9);
const message = (error) => error instanceof Error ? error.message : String(error);
const gitSaid = (result) => (result.stderr.trim() || result.stdout.trim()).slice(-1500);
function endSaid(end) {
    switch (end.kind) {
        case 'rejected': return say('The review still did not pass after {rounds} rounds. Read its findings in the conversation, then send the task back with what to do.', { rounds: String(end.rounds) });
        case 'failed': return say('The {role} step failed', { role: end.role }, end.reason);
        case 'noVerdict': return say('The review gave no verdict twice.');
        default: return say('The flow stopped.');
    }
}
export class Tasks {
    host;
    live = new Map();
    constructor(host) {
        this.host = host;
    }
    now() { return this.host.now?.() ?? Date.now(); }
    note(task, said) { const at = this.now(); task.updatedAt = at; task.events.push({ at, said }); }
    async save() { await this.host.store.saveTasks(); this.host.changed?.(); }
    async move(task, status, said) {
        task.status = status;
        task.updatedAt = this.now();
        if (said)
            this.note(task, said);
        await this.save();
    }
    /** A card in the task's own conversation, where the person reads the work and decides. Without one the board still shows the task. */
    async announce(task) {
        if (!task.sessionId || !this.host.announce)
            return;
        task.cards = (task.cards ?? 0) + 1;
        try {
            await this.host.announce(task);
        }
        catch {
            task.cards--;
        }
        await this.save().catch(() => undefined);
    }
    route(id) {
        const route = this.host.store.settings.routes.find(entry => entry.id === id);
        if (!route)
            throw fail('The repository this bug was assigned to is no longer in the settings');
        return route;
    }
    task(key) {
        const task = this.host.store.tasks[key];
        if (!task)
            throw fail('There is no task for this bug');
        return task;
    }
    running(key) { return this.live.has(key); }
    /** The flow a task is in right now, as its card shows it; undefined when no flow runs or it cannot say. */
    progress(key) {
        try {
            return this.live.get(key)?.flow?.progress?.();
        }
        catch {
            return undefined;
        }
    }
    /** What one step of a task's newest flow said in full. */
    stepBody(key, index) {
        let live;
        try {
            live = this.live.get(key)?.flow?.stepBody?.(index);
        }
        catch { /* What was kept when the flow ended, below. */ }
        return live ?? this.host.store.tasks[key]?.flow?.steps[index]?.body;
    }
    /** Resolves when the task's current run has ended, however it ended. */
    idle(key) { return this.live.get(key)?.settled ?? Promise.resolve(); }
    /** Runs in the background; a failure lands on the task instead of the caller. */
    drive(task, run, failed = reason => { task.status = 'failed'; task.error = reason; }) {
        const live = { controller: new AbortController(), settled: Promise.resolve() };
        this.live.set(task.key, live);
        live.settled = (async () => {
            let broke = false;
            try {
                await run(live.controller.signal, live);
            }
            catch (error) {
                if (live.controller.signal.aborted) {
                    task.status = 'stopped';
                    task.error = undefined;
                    this.note(task, say('Stopped'));
                }
                else {
                    const reason = messageOf(error);
                    failed(reason);
                    this.note(task, reason);
                    broke = task.status === 'failed';
                }
            }
            finally {
                this.live.delete(task.key);
                task.updatedAt = this.now();
                await this.save().catch(() => undefined);
                if (broke && !live.carded)
                    await this.announce(task);
            }
        })();
    }
    /** Tells the item's source what happened. Whatever it answers, what already happened in Git stands. */
    async report(task, event) {
        const source = this.host.source(task.item.source);
        if (!source?.report)
            return !!source;
        try {
            await source.report(task.item, event);
            return true;
        }
        catch (error) {
            this.note(task, say('{source} was not updated', { source: source.name }, message(error)));
            return false;
        }
    }
    /** The tracker's name for the models; a bug a person typed in has none. */
    sourceName(task) { return task.item.source === MANUAL ? undefined : this.host.source(task.item.source)?.name ?? task.item.source; }
    /**
     * Starts the bug as its pool entry says: repository, branch, and the package if one was chosen. `pictures` are ones DSH
     * already keeps (sent along in a conversation), in the order the bug's text names them. `choice` is what this task
     * alone runs with, instead of the settings.
     */
    async start(key, pictures = [], choice = {}) {
        const { store } = this.host, item = store.pool[key];
        if (!item)
            throw fail('This bug is not in the pool');
        if (!item.assignment)
            throw fail('Choose a repository and a branch for this bug first');
        if (this.live.has(key) || (store.tasks[key] && ACTIVE.includes(store.tasks[key].status)))
            throw fail('This bug already has a running task');
        const route = this.route(item.assignment.routeId), deny = store.settings.run.denyLabels.map(label => label.toLowerCase());
        const denied = item.item.labels.find(label => deny.includes(label.toLowerCase()));
        if (denied)
            throw fail('Bugs labelled "{label}" are not handed to models. Remove the label from the list in the settings if this one should be.', { label: denied });
        const at = this.now();
        const task = {
            key, item: item.item, routeId: route.id, baseBranch: item.assignment.branch || route.defaultBranch,
            ...(item.assignment.package ? { packageHint: item.assignment.package } : {}),
            ...(pictures.length ? { pictures: pictures.map((ref, index) => ({ index, ref })) } : {}),
            ...runChoice(choice),
            status: 'preparing', attempts: 0, startedAt: at, updatedAt: at, events: [{ at, said: say('Started in {route} from {branch}', { route: route.name, branch: item.assignment.branch || route.defaultBranch }) }],
        };
        if (!task.baseBranch)
            throw fail('{route} has no default branch; choose a branch for this bug', { route: route.name });
        store.tasks[key] = task;
        await this.save();
        this.drive(task, async (signal, live) => { await this.prepare(task, route, signal); await this.work(task, route, signal, live, {}); });
        return task;
    }
    async prepare(task, route, signal) {
        const { run } = this.host.store.settings;
        await this.report(task, { kind: 'started', baseBranch: task.baseBranch });
        const created = await this.host.workplaces.create({ project: route.project, base: task.baseBranch, branch: branchName(task.item) }, signal);
        Object.assign(task, { branch: created.branch, worktree: created.worktree, workspacePath: created.path });
        this.note(task, say('Worktree on {branch}', { branch: created.branch }));
        for (const warning of created.warnings)
            this.note(task, say(warning));
        await this.save();
        const opened = await this.host.conversations.open({ path: created.path, title: conversationTitle(task.item), ...(run.model ? { model: run.model } : {}), permission: run.permission });
        task.sessionId = opened.sessionId;
        await this.pictures(task, signal);
        await this.save();
    }
    /** The bug's pictures, from its source into DSH's attachment store, so every step of every flow can be given them. */
    async pictures(task, signal) {
        const count = task.item.images ?? 0, source = this.host.source(task.item.source);
        if (!count)
            return;
        const kept = [];
        for (let index = 0; index < count; index++) {
            try {
                const image = await source?.image?.(task.item, index, signal);
                if (image)
                    kept.push({ index, ref: await this.host.conversations.picture(image) });
            }
            catch { /* Counted below: a bug with a picture missing is still a bug to fix. */ }
            signal.throwIfAborted();
        }
        task.pictures = kept;
        if (kept.length < count)
            this.note(task, say('{missing} of the bug\'s {count} pictures could not be loaded', { missing: String(count - kept.length), count: String(count) }));
    }
    /** Flow, checks, commit; a failed check goes back to the models as long as retries are left. */
    async work(task, route, signal, live, first) {
        const { run } = this.host.store.settings;
        // What the person sent back with: for the flow that answers it, not for a later one that only repairs a failed check.
        let feedback = first.feedback, added = first.pictures ?? [], failedCheck, retries = run.checkRetries;
        for (;;) {
            signal.throwIfAborted();
            task.attempts++;
            task.error = undefined;
            task.check = undefined;
            live.carded = false;
            await this.move(task, 'working');
            const pictures = task.pictures ?? [];
            const sourceName = this.sourceName(task);
            const goal = taskGoal({ item: task.item, ...(sourceName ? { sourceName } : {}), attached: pictures.map(picture => picture.index), route, baseBranch: task.baseBranch, ...(task.packageHint ? { packageHint: task.packageHint } : {}), ...(feedback !== undefined ? { feedback, feedbackPictures: added.length } : {}), ...(failedCheck ? { failedCheck } : {}), continued: task.attempts > 1 });
            const attachments = [...pictures.map(picture => picture.ref), ...added].map(ref => ({ type: 'image', attachment: ref }));
            const models = { ...run.flowModels, ...task.models };
            // The flow's card in the conversation is this task's card: the tag says which task, and which of its flows.
            const input = { goal, rounds: task.rounds ?? run.rounds, ...(Object.keys(models).length ? { models } : {}), tag: `autofix:${task.attempts}:${task.key}` };
            let flow;
            try {
                flow = await this.host.conversations.flow(task.sessionId, { ...input, ...(attachments.length ? { attachments } : {}) });
            }
            catch (error) {
                // One of the flow's models cannot see pictures: the bug still gets its chance, from the text alone.
                if (!attachments.length || error.code !== 'flow/images-unsupported')
                    throw error;
                this.note(task, say('The pictures were left out', undefined, message(error)));
                task.pictures = [];
                added = [];
                flow = await this.host.conversations.flow(task.sessionId, { ...input, goal: taskGoal({ item: task.item, ...(sourceName ? { sourceName } : {}), attached: [], route, baseBranch: task.baseBranch, ...(task.packageHint ? { packageHint: task.packageHint } : {}), ...(feedback !== undefined ? { feedback } : {}), ...(failedCheck ? { failedCheck } : {}), continued: task.attempts > 1 }) });
            }
            live.flow = flow;
            const stop = () => flow.stop();
            signal.addEventListener('abort', stop, { once: true });
            if (signal.aborted)
                stop();
            // A flow that can say how far it is has a card that shows it; the task keeps what the card shows, for the board and for other DSHes.
            const startedAt = this.now();
            let shape = {}, seen = '';
            const look = () => {
                let now;
                try {
                    now = flow.progress?.();
                }
                catch { /* It says nothing this time. */ }
                if (!now)
                    return;
                shape = { rounds: now.rounds, ...(now.planned !== undefined ? { planned: now.planned } : {}), zh: now.zh, startedAt, carded: true };
                const steps = now.steps.map(({ body: _body, ms, ...step }) => ({ ...step, ...(step.status !== 'running' && ms !== undefined ? { ms } : {}) }));
                const said = JSON.stringify(steps.map(step => [step.role, step.round, step.status, step.childId]));
                if (said === seen)
                    return;
                seen = said;
                task.flow = { steps, ...shape };
                void this.save().catch(() => undefined);
            };
            look();
            live.carded = !!shape.carded;
            // Earlier cards in the conversation stand back for this one.
            if (live.carded) {
                task.cards = (task.cards ?? 0) + 1;
                await this.save().catch(() => undefined);
            }
            const watch = live.carded ? setInterval(look, this.host.progressMs ?? 1000) : undefined;
            watch?.unref?.();
            let result;
            try {
                result = await flow.done;
            }
            finally {
                clearInterval(watch);
                signal.removeEventListener('abort', stop);
                live.flow = undefined;
            }
            task.flow = { steps: result.steps.map(step => step.body && step.body.length > STEP_BODY ? { ...step, body: `${step.body.slice(0, STEP_BODY)}…` } : step), end: result.end, ...(result.report ? { report: result.report } : {}), ...shape };
            // Stopped from the flow's own card in the conversation: the task stops too.
            if (result.end.kind === 'stopped') {
                live.controller.abort();
                signal.throwIfAborted();
            }
            if (result.end.kind !== 'passed')
                throw new Failure(endSaid(result.end));
            await this.move(task, 'checking', say('Review passed in round {round}', { round: String(result.end.round) }));
            const machine = await this.host.workplaces.machine(task.workspacePath, signal);
            const failure = await this.check(task, route, machine, signal);
            if (failure) {
                if (retries-- > 0) {
                    this.note(task, say('A check failed; sent back to the models'));
                    feedback = undefined;
                    added = [];
                    failedCheck = failure;
                    continue;
                }
                throw fail('A check failed', undefined, failure);
            }
            const [committed] = await machine.git([{ argv: ['commit', '-q', '-m', commitMessage(task.item)] }], { signal });
            if (committed.code !== 0)
                throw fail('Git could not commit the fix', undefined, gitSaid(committed));
            const [head] = await machine.git([{ argv: ['rev-parse', 'HEAD'] }], { reads: true, signal });
            task.commit = head.stdout.trim();
            task.feedback = undefined;
            await this.move(task, 'review', say('Committed {commit}; waiting for you', { commit: short(task.commit) }));
            await this.report(task, { kind: 'review', branch: task.branch, commit: task.commit, checks: task.check?.runs.length ?? 0 });
            await this.save();
            if (!live.carded)
                await this.announce(task);
            return;
        }
    }
    /** Stages everything, refuses what must never be committed, then runs the repository's checks. Returns what failed. */
    async check(task, route, machine, signal) {
        const [staged] = await machine.git([{ argv: ['add', '-A'] }], { signal });
        if (staged.code !== 0)
            throw fail('Git could not stage the changes', undefined, gitSaid(staged));
        const [status, diff] = await machine.git([{ argv: ['status', '--porcelain=v1', '-z'] }, { argv: ['diff', '--cached', '--no-color', '--no-ext-diff', 'HEAD'] }], { reads: true, signal });
        if (status.code !== 0 || diff.code !== 0)
            throw fail('Git could not read the changes', undefined, gitSaid(status.code !== 0 ? status : diff));
        const files = changedFiles(status.stdout), reason = blocked(files, addedLines(diff.stdout));
        if (reason)
            throw new Failure(reason);
        const found = touched(files, route), targets = found.packages.length ? found.packages : task.packageHint ? [task.packageHint] : [];
        const packages = await Promise.all(targets.map(async (path) => ({ path, script: route.buildScripts.length ? chooseScript(await machine.read(`${path}/package.json`, PACKAGE_JSON_LIMIT, signal), route.buildScripts) : undefined })));
        const plan = commands(route.tests, packages);
        task.check = { files, packages: found.packages, warnings: [...warnings(found, route, task.packageHint), ...plan.skipped], runs: [] };
        await this.save();
        for (const command of plan.run) {
            const startedAt = this.now();
            let tail = '';
            const code = await machine.shell(command, {}, text => { tail = (tail + text).slice(-TAIL); }, AbortSignal.any([signal, AbortSignal.timeout(TEST_TIMEOUT)]));
            signal.throwIfAborted();
            task.check.runs.push({ command, code, ms: this.now() - startedAt, tail });
            await this.save();
            if (code !== 0)
                return `$ ${command}\n(${code === null ? 'stopped after 30 minutes' : `exit code ${code}`})\n${tail}`;
        }
        return undefined;
    }
    /** Ends whatever the task is doing. False when it was doing nothing. */
    stop(key) {
        const live = this.live.get(key);
        if (!live)
            return false;
        live.controller.abort();
        return true;
    }
    /**
     * Back to the models in the same worktree and conversation, with what the person said and the pictures they added.
     * `kept` are pictures DSH already keeps, as when they came with a line typed in the conversation.
     */
    async sendBack(key, feedback, pictures = [], kept = []) {
        const task = this.task(key), note = feedback.trim();
        if (this.live.has(key))
            throw fail('This task is still running');
        if (!['review', 'failed', 'stopped'].includes(task.status))
            throw fail('This task is finished');
        if (!task.sessionId || !task.workspacePath)
            throw fail('This task never got a worktree; start it again from the pool');
        if (task.status === 'review' && !note && !pictures.length && !kept.length)
            throw fail('Say what should change');
        const route = this.route(task.routeId);
        // Before anything changes: a picture DSH will not take is the person's to fix, with the task still as it was.
        const refs = [...kept];
        for (const [index, picture] of pictures.entries()) {
            try {
                refs.push(await this.host.conversations.picture(picture));
            }
            catch (error) {
                throw fail('Picture {index} could not be added', { index: String(index + 1) }, message(error));
            }
        }
        const said = note || refs.length;
        if (note)
            task.feedback = note;
        this.note(task, !said ? say('Continued') : refs.length ? say('Sent back with {count} pictures: {note}', { count: String(refs.length), note }) : say('Sent back: {note}', { note }));
        task.status = 'working';
        await this.save();
        this.drive(task, (signal, live) => this.work(task, route, signal, live, said ? { feedback: note, pictures: refs } : {}));
        return task;
    }
    /** The fix goes where the repository's setting says, then its source is told. */
    async accept(key) {
        const task = this.task(key), { store } = this.host;
        if (this.live.has(key))
            throw fail('This task is still running');
        if (task.status !== 'review' || !task.commit || !task.branch || !task.workspacePath)
            throw fail('Only a fix that is waiting for you can be accepted');
        const route = this.route(task.routeId);
        task.error = undefined;
        await this.move(task, 'accepting', say('Accepted'));
        this.drive(task, async (signal) => {
            const machine = await this.host.workplaces.machine(task.workspacePath, signal);
            if (route.accept === 'merge')
                task.mergeCommit = await this.merge(task, route, machine, signal);
            else {
                const [pushed] = await machine.git([{ argv: ['push', route.pushRemote, `${task.commit}:refs/heads/${task.branch}`], timeoutMs: GIT_NETWORK_TIMEOUT }], { signal });
                if (pushed.code !== 0)
                    throw fail('Git could not push {ref}', { ref: task.branch }, gitSaid(pushed));
            }
            // From here the fix is out; whatever its source says, the task is done.
            const event = { kind: 'accepted', baseBranch: task.baseBranch, branch: task.branch, commit: task.commit, ...(task.mergeCommit ? { mergeCommit: task.mergeCommit } : {}) };
            if (!await this.report(task, event))
                task.reportPending = event;
            // Bugs like this one go to the same place next time.
            const packages = task.check?.packages ?? [], where = packages.length === 1 ? packages[0] : task.packageHint;
            const prefix = prefixKey(task.item), project = projectKey(task.item);
            if (prefix)
                store.memory[prefix] = { routeId: task.routeId, branch: task.baseBranch, ...(where ? { package: where } : {}) };
            if (project)
                store.memory[project] = { routeId: task.routeId, branch: task.baseBranch };
            if (prefix || project)
                await store.saveMemory().catch(() => undefined);
            // Fixed: it is no longer waiting to be handed out, and what its source kept for it can go.
            if (store.pool[task.key]) {
                delete store.pool[task.key];
                await store.savePool().catch(() => undefined);
            }
            await this.host.source(task.item.source)?.discard?.(task.item).catch(() => undefined);
            await this.move(task, 'done', task.mergeCommit ? say('Merged into {base} as {commit} and pushed', { base: task.baseBranch, commit: short(task.mergeCommit) }) : say('Pushed {ref}', { ref: task.branch }));
        }, reason => { task.status = 'review'; task.error = reason; });
        return task;
    }
    /**
     * A merge commit made from the two trees and pushed, without touching the worktree: nothing to abort when it conflicts,
     * and files a build left behind cannot get in the way.
     */
    async merge(task, route, machine, signal) {
        const remote = route.pushRemote, base = task.baseBranch, tracking = `refs/remotes/${remote}/${base}`;
        const [fetched] = await machine.git([{ argv: ['fetch', '--no-tags', remote, `+refs/heads/${base}:${tracking}`], timeoutMs: GIT_NETWORK_TIMEOUT }], { signal });
        if (fetched.code !== 0)
            throw fail('Git could not fetch {ref}', { ref: `${remote}/${base}` }, gitSaid(fetched));
        const [tree] = await machine.git([{ argv: ['merge-tree', '--write-tree', '--name-only', tracking, task.commit] }], { reads: true, signal });
        if (tree.code === 1) {
            const files = tree.stdout.split('\n').slice(1).map(line => line.trim()).filter(line => line && !/^(?:Auto-merging|CONFLICT)/u.test(line));
            throw fail('The fix conflicts with {ref}. Send it back and ask for the conflict to be resolved against the latest {base}.', { ref: `${remote}/${base}`, base }, [...new Set(files)].slice(0, 8).join('\n'));
        }
        if (tree.code !== 0)
            throw /unknown option|usage:/iu.test(tree.stderr) ? fail('Accepting needs Git 2.38 or newer on the machine that holds the repository') : fail('Git could not merge', undefined, gitSaid(tree));
        const [merged] = await machine.git([{ argv: ['commit-tree', tree.stdout.split('\n')[0].trim(), '-p', tracking, '-p', task.commit, '-m', mergeMessage(task.item)] }], { signal });
        if (merged.code !== 0)
            throw fail('Git could not write the merge', undefined, gitSaid(merged));
        const commit = merged.stdout.trim();
        const [pushed] = await machine.git([{ argv: ['push', remote, `${commit}:refs/heads/${base}`], timeoutMs: GIT_NETWORK_TIMEOUT }], { signal });
        if (pushed.code !== 0)
            throw fail('Git could not push {ref}', { ref: `${remote}/${base}` }, gitSaid(pushed));
        return commit;
    }
    /** Tells the source again what it could not be told when the fix was accepted. */
    async retryReport(key) {
        const task = this.task(key), source = this.host.source(task.item.source);
        if (task.status !== 'done' || !task.reportPending)
            throw fail('Nothing is waiting to be written back');
        if (!source?.report)
            throw fail('The source of this bug is not loaded');
        await source.report(task.item, task.reportPending);
        task.reportPending = undefined;
        this.note(task, say('{source} updated', { source: source.name }));
        await this.save();
        return task;
    }
    /**
     * A finished fix's worktree, with its workspace and conversation in DSH, taken away once a person says so. The task
     * stays on the board. Its branch goes too when the fix was merged; a branch that was only pushed is kept.
     */
    async removeWorkspace(key) {
        const task = this.task(key);
        if (this.live.has(key))
            throw fail('This task is still running');
        if (task.status !== 'done')
            throw fail('Only the workspace of an accepted fix can be removed here');
        if (!task.worktree || !task.workspacePath)
            throw fail('This task has no workspace any more');
        const { worktree, workspacePath, branch } = task, route = this.host.store.settings.routes.find(entry => entry.id === task.routeId);
        task.error = undefined;
        this.note(task, say('Removing the workspace'));
        await this.save();
        // Whatever goes wrong, the fix is out and the task stays done: the reason is shown on it.
        this.drive(task, async (signal) => {
            try {
                const removed = await this.host.workplaces.remove({ project: route?.project ?? workspacePath, worktree, deleteBranch: !!task.mergeCommit }, signal);
                task.worktree = undefined;
                task.workspacePath = undefined;
                task.sessionId = undefined;
                this.note(task, say('Workspace removed'));
                for (const warning of removed.warnings)
                    this.note(task, say(warning));
                // The worktree service only knows the repository's default branch; a fix merged into another base is this plugin's to know.
                let gone = removed.branch === 'deleted';
                if (!gone && route && branch && task.mergeCommit)
                    gone = await this.dropBranch(task, route, branch, signal).catch(() => false);
                if (gone && branch)
                    this.note(task, say('Branch {branch} deleted', { branch }));
                else
                    for (const why of removed.kept)
                        this.note(task, say(why));
            }
            catch (error) {
                const reason = signal.aborted ? say('Removing the workspace was stopped') : messageOf(error);
                task.error = reason;
                this.note(task, reason);
            }
        });
        return task;
    }
    /** The fix's branch, once everything on it is in the base branch on the remote. True when it is gone. */
    async dropBranch(task, route, branch, signal) {
        const machine = await this.host.workplaces.machine(route.project, signal);
        const [merged] = await machine.git([{ argv: ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/remotes/${route.pushRemote}/${task.baseBranch}`] }], { reads: true, signal });
        if (merged.code !== 0)
            return false;
        const [deleted] = await machine.git([{ argv: ['branch', '-D', branch] }], { signal });
        return deleted.code === 0;
    }
    /** Forgets a task that is not running. Its worktree and conversation stay in DSH. */
    async forget(key) {
        if (this.live.has(key))
            throw fail('Stop the task first');
        delete this.host.store.tasks[key];
        await this.save();
    }
    /** Stops everything, as when the plugin unloads. */
    close() { for (const live of this.live.values())
        live.controller.abort(); }
}
