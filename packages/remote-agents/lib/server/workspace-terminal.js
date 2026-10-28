import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { quote } from './ssh.js';
import { TERMINAL_LAUNCHER } from './workspace-domain.js';
/**
 * Native terminal keeps its PTY, resizing and keyboard handling; the selected shell runs SSH.
 * DSH remembers one shell for every conversation, so outside a remote workspace the launcher opens the local shell.
 */
export async function installWorkspaceTerminal(controller, directory, stateFile, modules = new URL('./', import.meta.url)) {
    const candidates = controller.config?.shellCandidates;
    if (!Array.isArray(candidates))
        return { dispose: () => { } };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const script = join(directory, 'remote-workspace.mjs'), launcher = join(directory, process.platform === 'win32' ? `${TERMINAL_LAUNCHER}.cmd` : TERMINAL_LAUNCHER);
    const source = `import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from ${JSON.stringify(new URL('store.js', modules).href)};
import { WorkspaceAccess, dshHome, omcStateDir, under } from ${JSON.stringify(new URL('workspace-access.js', modules).href)};
import { connectionInput, quote } from ${JSON.stringify(new URL('ssh.js', modules).href)};
const run = (file, args, env) => {
  const child = spawn(file, args, { stdio: 'inherit', env });
  child.on('error', e => { process.stderr.write(e.message + '\\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
};
const store = new Store(${JSON.stringify(stateFile)}); await store.open();
const cwd = process.cwd();
const placement = await new WorkspaceAccess(() => store.hosts(), { home: await realpath(dshHome()) }).resolve(cwd);
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
  const command = 'cd ' + quote(placement.cwd) + ' && exec "\${SHELL:-/bin/sh}" -l';
  run('ssh', ['-tt', '-o', 'StrictHostKeyChecking=yes', ...(url.port ? ['-p', url.port] : []), '--', target, command], process.env);
}
`;
    await writeFile(script, source, { mode: 0o600 });
    await writeFile(launcher, process.platform === 'win32'
        ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}"\r\n`
        : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(script)}\n`, { mode: 0o700 });
    if (!candidates.includes(launcher))
        candidates.push(launcher);
    // Leave the launcher on disk until the next boot: an already open native terminal may still start it.
    return { shell: launcher, dispose: () => { const index = candidates.indexOf(launcher); if (index >= 0)
            candidates.splice(index, 1); } };
}
