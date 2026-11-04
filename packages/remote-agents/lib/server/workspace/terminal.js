import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { quote } from '../core/ssh.js';
import { dshHome } from './access.js';
import { CLAUDE_LAUNCHER, TERMINAL_LAUNCHER } from './domain.js';
/**
 * Native terminal keeps its PTY, resizing and keyboard handling; the selected shell runs SSH.
 * DSH remembers one shell for every conversation, so outside a remote workspace the launcher opens the local shell.
 * The Remote Claude launcher runs the interactive `claude` there first, a session DSH neither drives nor records.
 * In a TUI conversation (see tui.ts) it runs the same Claude session every time, identified by DSH_SESSION_ID, which DSH
 * sets in its terminals, so that reopening the conversation resumes it.
 * DSH does not pass DSH_HOME to its terminals, so the launcher carries the home it was installed from.
 * `modules` is the compiled server root the launcher imports the store, SSH and workspace modules from.
 */
export async function installWorkspaceTerminal(controller, directory, stateFile, modules = new URL('../', import.meta.url)) {
    const candidates = controller.config?.shellCandidates;
    if (!Array.isArray(candidates))
        return { dispose: () => { } };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const script = join(directory, 'remote-workspace.mjs'), launcherPath = (name) => join(directory, process.platform === 'win32' ? `${name}.cmd` : name);
    const launcher = launcherPath(TERMINAL_LAUNCHER), claudeLauncher = launcherPath(CLAUDE_LAUNCHER);
    const source = `import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from ${JSON.stringify(new URL('core/store.js', modules).href)};
import { WorkspaceAccess, omcStateDir, under } from ${JSON.stringify(new URL('workspace/access.js', modules).href)};
import { connectionInput, quote } from ${JSON.stringify(new URL('core/ssh.js', modules).href)};
const run = (file, args, env) => {
  const child = spawn(file, args, { stdio: 'inherit', env });
  child.on('error', e => { process.stderr.write(e.message + '\\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
};
const store = new Store(${JSON.stringify(stateFile)}); await store.open();
const cwd = process.cwd();
const placement = await new WorkspaceAccess(() => store.hosts(), { home: await realpath(process.env.DSH_HOME?.trim() || ${JSON.stringify(dshHome())}) }).resolve(cwd);
// A removed oh-my-claude placeholder keeps refusing: its empty folder is not the project.
if (!placement.cwd && !under(resolve(omcStateDir(), 'remote-workspaces'), resolve(cwd))) {
  process.stderr.write('Not a remote workspace; starting the local shell.\\n');
  // Electron's Node mode must not leak into the user's shell, where it would break Electron apps it starts.
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  if (process.platform === 'win32') run(env.ComSpec || 'cmd.exe', [], env);
  else {
    // Job-control keys belong to the shell; the launcher only waits for it.
    for (const signal of ['SIGINT', 'SIGQUIT', 'SIGTSTP']) process.on(signal, () => {});
    run(env.SHELL || '/bin/sh', ['-i'], env);
  }
} else {
  const host = store.hosts().find(h => placement.hostIds.includes(h.id));
  if (!host || !placement.cwd) throw new Error('Select a verified remote workspace before using this shell.');
  const url = new URL(connectionInput(host.connection));
  const target = (url.username ? decodeURIComponent(url.username) + '@' : '') + url.hostname;
  const shell = '"\${SHELL:-/bin/sh}"';
  const dshSession = process.env.DSH_SESSION_ID;
  const hash = dshSession && store.snapshot().tuiSessions?.includes(dshSession) ? createHash('sha256').update('dsh-tui:' + dshSession).digest('hex') : undefined;
  const claudeSession = hash && [hash.slice(0, 8), hash.slice(8, 12), '4' + hash.slice(13, 16), '8' + hash.slice(17, 20), hash.slice(20, 32)].join('-');
  // Claude Code saves a session only once it has a message, so the first launches of a new one have nothing to resume.
  const claude = claudeSession ? 'if find "\${CLAUDE_CONFIG_DIR:-\$HOME/.claude}/projects" -maxdepth 2 -name ' + claudeSession + '.jsonl 2>/dev/null | grep -q .; then claude --resume ' + claudeSession + '; else claude --session-id ' + claudeSession + '; fi' : 'claude';
  // The same process stays in charge of the terminal throughout; a shell run beside it could be left without the TTY.
  const start = process.argv[2] === 'claude' ? shell + " -lic '" + claude + "; exec " + shell + " -l'" : shell + ' -l';
  const command = 'cd ' + quote(placement.cwd) + ' && exec ' + start;
  run('ssh', ['-tt', '-o', 'StrictHostKeyChecking=yes', ...(url.port ? ['-p', url.port] : []), '--', target, command], process.env);
}
`;
    await writeFile(script, source, { mode: 0o600 });
    const installLauncher = (path, argument) => writeFile(path, process.platform === 'win32'
        ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}"${argument && ` ${argument}`}\r\n`
        : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(script)}${argument && ` ${argument}`}\n`, { mode: 0o700 });
    await installLauncher(launcher, '');
    await installLauncher(claudeLauncher, 'claude');
    const launchers = [launcher, claudeLauncher];
    for (const path of launchers)
        if (!candidates.includes(path))
            candidates.push(path);
    // Leave the launchers on disk until the next boot: an already open native terminal may still start them.
    return { shell: launcher, dispose: () => { for (const path of launchers) {
            const index = candidates.indexOf(path);
            if (index >= 0)
                candidates.splice(index, 1);
        } } };
}
