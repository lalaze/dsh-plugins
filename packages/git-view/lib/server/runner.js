import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
/** Only this DSH home's anchor tree is remote; ordinary projects may be named remote-workspaces. */
export function isRemoteAnchor(cwd, home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')) {
    const path = relative(join(home, 'remote-workspaces'), cwd);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
export class GitError extends Error {
    status;
    detail;
    constructor(message, status = 400, detail = {}) {
        super(message);
        this.status = status;
        this.detail = detail;
    }
}
/**
 * Git never waits for a password, an editor or a pager, and reports in English so its messages can be recognized; the
 * same environment as Remote Agents gives Git on an SSH host. Credential helpers and SSH keys keep working.
 */
export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', GIT_EDITOR: ':', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C' };
const STDERR_LIMIT = 64 * 1024;
/** Finds Git once; on macOS the `/usr/bin/git` stub counts only with the Command Line Tools installed. */
export function gitExecutable(subprocess) {
    let found;
    return () => found ??= (async () => {
        const executable = await subprocess.resolveExecutable('git').catch(() => { throw new GitError('Git is not installed on this machine', 501); });
        if (process.platform !== 'darwin' || executable !== '/usr/bin/git')
            return executable;
        const tools = await subprocess.spawn({ argv: ['/usr/bin/xcode-select', '-p'], cwd: homedir(), graceMs: 1000,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } }).done.catch(() => ({ exitCode: null }));
        if (tools.exitCode !== 0)
            throw new GitError('Git needs the Xcode Command Line Tools. Run xcode-select --install in a terminal.', 501);
        return executable;
    })().catch(error => { found = undefined; throw error; });
}
/** Git on the DSH machine through DSH's subprocess service. `config` comes before every command, such as saved credentials. */
export class LocalRunner {
    subprocess;
    git;
    cwd;
    config;
    cancels = new Map();
    constructor(subprocess, git, cwd, config = async () => []) {
        this.subprocess = subprocess;
        this.git = git;
        this.cwd = cwd;
        this.config = config;
    }
    async run(batch, signal) {
        const cancel = new AbortController(), runs = [];
        this.cancels.set(batch.id, cancel);
        try {
            const [git, config] = await Promise.all([this.git(), this.config()]);
            for (const command of batch.commands) {
                if (cancel.signal.aborted || (batch.stopOnError && runs.some(run => run.exitCode !== 0))) {
                    runs.push({ exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, skipped: true });
                    continue;
                }
                signal.throwIfAborted();
                const timeout = AbortSignal.timeout(command.timeoutMs);
                const handle = this.subprocess.spawn({ argv: [git, ...config, ...command.argv], cwd: this.cwd, graceMs: 2000, signal: AbortSignal.any([signal, cancel.signal, timeout]),
                    env: { ...GIT_ENV, ...batch.optionalLocks === false ? { GIT_OPTIONAL_LOCKS: '0' } : {} },
                    stdio: { stdin: 'ignore', stdout: { maxBytes: batch.maxBytes }, stderr: { maxBytes: STDERR_LIMIT } } });
                const outcome = await handle.done.catch((error) => { throw new GitError(`Git could not start: ${error instanceof Error ? error.message : String(error)}`, 500); });
                const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false };
                const stopped = timeout.aborted || cancel.signal.aborted;
                runs.push({ exitCode: stopped || stdout.lossy ? null : outcome.exitCode, stdout: stdout.text, stderr: handle.collected.stderr?.readFrom(0).text ?? '',
                    timedOut: timeout.aborted, truncated: stdout.lossy, skipped: false });
            }
            signal.throwIfAborted();
            return runs;
        }
        finally {
            this.cancels.delete(batch.id);
        }
    }
    async cancel(id) { this.cancels.get(id)?.abort(); }
}
/** Git in a Remote Agents remote workspace, over the machine's SSH connection. */
export class RemoteRunner {
    service;
    sessionId;
    target;
    constructor(service, sessionId, target) {
        this.service = service;
        this.sessionId = sessionId;
        this.target = target;
        // Older Remote Agents exposes workspace files but not Git batches. Never silently run on the local anchor.
        if (service.gitWorkspaceVersion !== 1 || ['git', 'cancelGit', 'stat', 'download', 'upload'].some(key => typeof service[key] !== 'function')) {
            throw new GitError('Update Remote Agents to a version with Git workspace support', 409);
        }
    }
    run(batch, signal) { return remoteCall(() => this.service.git(this.sessionId, batch, signal, this.target)); }
    cancel(id) { return remoteCall(() => this.service.cancelGit(this.sessionId, id, undefined, this.target)); }
}
/** Remote Agents reports failures with an HTTP status; keep it. */
export async function remoteCall(call) {
    try {
        return await call();
    }
    catch (error) {
        const status = error?.status;
        if (error instanceof Error && typeof status === 'number' && !(error instanceof GitError))
            throw new GitError(error.message, status);
        throw error;
    }
}
