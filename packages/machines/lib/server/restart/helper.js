/**
 * The detached restart helper: `node helper.js <job.json>`. It outlives DSH: asks it to quit, waits until it is gone
 * (killing it only after a timeout, and saying so), starts it again and waits for the next plugin instance to mark the
 * record `back`, launching up to `attempts` times. Node built-ins only: it runs outside DSH.
 */
import { execFile, spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { readRecord, updateRecord } from './state.js';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const log = (text) => process.stdout.write(`${new Date().toISOString()} ${text}\n`);
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
async function gone(pids, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (pids.every(pid => !alive(pid)))
            return true;
        await sleep(250);
    }
    return pids.every(pid => !alive(pid));
}
function run(command, args) {
    return new Promise((resolve, reject) => execFile(command, args, { timeout: 60_000 }, (error, _out, stderr) => error ? reject(new Error(`${command} ${args.join(' ')}: ${(stderr || error.message).trim()}`)) : resolve()));
}
async function main() {
    const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const set = (change) => updateRecord(job.stateFile, job.id, record => ({ ...record, ...change }));
    const fail = (error) => { log(`failed: ${error}`); set({ phase: 'failed', error }); };
    set({ helperPid: process.pid, phase: 'armed' });
    log(`restart ${job.id}: ${job.launch.kind}`);
    await sleep(job.startDelayMs);
    if (readRecord(job.stateFile)?.phase === 'cancelled') {
        log('cancelled before quitting');
        return;
    }
    const { launch } = job;
    let child;
    const start = async (attempt) => {
        set({ phase: 'launching', attempts: attempt });
        if (launch.kind === 'launchd') {
            // Stops the running job (graceful SIGTERM first, as launchd does) and starts it again.
            await run('/bin/launchctl', ['kickstart', '-k', launch.target]);
        }
        else if (launch.kind === 'desktop') {
            await run('/usr/bin/open', [launch.bundle]);
        }
        else {
            const out = openSync(job.output, 'a');
            const started = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, detached: true, stdio: ['ignore', out, out] });
            started.unref();
            child = started.pid;
        }
        log(`launch ${attempt} started${child ? ` (pid ${child})` : ''}`);
    };
    set({ phase: 'quitting' });
    if (launch.kind === 'desktop' || launch.kind === 'process') {
        const quitPid = launch.kind === 'desktop' ? launch.quitPid : launch.pid;
        const pids = launch.kind === 'desktop' ? [launch.quitPid, launch.hostPid] : [launch.pid];
        log(`asking pid ${quitPid} to quit`);
        try {
            process.kill(quitPid, 'SIGTERM');
        }
        catch (error) {
            log(`SIGTERM: ${error.message}`);
        }
        if (!(await gone(pids, job.quitTimeoutMs))) {
            const left = pids.filter(alive);
            log(`still running after ${job.quitTimeoutMs / 1000} s, killing ${left.join(', ')}`);
            set({ forced: left });
            for (const pid of left) {
                try {
                    process.kill(pid, 'SIGKILL');
                }
                catch { /* gone meanwhile */ }
            }
            if (!(await gone(pids, 10_000))) {
                fail(`DSH (pid ${left.join(', ')}) did not exit`);
                return;
            }
        }
        log('DSH has quit');
    }
    for (let attempt = 1; attempt <= job.attempts; attempt++) {
        try {
            await start(attempt);
        }
        catch (error) {
            log(error.message);
        }
        const until = Date.now() + job.readyTimeoutMs;
        while (Date.now() < until) {
            const record = readRecord(job.stateFile);
            if (record?.id !== job.id) {
                log('a newer restart took over');
                return;
            }
            if (record.phase === 'back') {
                log(`back: pid ${record.toPid}`);
                return;
            }
            await sleep(1_000);
        }
        log(`launch ${attempt} did not report back within ${job.readyTimeoutMs / 1000} s`);
        if (child !== undefined && alive(child)) {
            try {
                process.kill(child, 'SIGTERM');
            }
            catch { /* gone */ }
            if (!(await gone([child], 20_000))) {
                try {
                    process.kill(child, 'SIGKILL');
                }
                catch { /* gone */ }
            }
            child = undefined;
        }
    }
    fail(`DSH did not come back after ${job.attempts} launches`);
}
main().catch(error => { log(`helper crashed: ${error.stack ?? String(error)}`); process.exitCode = 1; });
