import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quote } from './core/ssh.js';
import { dshHome } from './core/access.js';
import { CLAUDE_LAUNCHER, CODEX_LAUNCHER, TERMINAL_LAUNCHER } from './core/workspace.js';
import { tabHolder, TERMINAL_ID_ENV } from './holder-protocol.js';
/** Replaces a property, usually a method of the object's class. The returned function restores it, unless it has been replaced again since. */
function override(target, key, value) {
    const own = Object.getOwnPropertyDescriptor(target, key);
    target[key] = value;
    return () => {
        if (target[key] !== value)
            return;
        if (own)
            Object.defineProperty(target, key, own);
        else
            delete target[key];
    };
}
const isRequest = (value) => typeof value === 'object' && value !== null && typeof value.id === 'string';
/**
 * DSH tells a terminal's process its session but not which terminal it is, and that is what finds a sidebar terminal's
 * holder again. From DSH 0.2.2-rc.2 the ID joins the environment `spawn` is handed. Earlier, DSH reads its execution
 * environment first thing and synchronously in `spawn`, so the replacement is only ever seen by that call. A DSH that
 * works differently leaves terminals without the ID, which then end with their connection as before.
 */
export function passTerminalId(controller) {
    const { spawn, execution } = controller;
    if (typeof spawn !== 'function' || typeof execution !== 'function')
        return () => { };
    return override(controller, 'spawn', function (...args) {
        const [, , third, fourth] = args;
        if (typeof third === 'string' && typeof fourth === 'function') {
            const prepare = fourth;
            const withId = async (signal) => { const launch = await prepare(signal); return { ...launch, env: { ...launch.env, [TERMINAL_ID_ENV]: third } }; };
            return spawn.call(this, ...args.slice(0, 3), withId, ...args.slice(4));
        }
        if (!isRequest(third))
            return spawn.call(this, ...args);
        const restore = override(this, 'execution', function (target) {
            restore();
            const running = execution.call(this, target), { subprocess } = running;
            return { ...running, subprocess: new Proxy(subprocess, { get(source, key) {
                        const value = Reflect.get(source, key, source);
                        if (key !== 'spawnTerminal' || typeof value !== 'function')
                            return typeof value === 'function' ? value.bind(source) : value;
                        return (options) => value.call(source, { ...options, env: { ...options.env, [TERMINAL_ID_ENV]: third.id } });
                    } }) };
        });
        try {
            return spawn.call(this, ...args);
        }
        finally {
            restore();
        }
    });
}
/**
 * A browser remembers a launcher by its full path: for a sidebar terminal to start again after DSH restarts, and for what
 * New terminal opens. The folder is the installed plugin's, and it moved when terminals left Remote Agents. DSH refuses a
 * path it does not offer now, so one that names a launcher in another folder starts today's launcher of that name.
 * Stop this before whatever replaced `spawn` earlier.
 */
export function followMovedLaunchers(controller, launchers) {
    const current = new Map(launchers.map(path => [basename(path), path]));
    const moved = (args) => args.map((value) => {
        if (!isRequest(value) || value.shellPath === undefined)
            return value;
        const launcher = current.get(basename(value.shellPath));
        return launcher && launcher !== value.shellPath ? { ...value, shellPath: launcher } : value;
    });
    // The method that reads the request's shell: `userLaunch` where DSH has it, otherwise `spawn`.
    const key = typeof controller.userLaunch === 'function' ? 'userLaunch' : 'spawn', start = controller[key];
    if (typeof start !== 'function')
        return () => { };
    return override(controller, key, function (...args) { return start.call(this, ...moved(args)); });
}
/**
 * Closing a sidebar terminal should end what runs in it. DSH ends its process the same way when it quits, which must leave
 * the holder on the host running, and only a close passes through here. A host that cannot be reached keeps it until it expires.
 */
export function endClosedTerminals(controller, end) {
    const { close } = controller;
    if (typeof close !== 'function')
        return () => { };
    return override(controller, 'close', function (agent, id) {
        void end(agent.id, tabHolder(agent.id, id)).catch(() => { });
        return close.call(this, agent, id);
    });
}
/**
 * Native terminal keeps its PTY, resizing and keyboard handling; the selected shell runs SSH.
 * DSH remembers one shell for every conversation, so outside a remote workspace the launcher opens the local shell.
 * The Remote Claude and Remote Codex launchers run the interactive CLI there first, a session DSH neither drives nor
 * records. In a TUI conversation of that CLI (see tui.ts) it runs the same session every time, found through DSH_SESSION_ID,
 * which DSH sets in its terminals, so that reopening the conversation resumes it.
 * On the host the shell or CLI runs in a holder (see terminal-hold.ts), so it outlives DSH and the connection; a host that
 * cannot run one gets a plain connection.
 * DSH does not pass DSH_HOME to its terminals, so the launcher carries the home it was installed from.
 * `state` names the files it reads the saved machines and the TUI conversations from; `modules` is the compiled server
 * root it imports the SSH and workspace modules from.
 */
export async function installWorkspaceTerminal(controller, directory, state, modules = new URL('./', import.meta.url)) {
    const candidates = controller.config?.shellCandidates;
    if (!Array.isArray(candidates))
        return { dispose: () => { } };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const script = join(directory, 'remote-workspace.mjs'), launcherPath = (name) => join(directory, process.platform === 'win32' ? `${name}.cmd` : name);
    const launcher = launcherPath(TERMINAL_LAUNCHER), claudeLauncher = launcherPath(CLAUDE_LAUNCHER), codexLauncher = launcherPath(CODEX_LAUNCHER);
    // The build writes it next to lib/server. Only the holder needs it, and a host then gets a plain connection without it.
    const holderPath = fileURLToPath(new URL('../terminal-holder.mjs', modules));
    const holderVersion = await readFile(holderPath).then(data => createHash('sha256').update(data).digest('hex').slice(0, 16), () => undefined);
    const source = `import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { savedHosts } from ${JSON.stringify(new URL('core/saved-hosts.js', modules).href)};
import { WorkspaceAccess, omcStateDir, under } from ${JSON.stringify(new URL('core/access.js', modules).href)};
import { connectionInput, quote } from ${JSON.stringify(new URL('core/ssh.js', modules).href)};
import { tuiClaudeSession } from ${JSON.stringify(new URL('tui.js', modules).href)};
import { holdTerminal, TERMINAL_KEEPALIVE, TERMINAL_TYPING } from ${JSON.stringify(new URL('terminal-hold.js', modules).href)};
import { tabHolder, tuiHolder, TERMINAL_ID_ENV } from ${JSON.stringify(new URL('holder-protocol.js', modules).href)};
const run = (file, args, env) => {
  const child = spawn(file, args, { stdio: 'inherit', env });
  child.on('error', e => { process.stderr.write(e.message + '\\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
};
const hosts = await savedHosts(${JSON.stringify(state.hosts)});
const cwd = process.cwd();
const placement = await new WorkspaceAccess(() => hosts, { home: await realpath(process.env.DSH_HOME?.trim() || ${JSON.stringify(dshHome())}) }).resolve(cwd);
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
  const host = hosts.find(h => placement.hostIds.includes(h.id));
  if (!host || !placement.cwd) throw new Error('Select a verified remote workspace before using this shell.');
  const url = new URL(connectionInput(host.connection));
  const target = (url.username ? decodeURIComponent(url.username) + '@' : '') + url.hostname;
  const shell = '"\${SHELL:-/bin/sh}"';
  const cli = process.argv[2];
  const dshSession = process.env.DSH_SESSION_ID;
  // What is saved about TUI conversations; see TuiState.
  const saved = JSON.parse(await readFile(${JSON.stringify(state.tui)}, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
  const details = (dshSession && saved.tuiDetails?.[dshSession]) || {};
  // Only a TUI conversation's own CLI is its session; the other launcher, chosen in its sidebar, is that CLI as usual.
  const own = dshSession && saved.tuiSessions?.includes(dshSession) && (details.cli ?? 'claude') === cli;
  const claudeSession = own ? tuiClaudeSession(dshSession) : undefined;
  const choice = (details.model ? ' --model "' + details.model + '"' : '') + (details.effort ? ' --effort "' + details.effort + '"' : '');
  // Claude Code saves a session only once it has a message, so the first launches of a new one have nothing to resume.
  // Those use the model chosen in the composer; a resumed session keeps whatever /model chose since.
  const claude = claudeSession ? 'if find "\${CLAUDE_CONFIG_DIR:-\$HOME/.claude}/projects" -maxdepth 2 -name ' + claudeSession + '.jsonl 2>/dev/null | grep -q .; then claude --resume ' + claudeSession + '; else claude --session-id ' + claudeSession + choice + '; fi' : 'claude';
  // Codex's own screen would turn the wheel into its prompt history, and leave nothing for the terminal to scroll. Its
  // update prompt would run an install on the first Enter, and typing starts as soon as a conversation is selected.
  const codexFlags = ' --no-alt-screen -c check_for_update_on_startup=false';
  const codexChoice = (details.model ? ' -m "' + details.model + '"' : '') + (details.effort ? ' -c model_reasoning_effort="' + details.effort + '"' : '');
  // The thread is saved when the conversation starts, but Codex opens it with the configured model until it has a turn.
  // From then on it keeps whatever /model chose. A thread that is gone, say removed by hand, leaves a new one to start.
  const codex = own && details.thread ? 'dsh_file=$(find "\${CODEX_HOME:-\$HOME/.codex}/sessions" -maxdepth 4 -name "rollout-*-' + details.thread + '.jsonl" 2>/dev/null | head -n 1); if [ -z "\$dsh_file" ]; then codex' + codexFlags + codexChoice + '; elif grep -q task_started "\$dsh_file"; then codex resume' + codexFlags + ' ' + details.thread + '; else codex resume' + codexFlags + codexChoice + ' ' + details.thread + '; fi' : 'codex' + codexFlags;
  const interactive = cli === 'claude' ? claude : cli === 'codex' ? codex : undefined;
  // The same process stays in charge of the terminal throughout; a shell run beside it could be left without the TTY.
  const start = interactive ? shell + " -lic '" + interactive + "; exec " + shell + " -l'" : shell + ' -l';
  // Claude Code's classic renderer, so that the terminal scrolls the conversation itself; see TuiSessions.localScroll.
  const localScroll = cli === 'claude' && saved.tuiLocalScroll !== false;
  // SSH does not carry COLORTERM. Without it Claude Code falls back to 256 colors, which turns its orange pink.
  const command = 'cd ' + quote(placement.cwd) + (interactive ? ' && export COLORTERM=truecolor' + (localScroll ? ' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1' : '') : '') + ' && exec ' + start;
  const ssh = ['-tt', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR', ...TERMINAL_KEEPALIVE, ...TERMINAL_TYPING, ...(url.port ? ['-p', url.port] : []), '--', target];
  const terminalId = process.env[TERMINAL_ID_ENV];
  const holder = own ? tuiHolder(dshSession) : dshSession && terminalId ? tabHolder(dshSession, terminalId) : undefined;
  const version = ${JSON.stringify(holderVersion ?? null)};
  const kept = holder && version ? await holdTerminal({ ssh, holder, command, script: { path: ${JSON.stringify(holderPath)}, version } }) : 'direct';
  if (kept === 'direct') run('ssh', [...ssh, command], process.env);
  else process.exitCode = kept;
}
`;
    await writeFile(script, source, { mode: 0o600 });
    const installLauncher = (path, argument) => writeFile(path, process.platform === 'win32'
        ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}"${argument && ` ${argument}`}\r\n`
        : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(script)}${argument && ` ${argument}`}\n`, { mode: 0o700 });
    await installLauncher(launcher, '');
    await installLauncher(claudeLauncher, 'claude');
    await installLauncher(codexLauncher, 'codex');
    const launchers = [launcher, claudeLauncher, codexLauncher];
    for (const path of launchers)
        if (!candidates.includes(path))
            candidates.push(path);
    const stopPassing = passTerminalId(controller), stopFollowing = followMovedLaunchers(controller, launchers);
    // Leave the launchers on disk until the next boot: an already open native terminal may still start them.
    return { shell: launcher, dispose: () => { stopFollowing(); stopPassing(); for (const path of launchers) {
            const index = candidates.indexOf(path);
            if (index >= 0)
                candidates.splice(index, 1);
        } } };
}
