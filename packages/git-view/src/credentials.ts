import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitError } from './runner.js';

const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?$/;
const field = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\0-\x1f\x7f]/.test(value)) throw new GitError(`Invalid ${label}`);
  return value;
};
/** Shell quoting for the path in a credential helper command, which Git runs through the shell. */
const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * HTTPS credentials saved from the Git view for local workspaces, in Git's own `store` format, in a file of this plugin
 * that only its own Git commands read. For each saved host they replace the other credential helpers, so a credential
 * from the system keychain is never copied into the file and Git in a terminal is unaffected.
 */
export class Credentials {
  constructor(private readonly file: string) {}
  private async lines(): Promise<string[]> {
    try { return (await readFile(this.file, 'utf8')).split('\n').filter(Boolean); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private hostOf(line: string): string | undefined { try { return new URL(line).host; } catch { return undefined; } }
  /** `-c` options before each Git command. */
  async config(): Promise<string[]> {
    const hosts = [...new Set((await this.lines()).map(line => this.hostOf(line)).filter((host): host is string => !!host && HOST.test(host)))];
    return hosts.flatMap(host => ['-c', `credential.https://${host}.helper=`, '-c', `credential.https://${host}.helper=store --file=${quote(this.file)}`]);
  }
  /** Replaces the host's saved credential. */
  async save(host: unknown, username: unknown, password: unknown): Promise<void> {
    const name = field(host, 'host'), user = field(username, 'username'), secret = field(password, 'password');
    if (!HOST.test(name)) throw new GitError('Invalid host');
    const lines = (await this.lines()).filter(line => this.hostOf(line) !== name);
    lines.push(`https://${encodeURIComponent(user)}:${encodeURIComponent(secret)}@${name}`);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }
}
