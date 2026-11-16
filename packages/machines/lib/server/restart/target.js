/**
 * How this DSH can be started again once it quits, and what a quit would interrupt. A plugin cannot relaunch its own
 * host, so a detached helper does it (helper.ts); this file only decides how, from process facts it is given.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const quiet = (command, args) => {
    try {
        return execFileSync(command, args, { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] });
    }
    catch {
        return undefined;
    }
};
export function processFacts() {
    return {
        platform: process.platform, pid: process.pid, ppid: process.ppid, uid: process.getuid?.() ?? -1,
        execPath: process.execPath, execArgv: [...process.execArgv], argv: [...process.argv], cwd: process.cwd(), env: process.env,
        ipc: typeof process.send === 'function',
        commandOf: pid => quiet('/bin/ps', ['-o', 'command=', '-p', String(pid)])?.trim() || undefined,
        launchctlPrint: target => quiet('/bin/launchctl', ['print', target]),
    };
}
/** Variables only a child of this process may have. */
const CHILD_ONLY = new Set(['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']);
export function launchEnv(env) {
    return Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== undefined && !CHILD_ONLY.has(entry[0])));
}
const BUNDLE_EXECUTABLE = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/;
export function restartTarget(facts) {
    if (facts.platform === 'win32')
        return { ok: false, reason: 'Restarting DSH is not supported on Windows.' };
    const desktopHost = facts.env.ELECTRON_RUN_AS_NODE === '1' && facts.ipc && facts.argv.some(arg => arg.includes('dsh-desktop-host'));
    if (desktopHost) {
        if (facts.platform !== 'darwin')
            return { ok: false, reason: 'Restarting the desktop app is supported on macOS only.' };
        const bundle = BUNDLE_EXECUTABLE.exec(facts.execPath)?.[1];
        if (!bundle)
            return { ok: false, reason: `The desktop app's bundle is unknown (${facts.execPath}).` };
        const parent = facts.commandOf(facts.ppid);
        if (parent !== facts.execPath) {
            return { ok: false, reason: parent?.startsWith(facts.execPath) ? 'The desktop app was started with extra arguments, which a relaunch would lose.' : `The desktop app's main process (pid ${facts.ppid}) is not ${facts.execPath}.` };
        }
        return { ok: true, launch: { kind: 'desktop', quitPid: facts.ppid, hostPid: facts.pid, bundle } };
    }
    if (facts.env.INVOCATION_ID !== undefined)
        return { ok: false, reason: 'DSH runs under systemd; restart it with systemctl.' };
    // launchd names its jobs' processes; Terminal sessions say 0 and apps opened by LaunchServices say application.*.
    const label = facts.env.XPC_SERVICE_NAME;
    if (facts.platform === 'darwin' && label && label !== '0' && !label.startsWith('application.')) {
        for (const domain of [`gui/${facts.uid}`, `user/${facts.uid}`]) {
            const printed = facts.launchctlPrint(`${domain}/${label}`);
            const pid = Number(/^\s*pid = (\d+)/m.exec(printed ?? '')?.[1]);
            if (printed === undefined)
                continue;
            // The job is this process or its wrapper. Another job's label (a shell started by one) means a plain process.
            if (pid === facts.pid || pid === facts.ppid)
                return { ok: true, launch: { kind: 'launchd', target: `${domain}/${label}` } };
            break;
        }
    }
    const script = facts.argv[1];
    if (!script)
        return { ok: false, reason: "This DSH's command line is unknown." };
    return { ok: true, launch: { kind: 'process', pid: facts.pid, command: facts.execPath, args: [...facts.execArgv, ...facts.argv.slice(1)], cwd: facts.cwd, env: launchEnv(facts.env) } };
}
/** What a quit would interrupt, as the desktop app's own quit check sees it: running or queued turns, running jobs. */
export function inspectBusy(agents, jobs, titleOf) {
    const live = agents?.list() ?? [];
    const sessions = live.filter(agent => agent.status === 'running' || (agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0)
        .map(agent => { const title = titleOf(agent); return title ? { id: agent.id, title } : { id: agent.id }; });
    const seen = new Set();
    const running = [];
    for (const owner of [undefined, ...live.map(agent => agent.id)]) {
        let list = [];
        try {
            list = jobs?.list(owner) ?? [];
        }
        catch { /* an owner without jobs */ }
        for (const job of list) {
            if ((job.status !== 'running' && job.status !== 'stopping') || seen.has(job.id))
                continue;
            seen.add(job.id);
            running.push({ id: job.id, label: job.label ?? job.id });
        }
    }
    return { sessions, jobs: running };
}
const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return undefined;
    }
};
/** DSH's version (the package above its entry script) and the profile's plugins, best effort. */
export function readVersions(profileDir, entry) {
    const plugins = {};
    const manifest = profileDir ? readJson(join(profileDir, 'package.json')) : undefined;
    for (const name of Object.keys({ ...(manifest?.dependencies ?? {}) })) {
        const version = readJson(join(profileDir, 'node_modules', name, 'package.json'))?.version;
        if (typeof version === 'string')
            plugins[name] = version;
    }
    let dsh;
    for (let dir = entry ? dirname(entry) : ''; dir && dir !== dirname(dir); dir = dirname(dir)) {
        const pkg = readJson(join(dir, 'package.json'));
        if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') {
            dsh = pkg.version;
            break;
        }
    }
    return dsh ? { dsh, plugins } : { plugins };
}
export function versionChanges(from, to) {
    const out = [];
    const change = (name, a, b) => { if (a !== b)
        out.push({ name, ...(a ? { from: a } : {}), ...(b ? { to: b } : {}) }); };
    change('dsh', from.dsh, to.dsh);
    for (const name of [...new Set([...Object.keys(from.plugins), ...Object.keys(to.plugins)])].sort())
        change(name, from.plugins[name], to.plugins[name]);
    return out;
}
