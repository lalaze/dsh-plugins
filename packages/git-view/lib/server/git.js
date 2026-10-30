import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { REMOTE_ANCHOR, TEXT_LIMIT } from './domain.js';
import { LocalFiles, RemoteFiles, workspacePath } from './files.js';
import { authFailure, BRANCH_FORMAT, LOG_FORMAT, parseBranches, parseLog, parseStatus, repoName } from './parse.js';
import { GitError, RemoteRunner } from './runner.js';
/** Reads and quick changes, changes that may run hooks, and operations that reach a Git server. */
const READ_MS = 20_000, HOOK_MS = 60_000, NETWORK_MS = 90_000;
/** Standard output kept per command: room for 300 commits, many branches or a 4 MB file. */
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const command = (argv, timeoutMs = READ_MS) => ({ argv, timeoutMs });
/** A path from the repository root, exactly as written: no glob characters or other pathspec magic apply. */
const top = (path) => `:(top,literal)${path}`;
/** Text the user named: a branch, ref or message; never empty, never read as an option, without control characters. */
export function argument(value, label, max = 1024) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.startsWith('-') || /[\0-\x1f\x7f]/.test(value))
        throw new GitError(`Invalid ${label}`);
    return value;
}
const message = (value, label) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 32_000 || value.includes('\0'))
        throw new GitError(`Invalid ${label}`);
    return value.trim();
};
const sha = (value) => {
    if (typeof value !== 'string' || !/^[0-9a-f]{4,64}$/i.test(value))
        throw new GitError('Invalid commit');
    return value;
};
/** What Git printed when a command failed, or why it stopped. */
function failure(run, fallback) {
    if (run.timedOut)
        return new GitError('The Git operation timed out. The network or the Git server may be slow; try again later.', 504, { code: 'timeout' });
    if (run.truncated)
        return new GitError('Git returned more output than this view shows', 413);
    if (run.exitCode === null && !run.skipped)
        return new GitError('The Git operation was cancelled', 409, { code: 'cancelled' });
    const text = run.stderr.trim() || run.stdout.trim() || fallback, auth = authFailure(text);
    if (/not a git repository/i.test(text))
        return new GitError('This folder is not a Git repository', 404, { code: 'not-a-repo' });
    return new GitError(text, 422, auth ? { auth } : {});
}
const succeeded = (run, fallback) => { if (run.exitCode !== 0)
    throw failure(run, fallback); return run; };
/** Git for DSH conversations: on this machine, or in a verified Remote Agents remote workspace. */
export class GitView {
    options;
    running = new Map();
    constructor(options) {
        this.options = options;
    }
    /** A remote workspace folder runs Git on its machine; one that cannot be verified never falls back to this machine. */
    async workspace(sessionId, signal, expectedCwd) {
        signal.throwIfAborted();
        const cwd = await this.options.cwdOf(sessionId);
        signal.throwIfAborted();
        if (expectedCwd !== undefined && (typeof expectedCwd !== 'string' || expectedCwd !== cwd))
            throw new GitError('The workspace changed. Reopen the file before continuing.', 409);
        if (!cwd)
            throw new GitError('This conversation has no workspace folder', 409);
        if (this.options.isRemoteCwd?.(cwd) ?? REMOTE_ANCHOR.test(cwd)) {
            const service = this.options.remote();
            if (!service)
                throw new GitError('Install Remote Agents to use Git in this remote workspace', 409);
            const target = await service.target(sessionId, signal).catch((error) => {
                throw new GitError(error instanceof Error ? error.message : String(error), error?.status ?? 502);
            });
            // Verification can yield while a conversation is retargeted. Pin both the anchor and the verified SSH target.
            if (cwd !== await this.options.cwdOf(sessionId))
                throw new GitError('The workspace changed. Reopen the file before continuing.', 409);
            return { location: { kind: 'remote', host: target.label, cwd: target.cwd }, runner: new RemoteRunner(service, sessionId, target), files: new RemoteFiles(service, sessionId, target), local: false };
        }
        const root = await realpath(cwd).catch(() => { throw new GitError('The workspace folder is not available', 404); });
        if (!(await stat(root)).isDirectory())
            throw new GitError('The workspace folder is not available', 404);
        return { location: { kind: 'local' }, runner: this.options.local(root), files: new LocalFiles(root), local: true };
    }
    async run(workspace, commands, signal, options = {}) {
        if (options.id !== undefined && (typeof options.id !== 'string' || !UUID.test(options.id)))
            throw new GitError('Invalid request ID');
        const id = options.id ?? randomUUID();
        if (this.running.has(id))
            throw new GitError('This request is already running', 409);
        this.running.set(id, workspace.runner);
        try {
            return await workspace.runner.run({ id, commands, maxBytes: OUTPUT_LIMIT, stopOnError: options.stopOnError, optionalLocks: !options.read }, signal);
        }
        finally {
            this.running.delete(id);
        }
    }
    /** Register before workspace discovery so early cancellation cannot be lost; retain it between Git batches. */
    async operation(sessionId, id, signal, action, expectedCwd) {
        if (id !== undefined && (typeof id !== 'string' || !UUID.test(id)))
            throw new GitError('Invalid request ID');
        const job = id ?? randomUUID(), cancel = new AbortController();
        if (this.running.has(job))
            throw new GitError('This request is already running', 409);
        const current = AbortSignal.any([signal, cancel.signal]);
        let workspace;
        this.running.set(job, { cancel: async () => { cancel.abort(); await workspace?.runner.cancel(job); } });
        const run = async (commands, read = false, stopOnError = false) => {
            current.throwIfAborted();
            const result = await workspace.runner.run({ id: job, commands, maxBytes: OUTPUT_LIMIT, stopOnError, optionalLocks: !read }, current);
            current.throwIfAborted();
            return result;
        };
        try {
            current.throwIfAborted();
            workspace = await this.workspace(sessionId, current, expectedCwd);
            current.throwIfAborted();
            return await action(workspace, run, current);
        }
        catch (error) {
            if (cancel.signal.aborted)
                throw new GitError('The Git operation was cancelled', 409, { code: 'cancelled' });
            throw error;
        }
        finally {
            this.running.delete(job);
        }
    }
    /** Stops a running request of this DSH, wherever its Git runs. */
    async cancel(id) {
        if (typeof id !== 'string' || !UUID.test(id))
            throw new GitError('Invalid request ID');
        await this.running.get(id)?.cancel(id);
    }
    /** The current branch, for the composer's branch button. */
    async summary(sessionId, signal) {
        const workspace = await this.workspace(sessionId, signal);
        const [root, head] = await this.run(workspace, [command(['rev-parse', '--show-toplevel']), command(['symbolic-ref', '--quiet', '--short', 'HEAD'])], signal, { read: true });
        succeeded(root, 'git rev-parse failed');
        return { location: workspace.location, repo: repoName(root.stdout), current: head.exitCode === 0 ? head.stdout.trim() : '' };
    }
    /** Local and remote branches, for the composer's branch list. */
    async branches(sessionId, signal) {
        const workspace = await this.workspace(sessionId, signal);
        const [root, head, refs] = await this.run(workspace, [command(['rev-parse', '--show-toplevel']), command(['symbolic-ref', '--quiet', '--short', 'HEAD']),
            command(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'])], signal, { read: true });
        const current = head.exitCode === 0 ? head.stdout.trim() : '', { local, remote } = parseBranches(succeeded(refs, 'git for-each-ref failed').stdout, current);
        return { location: workspace.location, repo: repoName(succeeded(root, 'git rev-parse failed').stdout), current, local, remote };
    }
    /** Everything the Git view shows, in one round trip. */
    async overview(sessionId, signal) {
        const workspace = await this.workspace(sessionId, signal);
        const [where, head, refs, log, status] = await this.run(workspace, [
            command(['rev-parse', '--show-toplevel', '--show-prefix']), command(['symbolic-ref', '--quiet', '--short', 'HEAD']),
            command(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']),
            command(['log', '--all', '--date-order', '--max-count=300', `--pretty=format:${LOG_FORMAT}`]),
            command(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        ], signal, { read: true });
        const [toplevel, prefix = ''] = succeeded(where, 'git rev-parse failed').stdout.split('\n'), current = head.exitCode === 0 ? head.stdout.trim() : '';
        // A repository without commits has no log yet.
        const commits = log.exitCode === 0 ? parseLog(log.stdout) : /does not have any commits|bad default revision|unknown revision/i.test(log.stderr) ? [] : (() => { throw failure(log, 'git log failed'); })();
        return { location: workspace.location, repo: repoName(toplevel), current, prefix, ...parseBranches(succeeded(refs, 'git for-each-ref failed').stdout, current), commits,
            changes: parseStatus(succeeded(status, 'git status failed').stdout, prefix) };
    }
    /** Changed files, for the change marks and the change list. */
    async status(sessionId, signal) {
        const workspace = await this.workspace(sessionId, signal);
        const [where, status] = await this.run(workspace, [command(['rev-parse', '--show-prefix']), command(['status', '--porcelain=v1', '-z', '--untracked-files=all'])], signal, { read: true });
        const prefix = succeeded(where, 'git rev-parse failed').stdout.split('\n')[0];
        return { location: workspace.location, prefix, changes: parseStatus(succeeded(status, 'git status failed').stdout, prefix) };
    }
    /** An inline diff: the index against HEAD for staged rows, otherwise all working-tree changes against HEAD. */
    async diff(sessionId, path, signal, staged = false) {
        const workspace = await this.workspace(sessionId, signal);
        const [diff] = await this.run(workspace, [command(['diff', ...(staged ? ['--cached'] : ['HEAD']), '--', top(workspacePath(path))])], signal, { read: true });
        return { output: succeeded(diff, 'git diff failed').stdout };
    }
    /** A workspace file at HEAD and as it is now; `path` is relative to the workspace folder. */
    async compare(sessionId, path, signal, expectedCwd) {
        const workspace = await this.workspace(sessionId, signal, expectedCwd), file = workspacePath(path);
        const [[where, show, status], working] = await Promise.all([
            // `HEAD:./path` and the pathspec are relative to the working directory, the workspace folder.
            this.run(workspace, [command(['rev-parse', '--show-prefix']), command(['show', `HEAD:./${file}`]),
                command(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', `:(literal)${file}`])], signal, { read: true }),
            workspace.files.read(file, signal),
        ]);
        const prefix = succeeded(where, 'git rev-parse failed').stdout.split('\n')[0];
        // Git prints a file's bytes; the view compares text only.
        const head = show.truncated || Buffer.byteLength(show.stdout) > TEXT_LIMIT ? { kind: 'large' } : show.exitCode !== 0 ? { kind: 'absent' }
            : show.stdout.includes('\0') ? { kind: 'binary' } : { kind: 'text', content: show.stdout };
        const code = status.exitCode === 0 ? status.stdout.split('\0')[0]?.slice(0, 2) || undefined : undefined;
        return { location: workspace.location, path: file, repoPath: prefix + file, head, working, ...code ? { code } : {} };
    }
    async save(sessionId, path, content, revision, signal, expectedCwd) {
        if (typeof content !== 'string')
            throw new GitError('Invalid file contents');
        if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
            throw new GitError('A file revision is required');
        return (await this.workspace(sessionId, signal, expectedCwd)).files.write(workspacePath(path), content, revision, signal);
    }
    /** Save a reviewed conflict resolution, then stage that same verified workspace file. Never auto-commit a merge. */
    async saveResolve(sessionId, path, content, revision, id, signal, expectedCwd) {
        if (typeof content !== 'string')
            throw new GitError('Invalid file contents');
        if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
            throw new GitError('A file revision is required');
        if (/^(?:<{7}|={7}|>{7}|\|{7})/m.test(content))
            throw new GitError('Resolve every conflict marker before saving and resolving.', 409);
        const file = workspacePath(path);
        return this.operation(sessionId, id, signal, async (workspace, run, current) => {
            const saved = await workspace.files.write(file, content, revision, current);
            try {
                current.throwIfAborted();
                const checked = await workspace.files.read(file, current);
                if (checked.kind !== 'text' || checked.revision !== saved.revision)
                    throw new GitError('The file changed after saving. Review it before staging.', 409);
                const [staged] = await run([command(['add', '--', `:(literal)${file}`])]);
                succeeded(staged, 'git add failed');
                return { revision: saved.revision, staged: true, output: `${staged.stdout}${staged.stderr}`.trim() };
            }
            catch (error) {
                // The save already happened: explicitly report partial success so clients retain its new revision.
                return { revision: saved.revision, staged: false, error: error instanceof Error ? error.message : String(error) };
            }
        }, expectedCwd);
    }
    /** One change; `id` lets the user cancel it. */
    async change(sessionId, commands, id, signal, fallback, expectedCwd) {
        return this.operation(sessionId, id, signal, async (_workspace, run) => {
            const runs = await run(commands, false, true);
            for (const result of runs)
                succeeded(result, fallback);
            return { output: runs.map(result => `${result.stdout}${result.stderr}`.trim()).filter(Boolean).join('\n') };
        }, expectedCwd);
    }
    /** A local branch, or a remote branch as a new local branch tracking it. */
    async switchBranch(s, branch, remote, id, signal) {
        return this.change(s, [command(remote ? ['switch', '--track', argument(branch, 'branch')] : ['switch', argument(branch, 'branch')], HOOK_MS)], id, signal, 'git switch failed');
    }
    async pull(s, id, signal) { return this.change(s, [command(['pull'], NETWORK_MS)], id, signal, 'git pull failed'); }
    async fetch(s, id, signal) { return this.change(s, [command(['fetch', '--all', '--prune'], NETWORK_MS)], id, signal, 'git fetch failed'); }
    async push(s, id, signal) { return this.change(s, [command(['push'], NETWORK_MS)], id, signal, 'git push failed'); }
    /** Fetch current tracking information, integrate only when behind without rewriting commits, then push. */
    async sync(s, id, signal) {
        return this.operation(s, id, signal, async (_workspace, run) => {
            const [status, branch, upstream] = await run([command(['status', '--untracked-files=no']), command(['symbolic-ref', '--quiet', 'HEAD']),
                command(['rev-parse', '--verify', '--quiet', '@{upstream}'])], true);
            const state = succeeded(status, 'git status failed').stdout;
            if (/rebase in progress|currently rebasing/i.test(state))
                throw new GitError('A rebase is in progress. Resolve it and run git rebase --continue, or explicitly choose git rebase --abort in a terminal before syncing.', 409);
            if (/still merging|unmerged paths|currently cherry-picking|currently reverting|cherry-pick.*in progress|revert.*in progress/i.test(state))
                throw new GitError('A merge, cherry-pick or revert is in progress. Finish or explicitly abort it in a terminal before syncing.', 409);
            if (branch.exitCode !== 0)
                throw new GitError('Sync requires a branch. Switch from detached HEAD to a branch first.', 409);
            if (upstream.exitCode !== 0)
                throw new GitError('Sync requires an upstream branch. Set its tracking branch in a terminal first.', 409);
            const [fetched] = await run([command(['fetch'], NETWORK_MS)]);
            succeeded(fetched, 'git fetch failed');
            const [counts] = await run([command(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])], true);
            const match = /^(\d+)\s+(\d+)\s*$/.exec(succeeded(counts, 'git rev-list failed').stdout);
            if (!match)
                throw new GitError('Git returned invalid tracking counts', 422);
            const ahead = Number(match[1]), behind = Number(match[2]), output = [];
            if (behind) {
                const [changes] = await run([command(['status', '--porcelain=v1', '-z', '--untracked-files=no'])], true);
                if (succeeded(changes, 'git status failed').stdout)
                    throw new GitError('Commit or stash tracked changes before syncing a branch that is behind its upstream.', 409);
                // Explicit flags override pull.rebase/pull.ff and never hide user edits in an automatic stash.
                const [pulled] = await run([command(['pull', '--no-rebase', '--ff', '--no-edit', '--no-autostash'], NETWORK_MS)]);
                succeeded(pulled, 'git pull failed');
                output.push(pulled.stdout, pulled.stderr);
            }
            if (ahead || behind) {
                const [pushed] = await run([command(['push'], NETWORK_MS)]);
                succeeded(pushed, 'git push failed');
                output.push(pushed.stdout, pushed.stderr);
            }
            return { output: output.map(text => text.trim()).filter(Boolean).join('\n') };
        });
    }
    async rename(s, branch, to, id, signal) {
        return this.change(s, [command(['branch', '-m', argument(branch, 'branch'), argument(to, 'branch name')])], id, signal, 'git branch -m failed');
    }
    async deleteBranch(s, branch, id, signal) { return this.change(s, [command(['branch', '-D', argument(branch, 'branch')])], id, signal, 'git branch -D failed'); }
    /** `origin/topic` deletes `topic` on `origin`. */
    async deleteRemoteBranch(s, branch, id, signal) {
        const name = argument(branch, 'branch'), slash = name.indexOf('/');
        if (slash <= 0 || slash === name.length - 1)
            throw new GitError('Invalid remote branch');
        return this.change(s, [command(['push', name.slice(0, slash), '--delete', argument(name.slice(slash + 1), 'branch')], NETWORK_MS)], id, signal, 'git push --delete failed');
    }
    async merge(s, branch, id, signal) { return this.change(s, [command(['merge', '--no-edit', argument(branch, 'branch')], HOOK_MS)], id, signal, 'git merge failed'); }
    /** Stages everything and commits it. */
    async commit(s, text, id, signal) {
        return this.change(s, [command(['add', '-A']), command(['commit', '-m', message(text, 'commit message')], HOOK_MS)], id, signal, 'git commit failed');
    }
    async stashPush(s, text, id, signal) {
        const label = typeof text === 'string' && text.trim() ? message(text, 'stash message') : undefined;
        return this.change(s, [command(label ? ['stash', 'push', '-m', label] : ['stash', 'push'])], id, signal, 'git stash failed');
    }
    async stashPop(s, id, signal) { return this.change(s, [command(['stash', 'pop'])], id, signal, 'git stash pop failed'); }
    async stage(s, path, id, signal, expectedCwd) { return this.change(s, [command(['add', '--', top(workspacePath(path))])], id, signal, 'git add failed', expectedCwd); }
    async unstage(s, path, id, signal, from) {
        const paths = [top(workspacePath(path)), ...(from === undefined ? [] : [top(workspacePath(from))])];
        return this.change(s, [command(['reset', '-q', 'HEAD', '--', ...paths])], id, signal, 'git reset failed');
    }
    /** Unstaged changes go back to the index; an untracked file is removed. */
    async discard(s, path, untracked, id, signal) {
        const file = top(workspacePath(path));
        return this.change(s, [command(untracked ? ['clean', '-f', '--', file] : ['checkout', '--', file])], id, signal, 'Discarding the changes failed');
    }
    async cherryPick(s, commit, id, signal) { return this.change(s, [command(['cherry-pick', sha(commit)], HOOK_MS)], id, signal, 'git cherry-pick failed'); }
    async revert(s, commit, id, signal) { return this.change(s, [command(['revert', '--no-edit', sha(commit)], HOOK_MS)], id, signal, 'git revert failed'); }
    /** The HTTPS host of the remote that pull and push use, for saving a credential. */
    async credentialTarget(sessionId, signal) {
        const workspace = await this.workspace(sessionId, signal);
        const [url] = await this.run(workspace, [command(['ls-remote', '--get-url'])], signal, { read: true });
        try {
            const parsed = new URL(url.stdout.trim());
            if (parsed.protocol !== 'https:')
                return {};
            return { host: parsed.host, ...parsed.username ? { username: decodeURIComponent(parsed.username) } : {} };
        }
        catch {
            return {};
        }
    }
    /** Only for local workspaces: a remote machine keeps its own credential helpers and SSH keys. */
    async saveCredential(sessionId, host, username, password, signal) {
        const workspace = await this.workspace(sessionId, signal);
        if (!workspace.local)
            throw new GitError('Credentials are not saved for remote workspaces. Set up an SSH key or a Git credential helper on that machine.', 409);
        if (!this.options.credentials)
            throw new GitError('Saving credentials is unavailable', 501);
        await this.options.credentials.save(host, username, password);
    }
}
