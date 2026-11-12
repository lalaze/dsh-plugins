/** Where a task's files are: a worktree of the repository, on this computer or a saved machine, through dsh-remote-terminals. */
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from './domain.js';
const said = (message) => message.key.replace(/\{(\w+)\}/gu, (whole, name) => message.values?.[name] ?? whole) + (message.detail ? `\n${message.detail.trim()}` : '');
export class Workplaces {
    service;
    pollMs;
    constructor(service, pollMs = 300) {
        this.service = service;
        this.pollMs = pollMs;
    }
    worktrees() {
        const value = this.service('remoteAgentsWorktrees');
        if (!value)
            throw new Error('Worktree workspaces are not available: install dsh-remote-terminals beside dsh-remote-agents (0.2.130 or newer)');
        return value;
    }
    projects(signal) { return this.worktrees().projects(signal); }
    inspect(project, signal) { return this.worktrees().inspect(project, signal); }
    machine(path, signal) { return this.worktrees().machine(path, signal); }
    /**
     * A worktree on a new branch from `base`, added to DSH as a workspace. The repository's own setup commands run without
     * asking: nobody is there, and the models that follow run commands from the same repository anyway.
     */
    async create(input, signal) {
        const worktrees = this.worktrees(), detail = await worktrees.inspect(input.project, signal);
        if (!detail.branches.some(branch => branch.name === input.base))
            throw new Error(`Branch ${input.base} is not in ${detail.name}`);
        let branch = input.branch;
        for (let index = 2; detail.branches.some(entry => entry.name === branch && entry.local); index++)
            branch = `${input.branch}-${index}`;
        let job = worktrees.create({ path: input.project, mode: 'new', base: input.base, branch, setup: detail.setup });
        const stop = () => { void worktrees.act(job.id, 'cancel').catch(() => undefined); };
        signal.addEventListener('abort', stop, { once: true });
        try {
            for (;;) {
                job = worktrees.job(job.id);
                if (job.state === 'running') {
                    await delay(this.pollMs);
                    continue;
                }
                if (job.state === 'failed' && job.actions.includes('confirm') && !signal.aborted) {
                    job = await worktrees.act(job.id, 'confirm');
                    continue;
                }
                break;
            }
        }
        finally {
            signal.removeEventListener('abort', stop);
        }
        signal.throwIfAborted();
        // A worktree whose setup failed is still a worktree; without one there is nothing to work in.
        if (job.state !== 'done' && job.result?.path && job.actions.includes('skip')) {
            const failure = job.error ? said(job.error) : 'Setup failed';
            job = await worktrees.act(job.id, 'skip');
            for (; job.state === 'running'; job = worktrees.job(job.id))
                await delay(this.pollMs);
            if (job.state === 'done' && job.result?.path)
                return { path: job.result.path, worktree: job.result.worktree, branch: job.result.branch ?? branch, warnings: [...job.result.warnings.map(said), `Setup did not finish: ${failure}`] };
        }
        if (job.state !== 'done' || !job.result?.path)
            throw new Error(job.error ? said(job.error) : 'The worktree could not be created');
        return { path: job.result.path, worktree: job.result.worktree, branch: job.result.branch ?? branch, warnings: job.result.warnings.map(said) };
    }
    /**
     * Takes a worktree away: its conversations are archived, its folder is deleted and its workspace leaves DSH. Refused
     * while the worktree holds anything that exists nowhere else, as nobody is shown what would be lost. `project` is a
     * workspace of the same repository. With `deleteBranch` the branch goes too when it is merged into the repository's
     * default branch; `branch` says whether it did, and `kept` why not. `warnings` is what else there is to know.
     */
    async remove(input, signal) {
        const worktrees = this.worktrees();
        if (typeof worktrees.archiveCheck !== 'function' || typeof worktrees.archive !== 'function')
            throw fail('Removing a workspace needs a newer dsh-remote-terminals');
        const check = await worktrees.archiveCheck(input.project, input.worktree, signal);
        if (check.dirty > 0)
            throw fail('The workspace has {count} files that are not committed. Commit them or throw them away first, or archive the workspace from the sidebar.', { count: String(check.dirty) });
        if (check.unpushed === null)
            throw fail('Git could not tell whether everything in the workspace is pushed. Archive the workspace from the sidebar if it can go.');
        if (check.unpushed > 0)
            throw fail('The workspace has {count} commits that are not pushed. Push them first, or archive the workspace from the sidebar.', { count: String(check.unpushed) });
        let job = worktrees.archive({ path: input.project, worktree: input.worktree, ...(input.deleteBranch ? { deleteBranch: true } : {}) });
        const stop = () => { void worktrees.act(job.id, 'cancel').catch(() => undefined); };
        signal.addEventListener('abort', stop, { once: true });
        try {
            for (; (job = worktrees.job(job.id)).state === 'running';)
                await delay(this.pollMs);
        }
        finally {
            signal.removeEventListener('abort', stop);
        }
        signal.throwIfAborted();
        // A teardown command that failed is the repository's to fix: nobody is here to say it may be skipped.
        if (job.state !== 'done')
            throw fail('The workspace could not be removed', undefined, job.error ? said(job.error) : undefined);
        const warnings = job.result?.warnings ?? [], kept = warnings.filter(warning => warning.key.startsWith('Branch {branch} was kept'));
        return { warnings: warnings.filter(warning => !kept.includes(warning)).map(said), kept: kept.map(said), ...(input.deleteBranch ? { branch: kept.length || !job.result?.branch ? 'kept' : 'deleted' } : {}) };
    }
}
