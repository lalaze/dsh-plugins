/** Safe restart of this DSH, asked for from any machine's page: `GET`/`POST /dsh-machines/restart`. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, sendJson } from '../proxy.js';
import { versionChanges } from './target.js';
import { isRestartMode, readRecord, updateRecord, writeRecord } from './state.js';
const IDLE_POLL_MS = 3_000;
/** A record this old is history, not a restart in progress. */
const STALE_MS = 30 * 60 * 1000;
export class RestartService {
    options;
    stateFile;
    idleTimer;
    constructor(options) {
        this.options = options;
        this.stateFile = join(options.dir, 'state.json');
    }
    status() {
        const target = this.options.target();
        const record = readRecord(this.stateFile);
        const recent = record && Date.now() - record.requestedAt < STALE_MS ? record : undefined;
        return {
            supported: target.ok, ...(target.ok ? { kind: target.launch.kind } : { reason: target.reason }),
            pid: process.pid, busy: this.options.busy(), ...(recent ? { record: recent } : {}),
        };
    }
    /** Start a restart now, or once nothing runs. */
    request(mode) {
        const target = this.options.target();
        if (!target.ok)
            throw new Error(target.reason);
        const current = readRecord(this.stateFile);
        if (current && current.fromPid === process.pid && ['waiting', 'armed', 'quitting', 'launching'].includes(current.phase))
            return current;
        const record = {
            id: randomUUID(), mode, phase: 'waiting', requestedAt: Date.now(), fromPid: process.pid,
            from: this.options.versions(), log: join(this.options.dir, 'restart.log'),
        };
        writeRecord(this.stateFile, record);
        if (mode === 'now')
            return this.launch(record);
        this.waitIdle(record.id);
        return record;
    }
    cancel() {
        const record = readRecord(this.stateFile);
        if (!record || record.fromPid !== process.pid || !['waiting', 'armed'].includes(record.phase))
            return record;
        clearTimeout(this.idleTimer);
        return updateRecord(this.stateFile, record.id, value => ({ ...value, phase: 'cancelled' }));
    }
    /**
     * Called once this instance serves pages again: a restart that brought it up is marked back, with what changed.
     * @returns the record when this start was one.
     */
    markBack() {
        const record = readRecord(this.stateFile);
        if (!record || record.fromPid === process.pid || !['armed', 'quitting', 'launching'].includes(record.phase))
            return undefined;
        if (Date.now() - record.requestedAt > STALE_MS)
            return undefined;
        const to = this.options.versions();
        return updateRecord(this.stateFile, record.id, value => ({ ...value, phase: 'back', backAt: Date.now(), toPid: process.pid, changes: versionChanges(value.from, to) }));
    }
    dispose() { clearTimeout(this.idleTimer); }
    async serve(req, res) {
        if (req.method === 'GET') {
            sendJson(res, 200, this.status());
            return;
        }
        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'GET or POST' });
            return;
        }
        let body;
        try {
            body = await readJson(req, 1024);
        }
        catch {
            sendJson(res, 400, { error: 'expected JSON' });
            return;
        }
        const action = body?.action;
        try {
            if (action === 'cancel') {
                sendJson(res, 200, { record: this.cancel() ?? null });
                return;
            }
            if (!isRestartMode(action)) {
                sendJson(res, 400, { error: 'action must be now, idle or cancel' });
                return;
            }
            sendJson(res, 200, { record: this.request(action) });
        }
        catch (error) {
            sendJson(res, 409, { error: error.message });
        }
    }
    waitIdle(id) {
        clearTimeout(this.idleTimer);
        const check = () => {
            const record = readRecord(this.stateFile);
            if (record?.id !== id || record.phase !== 'waiting')
                return;
            const busy = this.options.busy();
            if (busy.sessions.length === 0 && busy.jobs.length === 0) {
                this.launch(record);
                return;
            }
            this.idleTimer = setTimeout(check, IDLE_POLL_MS);
        };
        this.idleTimer = setTimeout(check, 0);
    }
    /** Hand the restart to the detached helper; DSH keeps running when the helper cannot start. */
    launch(record) {
        const target = this.options.target();
        if (!target.ok)
            return updateRecord(this.stateFile, record.id, value => ({ ...value, phase: 'failed', error: target.reason })) ?? record;
        const busy = this.options.busy();
        const job = {
            id: record.id, stateFile: this.stateFile, launch: target.launch, startDelayMs: 1_500,
            // With work running the desktop app asks for confirmation nobody can give remotely: do not wait long for it.
            quitTimeoutMs: target.launch.kind === 'desktop' && (busy.sessions.length > 0 || busy.jobs.length > 0) ? 15_000 : 90_000,
            readyTimeoutMs: 120_000, attempts: 3, output: join(this.options.dir, 'dsh.out'),
        };
        try {
            mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
            const jobFile = join(this.options.dir, 'job.json');
            writeFileSync(jobFile, JSON.stringify(job, null, 2), { mode: 0o600 });
            const out = openSync(record.log, 'a');
            const helper = spawn(process.execPath, [this.options.helper, jobFile], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
            helper.unref();
            return updateRecord(this.stateFile, record.id, value => ({ ...value, phase: 'armed', ...(helper.pid ? { helperPid: helper.pid } : {}) })) ?? record;
        }
        catch (error) {
            this.options.warn(`dsh-machines: the restart helper did not start: ${error.message}`);
            return updateRecord(this.stateFile, record.id, value => ({ ...value, phase: 'failed', error: `the restart helper did not start: ${error.message}` })) ?? record;
        }
    }
}
