import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { RemoteError } from '../core/domain.js';
import { dshHome, under } from './access.js';
import { LocalMachine, RemoteMachine } from './worktree-machine.js';
/**
 * Workspaces that start from a project: a Git worktree on the project's machine, adopted as a DSH workspace of its own.
 * Worktrees live outside the repository, under `~/.dsh/worktrees` on this computer and `~/.dsh-remote-agents/worktrees`
 * on a saved SSH machine, one folder per repository; a path there is how this plugin knows a worktree is its own. A
 * repository's `.dsh/worktree.json` lists commands that set a new worktree up and tear it down before it is removed.
 */
/** The project setup file, relative to a checkout. */
export const WORKTREE_CONFIG = '.dsh/worktree.json';
const REMOTE_ROOT = ['.dsh-remote-agents', 'worktrees'];
const CONFIG_LIMIT = 64 * 1024;
const LOG_LIMIT = 256 * 1024;
const BRANCH_LIMIT = 1000;
const FETCH_TIMEOUT = 15_000;
const CHECKOUT_TIMEOUT = 170_000;
/** Usable as a folder name on every system: letters, digits, dot, dash and underscore. */
export function slugify(value) {
    const slug = value.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60).replace(/[-.]+$/, '');
    return slug || 'worktree';
}
const ADJECTIVES = ['amber', 'brave', 'bright', 'calm', 'clever', 'cosmic', 'crisp', 'eager', 'gentle', 'happy', 'jolly', 'keen', 'lively', 'lucky', 'mellow', 'nimble',
    'proud', 'quick', 'quiet', 'rapid', 'shiny', 'silent', 'smooth', 'sunny', 'swift', 'tidy', 'vivid', 'witty', 'bold', 'fresh', 'golden', 'misty'];
const NOUNS = ['otter', 'falcon', 'maple', 'comet', 'harbor', 'meadow', 'pebble', 'river', 'cedar', 'ember', 'fjord', 'glacier', 'heron', 'island', 'lantern', 'lotus',
    'nebula', 'orchid', 'panda', 'quartz', 'raven', 'sparrow', 'tiger', 'tulip', 'willow', 'badger', 'coral', 'dune', 'aurora', 'canyon', 'koala', 'summit'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
/** A branch name such as `swift-otter`, for a new branch nobody named. */
export const friendlyName = () => `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
/** `git for-each-ref` records: refname, commit time, upstream, upstream tracking, separated by NUL. */
export const BRANCH_FORMAT = '%(refname)%00%(committerdate:unix)%00%(upstream)%00%(upstream:track,nobracket)';
/** Local and remote-tracking branches, one entry per name, most recently committed first. */
export function parseBranches(output, remotes, checkouts = new Map()) {
    const byName = new Map(), order = [], tracked = new Set();
    // Remote names may contain slashes; the longest one that prefixes a ref owns it.
    const owners = [...remotes].sort((a, b) => b.length - a.length);
    const entry = (name) => {
        let branch = byName.get(name);
        if (!branch) {
            branch = { name, local: false, date: 0 };
            byName.set(name, branch);
            order.push(name);
        }
        return branch;
    };
    for (const line of output.split('\n')) {
        const [ref, date, upstream, track] = line.split('\0');
        if (!ref)
            continue;
        const time = Number(date) || 0;
        if (ref.startsWith('refs/heads/')) {
            const name = ref.slice(11), branch = entry(name);
            branch.local = true;
            branch.date = Math.max(branch.date, time);
            // A branch tracks its upstream unless that remote branch is gone.
            if (upstream?.startsWith('refs/remotes/') && track !== 'gone') {
                branch.remote = upstream.slice(13);
                tracked.add(name);
            }
            const ahead = /ahead (\d+)/.exec(track ?? ''), behind = /behind (\d+)/.exec(track ?? '');
            if (ahead)
                branch.ahead = Number(ahead[1]);
            if (behind)
                branch.behind = Number(behind[1]);
            const at = checkouts.get(name);
            if (at)
                branch.checkedOutAt = at;
        }
        else if (ref.startsWith('refs/remotes/')) {
            const rest = ref.slice(13), remote = owners.find(name => rest.startsWith(`${name}/`));
            if (!remote)
                continue;
            const name = rest.slice(remote.length + 1);
            if (!name || name === 'HEAD')
                continue;
            const branch = entry(name);
            branch.date = Math.max(branch.date, time);
            // The upstream wins; otherwise origin's branch, otherwise the first remote's.
            if (!tracked.has(name) && (!branch.remote || remote === 'origin'))
                branch.remote = rest;
        }
    }
    return order.map(name => byName.get(name)).sort((a, b) => b.date - a.date);
}
/** `git worktree list --porcelain` output. */
export function parseWorktrees(output) {
    const records = [];
    let current;
    for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
            current = { path: line.slice(9), branch: null };
            records.push(current);
        }
        else if (!current)
            continue;
        else if (line.startsWith('branch '))
            current.branch = line.slice(7).replace(/^refs\/heads\//, '');
        else if (line.startsWith('HEAD '))
            current.head = line.slice(5);
        else if (line === 'bare')
            current.bare = true;
    }
    return records;
}
/** The setup file's commands: `{ "setup": [...], "teardown": [...] }`. */
export function parseConfig(text) {
    if (text === undefined)
        return { setup: [], teardown: [] };
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new RemoteError(`${WORKTREE_CONFIG} is not valid JSON`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RemoteError(`${WORKTREE_CONFIG} must be a JSON object`);
    const list = (name) => {
        const items = value[name];
        if (items === undefined)
            return [];
        if (!Array.isArray(items) || items.length > 50 || items.some(item => typeof item !== 'string' || !item.trim() || item.length > 10_000)) {
            throw new RemoteError(`"${name}" in ${WORKTREE_CONFIG} must be a list of commands`);
        }
        return items;
    };
    return { setup: list('setup'), teardown: list('teardown') };
}
class JobFailure extends Error {
    payload;
    actions;
    constructor(payload, actions = []) {
        super(payload.key);
        this.payload = payload;
        this.actions = actions;
    }
}
const fail = (key, values, detail, actions = []) => new JobFailure({ key, ...(values ? { values } : {}), ...(detail?.trim() ? { detail: detail.trim().slice(-4000) } : {}) }, actions);
/** A running or finished create or archive operation; the client polls it. */
class Job {
    kind;
    id = randomUUID();
    state = 'running';
    steps;
    log = '';
    error;
    actions = [];
    result;
    updated = Date.now();
    controller = new AbortController();
    constructor(kind, steps) {
        this.kind = kind;
        this.steps = steps.map(id => ({ id, state: 'pending' }));
    }
    write(text) {
        this.log += text;
        if (this.log.length > LOG_LIMIT)
            this.log = this.log.slice(this.log.length - LOG_LIMIT);
        this.updated = Date.now();
    }
    step(id, state, detail) {
        const step = this.steps.find(s => s.id === id);
        if (step) {
            step.state = state;
            if (detail === undefined)
                delete step.detail;
            else
                step.detail = detail;
        }
        this.updated = Date.now();
    }
    view() {
        return { id: this.id, kind: this.kind, state: this.state, steps: this.steps.map(s => ({ ...s })), log: this.log, actions: [...this.actions],
            ...(this.error ? { error: this.error } : {}), ...(this.result ? { result: { ...this.result, warnings: [...this.result.warnings] } } : {}) };
    }
}
const sameCommands = (a, b) => !!b && a.length === b.length && a.every((command, index) => command === b[index]);
export class WorktreeService {
    host;
    jobs = new Map();
    created = new Map();
    busy = new Set();
    local;
    remotes = new Map();
    constructor(host) {
        this.host = host;
        this.local = host.local ?? new LocalMachine();
    }
    /** Stops running operations, as when the plugin unloads. */
    close() { for (const job of this.jobs.values())
        if (job.state === 'running')
            job.controller.abort(); }
    get home() { return this.host.home ?? dshHome(); }
    remote(hostId) {
        let machine = this.remotes.get(hostId);
        if (!machine) {
            machine = this.host.remote?.(hostId) ?? new RemoteMachine(this.host.machines, hostId);
            this.remotes.set(hostId, machine);
        }
        return machine;
    }
    anchored(path) { return under(join(this.home, 'remote-workspaces'), resolve(path)); }
    /** The machine and folder a DSH workspace stands for. */
    async place(path, signal) {
        let placement;
        try {
            placement = await this.host.access.resolve(path, signal);
        }
        catch (error) {
            signal?.throwIfAborted();
            throw new RemoteError(error instanceof Error ? error.message : 'Cannot read a valid remote workspace binding', 409);
        }
        if (placement.cwd) {
            const hostId = placement.hostIds[0], host = this.host.machines.hosts().find(h => h.id === hostId);
            if (!hostId || !host)
                throw new RemoteError('This workspace\'s machine is not saved in Remote agents', 409);
            return { machine: this.remote(hostId), location: { kind: 'remote', hostId, host: host.label }, cwd: placement.cwd };
        }
        if (this.anchored(path))
            throw new RemoteError('This workspace\'s machine is not saved in Remote agents', 409);
        return { machine: this.local, location: { kind: 'local' }, cwd: path };
    }
    /** The folder holding a machine's worktrees. */
    async machineRoot(machine, signal) {
        if (machine.kind !== 'local')
            return machine.path.join(await machine.home(signal), ...REMOTE_ROOT);
        // Git reports worktree paths with links resolved, as /private/tmp for /tmp on macOS; so are this folder's.
        const root = join(this.home, 'worktrees');
        await mkdir(root, { recursive: true });
        return realpath(root);
    }
    /** Whether a folder is a worktree this plugin made: two levels under the machine's worktree folder. */
    async managedRoot(machine, folder, signal) {
        const root = await this.machineRoot(machine, signal), relative = machine.path.relative(root, folder);
        if (!relative || relative.startsWith('..') || machine.path.isAbsolute(relative))
            return undefined;
        const parts = relative.split(machine.path.sep);
        return parts.length >= 2 && parts[0] && parts[1] ? machine.path.join(root, parts[0], parts[1]) : undefined;
    }
    async repository(place, signal) {
        const { machine, cwd } = place;
        const [top, common, prefix, head, remotes, refs, worktrees, origin] = await machine.git(cwd, [
            { argv: ['rev-parse', '--show-toplevel'] }, { argv: ['rev-parse', '--git-common-dir'] }, { argv: ['rev-parse', '--show-prefix'] }, { argv: ['symbolic-ref', '-q', '--short', 'HEAD'] },
            { argv: ['remote'] }, { argv: ['for-each-ref', `--count=${BRANCH_LIMIT}`, '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'] },
            { argv: ['worktree', 'list', '--porcelain'] }, { argv: ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'] },
        ], { reads: true, signal });
        if (top.code !== 0 || !top.stdout.trim())
            throw new RemoteError('This folder is not in a Git repository', 400);
        const toplevel = top.stdout.replace(/\n$/, ''), path = machine.path;
        // One repository has one folder of worktrees, whichever of its checkouts, and links on the way to it, a project names.
        const named = path.resolve(cwd, common.stdout.replace(/\n$/, ''));
        const commonDir = machine.kind === 'local' ? await realpath(named).catch(() => named) : named;
        // A repository's own `.git` folder sits in its main checkout; a bare repository is its common folder.
        const main = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
        const name = path.basename(main).replace(/\.git$/, '') || 'repository';
        const records = parseWorktrees(worktrees.stdout).filter(record => !record.bare);
        const checkouts = new Map(records.filter(r => r.branch).map(r => [r.branch, r.path]));
        const remoteNames = remotes.stdout.split('\n').map(line => line.trim()).filter(Boolean);
        const branches = parseBranches(refs.stdout, remoteNames, checkouts);
        const originHead = origin.code === 0 ? origin.stdout.trim().replace(/^refs\/remotes\/origin\//, '') : '';
        const has = (name) => branches.some(b => b.name === name);
        const defaultBase = [originHead, 'main', 'master', head.stdout.trim()].find(name => name && has(name)) ?? branches[0]?.name ?? null;
        // Git names the workspace folder inside its checkout with forward slashes, whatever the links on the way.
        const subdir = prefix.code === 0 ? prefix.stdout.trim().replace(/\/+$/, '') : '';
        const hash = createHash('sha256').update(commonDir).digest('hex').slice(0, 8);
        const root = path.join(await this.machineRoot(machine, signal), `${slugify(name)}-${hash}`);
        return { toplevel, common: commonDir, main, name, subdir, head: head.code === 0 ? head.stdout.trim() || null : null,
            remotes: remoteNames, branches, worktrees: records, defaultBase, root };
    }
    /** DSH's workspaces, as its registry lists them now. */
    async workspaces(signal) {
        const dsh = this.host.dsh();
        if (!dsh)
            return [];
        const controller = new AbortController(), stop = () => controller.abort();
        signal?.addEventListener('abort', stop, { once: true });
        try {
            for await (const frame of dsh.follow(controller.signal))
                if (frame.type === 'baseline' || frame.type === 'replace')
                    return frame.value?.items ?? [];
            return [];
        }
        finally {
            controller.abort();
            signal?.removeEventListener('abort', stop);
        }
    }
    /** The DSH workspaces inside a worktree on a machine. */
    async workspacesIn(place, folder, views, signal) {
        const { machine, location } = place, inside = (path) => { const r = machine.path.relative(folder, path); return r === '' || !r.startsWith('..') && !machine.path.isAbsolute(r); };
        if (location.kind === 'local')
            return views.filter(view => !this.anchored(view.path) && inside(view.path));
        const found = [];
        for (const view of views) {
            if (!this.anchored(view.path))
                continue;
            const placement = await this.host.access.resolve(view.path, signal).catch(() => undefined);
            if (placement?.cwd && placement.hostIds.includes(location.hostId) && inside(placement.cwd))
                found.push(view);
        }
        return found;
    }
    async config(machine, folders, signal) {
        for (const folder of folders) {
            const text = await machine.read(machine.path.join(folder, WORKTREE_CONFIG), CONFIG_LIMIT, signal);
            if (text !== undefined)
                return parseConfig(text);
        }
        return parseConfig(undefined);
    }
    /** DSH workspaces that are Git projects on this computer, and those on saved machines, which are checked when chosen. */
    async projects(signal) {
        const views = await this.workspaces(signal), hosts = this.host.machines.hosts();
        const localRoot = await this.machineRoot(this.local, signal), seen = new Map();
        const results = await pool(views, 8, async (view) => {
            if (this.anchored(view.path)) {
                const placement = await this.host.access.resolve(view.path, signal).catch(() => undefined);
                const host = hosts.find(h => placement?.hostIds.includes(h.id));
                if (!placement?.cwd || !host)
                    return undefined;
                return { path: view.path, title: view.title, location: { kind: 'remote', hostId: host.id, host: host.label }, folder: placement.cwd,
                    own: placement.cwd.includes(`/${REMOTE_ROOT.join('/')}/`), key: `${host.id}\0${placement.cwd}` };
            }
            const [common] = await this.local.git(view.path, [{ argv: ['rev-parse', '--git-common-dir'], timeoutMs: 5000 }], { reads: true, signal }).catch(() => [undefined]);
            if (!common || common.code !== 0)
                return undefined;
            const commonDir = await realpath(resolve(view.path, common.stdout.replace(/\n$/, ''))).catch(() => resolve(view.path, common.stdout.replace(/\n$/, '')));
            const own = await realpath(view.path).then(path => under(localRoot, path), () => false);
            return { path: view.path, title: view.title, location: { kind: 'local' }, folder: view.path, home: await this.local.home(),
                own, key: `local\0${commonDir}` };
        });
        for (const item of results) {
            if (!item)
                continue;
            const { key, ...project } = item, existing = seen.get(key);
            // One entry per repository, preferring a workspace that is not one of its worktrees.
            if (!existing || (existing.own && !project.own))
                seen.set(key, project);
        }
        return [...seen.values()].filter(project => !(project.location.kind === 'remote' && project.own)).map(({ own: _own, ...project }) => project);
    }
    async inspect(path, signal) {
        const place = await this.place(path, signal), repo = await this.repository(place, signal);
        const [config, views] = await Promise.all([this.config(place.machine, [repo.toplevel, repo.main], signal).catch(() => ({ setup: [], teardown: [] })), this.workspaces(signal)]);
        const worktrees = [];
        for (const record of repo.worktrees) {
            if (!await this.managedRoot(place.machine, record.path, signal))
                continue;
            const [view] = await this.workspacesIn(place, record.path, views, signal);
            worktrees.push({ path: record.path, branch: record.branch, ...(view ? { workspace: { workspaceId: view.workspaceId, title: view.title, path: view.path } } : {}) });
        }
        return { path, location: place.location, home: await place.machine.home(signal), name: repo.name, repository: repo.main, subdir: repo.subdir, head: repo.head, defaultBase: repo.defaultBase,
            branches: repo.branches, root: repo.root, setup: config.setup, worktrees };
    }
    job(id) {
        const job = this.jobs.get(id);
        if (!job)
            throw new RemoteError('This operation is no longer available', 404);
        return job.view();
    }
    start(kind, steps, run) {
        // Finished operations nobody looked at for a while are forgotten.
        for (const [id, old] of this.jobs)
            if (old.state !== 'running' && Date.now() - old.updated > 30 * 60_000) {
                this.jobs.delete(id);
                this.created.delete(id);
            }
        const job = new Job(kind, steps);
        this.jobs.set(job.id, job);
        void this.drive(job, run);
        return job.view();
    }
    async drive(job, run) {
        job.state = 'running';
        job.actions = [];
        delete job.error;
        try {
            await run(job);
            job.state = 'done';
            job.actions = [];
        }
        catch (error) {
            for (const step of job.steps)
                if (step.state === 'running')
                    step.state = 'failed';
            job.state = 'failed';
            if (error instanceof JobFailure) {
                job.error = error.payload;
                job.actions = error.actions;
            }
            else if (job.controller.signal.aborted) {
                job.error = { key: 'Stopped' };
                job.actions = job.kind === 'archive' ? ['retry'] : this.created.has(job.id) ? ['retry', 'discard'] : [];
            }
            else {
                job.error = { key: error instanceof Error ? error.message : String(error) };
                job.actions = job.kind === 'create' && this.created.has(job.id) ? ['retry', 'discard'] : [];
            }
            if (job.error.detail)
                job.write(`${job.error.detail}\n`);
        }
        finally {
            job.updated = Date.now();
        }
    }
    async act(id, action) {
        const job = this.jobs.get(id);
        if (!job)
            throw new RemoteError('This operation is no longer available', 404);
        if (action === 'cancel') {
            if (job.state === 'running')
                job.controller.abort();
            return job.view();
        }
        if (job.state !== 'failed' || !job.actions.includes(action))
            throw new RemoteError('This action is not available now', 409);
        job.controller = new AbortController();
        const created = this.created.get(id);
        if (job.kind === 'create' && created) {
            if (action === 'discard')
                void this.drive(job, async () => { await this.discard(job, created); job.state = 'discarded'; }).then(() => { if (job.state === 'done')
                    job.state = 'discarded'; });
            else {
                if (action === 'skip') {
                    for (const step of job.steps)
                        if (step.state === 'failed' || step.state === 'pending')
                            step.state = 'skipped';
                    created.next = created.setup.length;
                }
                if (action === 'confirm')
                    created.reviewed = true;
                void this.drive(job, () => this.finish(job, created));
            }
            return job.view();
        }
        const resume = job.resume;
        if (!resume)
            throw new RemoteError('This action is not available now', 409);
        void this.drive(job, () => resume(action === 'skip'));
        return job.view();
    }
    /** Create a worktree from a project and adopt it as a DSH workspace; setup commands run last. */
    create(request) {
        return this.start('create', ['prepare', 'checkout', 'register', 'setup'], async (job) => {
            const signal = job.controller.signal;
            job.step('prepare', 'running');
            const place = await this.place(request.path, signal), repo = await this.repository(place, signal), { machine } = place;
            const find = (name) => repo.branches.find(branch => branch.name === name);
            let branch, base, args, fetch, ownBranch;
            if (request.mode === 'existing') {
                const entry = find(request.branch);
                if (!entry || !request.branch)
                    throw fail('Choose a branch to check out');
                if (entry.checkedOutAt)
                    throw fail('Branch {branch} is already checked out at {path}', { branch: entry.name, path: entry.checkedOutAt });
                branch = entry.name;
                if (entry.local) {
                    args = [branch];
                    ownBranch = false;
                }
                else {
                    const remote = entry.remote, owner = repo.remotes.find(name => remote.startsWith(`${name}/`));
                    fetch = { remote: owner, branch: remote.slice(owner.length + 1) };
                    args = ['--track', '-b', branch, `refs/remotes/${remote}`];
                    ownBranch = true;
                }
            }
            else {
                const entry = find(request.base ?? repo.defaultBase ?? undefined);
                if (!entry)
                    throw fail('Choose a branch to start from');
                // A local branch with commits of its own is the start; otherwise the remote branch, which is refreshed first.
                if (entry.local && (!entry.remote || (entry.ahead ?? 0) > 0))
                    base = `refs/heads/${entry.name}`;
                else {
                    const remote = entry.remote, owner = repo.remotes.find(name => remote.startsWith(`${name}/`));
                    if (owner)
                        fetch = { remote: owner, branch: remote.slice(owner.length + 1) };
                    base = `refs/remotes/${remote}`;
                }
                const wanted = request.branch?.trim();
                if (wanted) {
                    const [check] = await machine.git(place.cwd, [{ argv: ['check-ref-format', '--branch', wanted] }], { reads: true, signal });
                    if (check.code !== 0)
                        throw fail('{branch} is not a valid branch name', { branch: wanted });
                    if (find(wanted)?.local)
                        throw fail('Branch {branch} already exists. Check it out instead.', { branch: wanted });
                    branch = wanted;
                }
                else {
                    branch = friendlyName();
                    for (let i = 2; find(branch); i++)
                        branch = `${friendlyName()}${i > 6 ? `-${i}` : ''}`;
                }
                args = ['--no-track', '-b', branch, base];
                ownBranch = true;
            }
            let worktree = machine.path.join(repo.root, slugify(branch));
            for (let i = 2; await machine.exists(worktree, signal); i++)
                worktree = machine.path.join(repo.root, `${slugify(branch)}-${i}`);
            job.step('prepare', 'done', branch);
            job.result = { branch, worktree, warnings: [] };
            job.step('checkout', 'running');
            if (fetch) {
                job.write(`$ git fetch --no-tags ${fetch.remote} ${fetch.branch}\n`);
                const [fetched] = await machine.git(place.cwd, [{ argv: ['fetch', '--no-tags', fetch.remote, `+refs/heads/${fetch.branch}:refs/remotes/${fetch.remote}/${fetch.branch}`], timeoutMs: FETCH_TIMEOUT }], { signal });
                if (fetched.code !== 0) {
                    job.write(fetched.stderr);
                    job.result.warnings.push({ key: 'Could not update {branch}; started from the copy already on the machine', values: { branch: `${fetch.remote}/${fetch.branch}` }, detail: fetched.stderr.trim().slice(-2000) });
                }
            }
            job.write(`$ git worktree add ${[worktree, ...args].join(' ')}\n`);
            const [added] = await machine.git(place.cwd, [{ argv: ['worktree', 'add', worktree, ...args], timeoutMs: CHECKOUT_TIMEOUT }], { signal });
            job.write(added.stdout + added.stderr);
            if (added.code !== 0)
                throw fail('Git could not create the worktree', undefined, added.stderr || added.stdout);
            job.step('checkout', 'done');
            const config = await this.config(machine, [worktree, repo.main], signal).catch(error => {
                job.result.warnings.push({ key: 'Setup was skipped: {reason}', values: { reason: error instanceof Error ? error.message : String(error) } });
                return { setup: [], teardown: [] };
            });
            const created = { place, repo, worktree, branch, ownBranch, source: request.path, setup: config.setup, next: 0, workspaces: [], reviewed: sameCommands(config.setup, request.setup) };
            this.created.set(job.id, created);
            await this.finish(job, created);
        });
    }
    /** Adopt the worktree as a DSH workspace, then run the setup commands not run yet. */
    async finish(job, created) {
        const signal = job.controller.signal, { machine, location } = created.place;
        if (!job.result?.path) {
            job.step('register', 'running');
            let folder = created.repo.subdir ? machine.path.join(created.worktree, ...created.repo.subdir.split('/')) : created.worktree;
            if (folder !== created.worktree && !await machine.exists(folder, signal)) {
                job.result.warnings.push({ key: '{folder} is not on this branch; the workspace opens the whole worktree', values: { folder: created.repo.subdir } });
                folder = created.worktree;
            }
            const path = location.kind === 'local' ? folder : (await this.host.anchors.create(location.hostId, folder, signal)).path;
            const name = created.repo.subdir ? created.repo.subdir.split('/').pop() : created.repo.name;
            const title = await this.register(path, `${name} · ${created.branch}`, created.source, signal).catch(error => {
                throw fail('The worktree was created but could not be added to DSH: {reason}', { reason: error instanceof Error ? error.message : String(error) }, undefined, ['retry', 'discard']);
            });
            created.workspaces.push(path);
            job.result = { ...job.result, path, ...(title ? { title } : {}) };
            job.step('register', 'done');
        }
        if (created.next >= created.setup.length) {
            if (job.steps.find(s => s.id === 'setup')?.state !== 'skipped')
                job.step('setup', created.setup.length ? 'done' : 'skipped');
            return;
        }
        if (!created.reviewed) {
            // In the log, which holds a whole setup file, for reading before choosing. Checking out a branch must not run what it brings.
            job.write(`${created.setup.map(command => `$ ${command}`).join('\n')}\n`);
            throw fail('This branch has setup commands that were not shown before. Read them above, then choose.', undefined, undefined, ['confirm', 'skip', 'discard']);
        }
        const env = { DSH_SOURCE_CHECKOUT_PATH: created.repo.main, DSH_WORKTREE_PATH: created.worktree, DSH_BRANCH_NAME: created.branch };
        while (created.next < created.setup.length) {
            const command = created.setup[created.next];
            job.step('setup', 'running', `${created.next + 1}/${created.setup.length}`);
            job.write(`$ ${command}\n`);
            const code = await machine.shell(created.worktree, command, env, text => job.write(text), signal);
            if (signal.aborted || code === null)
                throw fail('Setup was stopped', undefined, undefined, ['retry', 'skip', 'discard']);
            if (code !== 0)
                throw fail('Setup command failed with exit code {code}', { code: String(code) }, undefined, ['retry', 'skip', 'discard']);
            created.next++;
        }
        job.step('setup', 'done', `${created.setup.length}/${created.setup.length}`);
    }
    /** Add a folder to DSH under `title`, next to the workspace it started from and with that workspace's tags. */
    async register(path, title, source, signal) {
        const dsh = this.host.dsh();
        if (!dsh)
            throw new RemoteError('DSH workspaces are unavailable', 501);
        const { workspace } = await dsh.create({ path });
        let named;
        for (let i = 1; i <= 5 && !named; i++) {
            const candidate = i === 1 ? title : `${title} (${i})`;
            if (workspace.title === candidate) {
                named = candidate;
                break;
            }
            try {
                await dsh.rename({ workspaceId: workspace.workspaceId, title: candidate });
                named = candidate;
            }
            catch { /* a title in use; try the next */ }
        }
        const views = await this.workspaces(signal).catch(() => []);
        const at = views.findIndex(view => view.path === source), from = views[at];
        if (from) {
            const next = views.slice(at + 1).find(view => view.workspaceId !== workspace.workspaceId);
            await dsh.insertBefore({ workspaceId: workspace.workspaceId, ...(next ? { beforeWorkspaceId: next.workspaceId } : {}) }).catch(() => { });
            const tags = this.host.tags?.();
            const state = tags?.snapshot(), inherited = state?.assignments[from.workspaceId];
            if (tags && state && inherited?.length && !state.assignments[workspace.workspaceId]?.length) {
                await tags.replace({ ...state, assignments: { ...state.assignments, [workspace.workspaceId]: [...inherited] } }).catch(() => { });
            }
        }
        return named;
    }
    /** Removes what a create job made: its DSH workspace, the worktree and a branch it created. */
    async discard(job, created) {
        const signal = job.controller.signal;
        await this.removeWorktree(job, created.place, created.repo, created.worktree, signal);
        if (created.ownBranch) {
            job.write(`$ git branch -D ${created.branch}\n`);
            const [deleted] = await created.place.machine.git(created.repo.main, [{ argv: ['branch', '-D', created.branch] }], { signal });
            job.write(deleted.stdout + deleted.stderr);
        }
        const views = await this.workspaces(signal);
        await this.unregister(views.filter(view => created.workspaces.includes(view.path)), signal);
        this.created.delete(job.id);
    }
    async removeWorktree(job, place, repo, worktree, signal) {
        const { machine } = place;
        job.write(`$ git worktree remove --force ${worktree}\n`);
        const [removed] = await machine.git(repo.main, [{ argv: ['worktree', 'remove', '--force', '--force', worktree], timeoutMs: 120_000 }], { signal });
        job.write(removed.stdout + removed.stderr);
        // Git forgets a worktree whose folder was deleted, or keeps files it does not track; the folder goes either way.
        if (await machine.exists(worktree, signal))
            await machine.removeTree(worktree, signal);
        await machine.git(repo.main, [{ argv: ['worktree', 'prune'] }], { signal }).catch(() => { });
    }
    async unregister(views, signal) {
        const dsh = this.host.dsh();
        for (const view of views) {
            signal?.throwIfAborted();
            await dsh?.delete({ workspaceId: view.workspaceId });
            // A remote worktree's anchor folder goes with it; a later worktree of the same name gets a fresh one.
            if (this.anchored(view.path)) {
                const anchors = resolve(this.home, 'remote-workspaces'), parts = relative(anchors, resolve(view.path)).split(sep);
                if (parts.length >= 2 && parts[0] && parts[1])
                    await rm(join(anchors, parts[0], parts[1]), { recursive: true, force: true });
            }
        }
    }
    /** What archiving a worktree would lose, for the confirmation. */
    async archiveCheck(path, worktree, signal) {
        const place = await this.place(path, signal), repo = await this.repository(place, signal), { machine } = place;
        const record = await this.owned(place, repo, worktree, signal);
        const [status, unpushed, upstream] = await machine.git(worktree, [
            { argv: ['status', '--porcelain'] },
            { argv: ['rev-list', '--count', 'HEAD', '--not', '--remotes'] },
            { argv: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'] },
        ], { reads: true, signal }).catch(() => [{ code: 1, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: '' }]);
        const mergedInto = record?.branch ? await this.mergedInto(place, repo, record.branch, signal) : null;
        const config = await this.config(machine, [worktree, repo.main], signal).catch(() => ({ setup: [], teardown: [] }));
        const views = await this.workspacesIn(place, worktree, await this.workspaces(signal), signal);
        return {
            branch: record?.branch ?? null,
            dirty: status.code === 0 ? status.stdout.split('\n').filter(Boolean).length : 0,
            unpushed: repo.remotes.length && unpushed.code === 0 ? Number(unpushed.stdout.trim()) || 0 : upstream.code === 0 ? 0 : null,
            mergedInto, teardown: config.teardown,
            workspaces: views.map(view => ({ workspaceId: view.workspaceId, title: view.title, sessions: view.sessionIds.length })),
        };
    }
    /** A worktree of this project that this plugin made, still known to Git or left behind as a folder. */
    async owned(place, repo, worktree, signal) {
        const root = await this.managedRoot(place.machine, worktree, signal);
        if (!root || root !== worktree || place.machine.path.dirname(root) !== repo.root)
            throw new RemoteError('Only worktrees created here can be archived', 403);
        return repo.worktrees.find(record => record.path === worktree);
    }
    async mergedInto(place, repo, branch, signal) {
        const base = repo.defaultBase && repo.branches.find(b => b.name === repo.defaultBase);
        if (!base || base.name === branch)
            return null;
        const target = base.remote ? `refs/remotes/${base.remote}` : `refs/heads/${base.name}`;
        const [merged] = await place.machine.git(repo.main, [{ argv: ['merge-base', '--is-ancestor', `refs/heads/${branch}`, target] }], { reads: true, signal });
        return merged.code === 0 ? base.remote ?? base.name : null;
    }
    /** Stop the worktree's sessions, run its teardown, remove it, optionally delete its merged branch, and remove its workspaces from DSH. */
    archive(request) {
        let teardownDone = false;
        return this.start('archive', ['sessions', 'teardown', 'remove', ...(request.deleteBranch ? ['branch'] : []), 'unregister'], async (job) => {
            const run = async (skipTeardown) => {
                const signal = job.controller.signal;
                const place = await this.place(request.path, signal), repo = await this.repository(place, signal), { machine, location } = place;
                const record = await this.owned(place, repo, request.worktree, signal);
                const views = await this.workspacesIn(place, request.worktree, await this.workspaces(signal), signal);
                job.result = { branch: record?.branch ?? null, worktree: request.worktree, warnings: [] };
                if (job.steps.find(s => s.id === 'sessions')?.state !== 'done') {
                    job.step('sessions', 'running');
                    const dsh = this.host.dsh();
                    for (const view of views)
                        for (const sessionId of view.sessionIds) {
                            await dsh?.archiveSession({ sessionId, stopActivity: true }).catch(error => job.write(`${error instanceof Error ? error.message : String(error)}\n`));
                        }
                    if (location.kind === 'remote')
                        await this.host.stopRemoteSessions?.(location.hostId, request.worktree).catch(error => job.write(`${error instanceof Error ? error.message : String(error)}\n`));
                    job.step('sessions', 'done');
                }
                if (!teardownDone) {
                    if (skipTeardown) {
                        job.step('teardown', 'skipped');
                        teardownDone = true;
                    }
                    else {
                        const config = await machine.exists(request.worktree, signal) ? await this.config(machine, [request.worktree, repo.main], signal).catch(() => ({ setup: [], teardown: [] })) : { setup: [], teardown: [] };
                        const env = { DSH_SOURCE_CHECKOUT_PATH: repo.main, DSH_WORKTREE_PATH: request.worktree, DSH_BRANCH_NAME: record?.branch ?? '' };
                        for (const [index, command] of config.teardown.entries()) {
                            job.step('teardown', 'running', `${index + 1}/${config.teardown.length}`);
                            job.write(`$ ${command}\n`);
                            const code = await machine.shell(request.worktree, command, env, text => job.write(text), signal);
                            if (signal.aborted || code === null)
                                throw fail('Teardown was stopped', undefined, undefined, ['retry', 'skip']);
                            if (code !== 0)
                                throw fail('Teardown command failed with exit code {code}', { code: String(code) }, undefined, ['retry', 'skip']);
                        }
                        job.step('teardown', config.teardown.length ? 'done' : 'skipped');
                        teardownDone = true;
                    }
                }
                job.step('remove', 'running');
                await this.removeWorktree(job, place, repo, request.worktree, signal).catch(error => {
                    throw fail('Could not remove the worktree: {reason}', { reason: error instanceof Error ? error.message : String(error) }, undefined, ['retry']);
                });
                job.step('remove', 'done');
                if (request.deleteBranch && record?.branch) {
                    job.step('branch', 'running');
                    if (await this.mergedInto(place, repo, record.branch, signal)) {
                        job.write(`$ git branch -D ${record.branch}\n`);
                        const [deleted] = await machine.git(repo.main, [{ argv: ['branch', '-D', record.branch] }], { signal });
                        job.write(deleted.stdout + deleted.stderr);
                        job.step('branch', deleted.code === 0 ? 'done' : 'failed');
                        if (deleted.code !== 0)
                            job.result.warnings.push({ key: 'Branch {branch} was kept: Git could not delete it', values: { branch: record.branch }, detail: deleted.stderr });
                    }
                    else {
                        job.step('branch', 'skipped');
                        job.result.warnings.push({ key: 'Branch {branch} was kept because it is not merged', values: { branch: record.branch } });
                    }
                }
                else if (request.deleteBranch)
                    job.step('branch', 'skipped');
                job.step('unregister', 'running');
                await this.unregister(views, signal);
                job.step('unregister', 'done');
            };
            const locked = async (skip) => {
                if (this.busy.has(request.worktree))
                    throw fail('This worktree is already being archived');
                this.busy.add(request.worktree);
                try {
                    await run(skip);
                }
                finally {
                    this.busy.delete(request.worktree);
                }
            };
            job.resume = locked;
            await locked(false);
        });
    }
}
/** Runs `task` over `items` with at most `limit` running at once, keeping their order. */
async function pool(items, limit, task) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index]);
        }
    }));
    return results;
}
