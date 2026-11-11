/** A folder on the computer DSH runs on, opened as a DSH workspace so it can be chosen as a repository. */
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fail } from './domain.js';

interface WorkspaceController { create(input: { path: string }): Promise<unknown> }
/** Git's answer in `folder`, without the last line break; undefined when Git refuses or is missing. */
export type RunGit = (folder: string, args: string[]) => Promise<string | undefined>;
const git: RunGit = (folder, args) => new Promise(done => {
  execFile('git', ['-C', folder, ...args], { timeout: 10_000, maxBuffer: 1 << 20 }, (error, stdout) => done(error ? undefined : stdout.replace(/\r?\n$/u, '')));
});
export interface AddedFolder { folder: string; repository: string; remotes: string[] }

export class Folders {
  /** `service` looks a DSH service up by name at the moment it is needed. */
  constructor(private readonly service: (name: string) => unknown, private readonly run: RunGit = git) {}

  /** The repository's own Git folder, which the repository and every worktree of it share. */
  async repository(folder: string): Promise<string | undefined> {
    const common = await this.run(folder, ['rev-parse', '--git-common-dir']);
    if (common === undefined) return undefined;
    const path = resolve(folder, common);
    return realpath(path).catch(() => path);
  }

  /** Opens the repository that holds `typed` as a workspace. A folder inside a repository stands for the whole repository. */
  async add(typed: string): Promise<AddedFolder> {
    let path = typed.trim().replace(/^(["'])(.*)\1$/u, '$2').trim();
    if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1));
    if (!path || !isAbsolute(path)) throw fail("Write the folder's full path, such as /Users/you/code/project");
    path = resolve(path);
    if (!await stat(path).then(found => found.isDirectory(), () => false)) throw fail('{folder} is not a folder on the computer DSH runs on', { folder: path });
    const folder = await this.run(path, ['rev-parse', '--show-toplevel']), repository = folder ? await this.repository(folder) : undefined;
    if (!folder || !repository) throw fail('{folder} is not a Git repository', { folder: path });
    const workspaces = this.service('workspaceController') as WorkspaceController | undefined;
    if (!workspaces) throw new Error('Workspaces are not available in this DSH');
    await workspaces.create({ path: folder });
    const remotes = (await this.run(folder, ['remote']) ?? '').split('\n').map(line => line.trim()).filter(Boolean);
    return { folder, repository, remotes };
  }
}
