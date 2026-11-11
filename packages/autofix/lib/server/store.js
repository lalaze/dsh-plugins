/** Everything the plugin keeps, as JSON files in one folder. One writer: a second DSH manages through requests, not files. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACTIVE, defaultSettings, say, settingsFrom } from './domain.js';
export class LocalFiles {
    directory;
    constructor(directory) {
        this.directory = directory;
    }
    async read(name) {
        try {
            return await readFile(join(this.directory, name), 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return undefined;
            throw error;
        }
    }
    async write(name, text) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const target = join(this.directory, name), temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, target);
    }
}
const MAX_EVENTS = 200;
export class Store {
    files;
    settings = defaultSettings();
    pool = {};
    tasks = {};
    /** Where bugs like earlier ones went, learned from accepted tasks; keys as in pool.ts. */
    memory = {};
    /** Per source: when it was last fetched, and what went wrong if that failed. */
    fetch = {};
    queue = Promise.resolve();
    constructor(files) {
        this.files = files;
    }
    async load(name, fallback) {
        const text = await this.files.read(name);
        if (text === undefined)
            return fallback;
        try {
            return JSON.parse(text);
        }
        catch {
            throw new Error(`${name} in Autofix's folder is not valid JSON; fix or remove it`);
        }
    }
    async open(now = Date.now()) {
        const settings = await this.load('settings.json', undefined);
        this.settings = settings === undefined ? defaultSettings() : settingsFrom(settings);
        this.pool = await this.load('pool.json', {});
        this.memory = await this.load('memory.json', {});
        const saved = await this.load('tasks.json', {});
        this.tasks = saved.tasks ?? {};
        this.fetch = saved.fetch ?? {};
        // A flow does not survive DSH stopping; what was under way is said to have stopped, and can be continued.
        let interrupted = false;
        for (const task of Object.values(this.tasks)) {
            if (!ACTIVE.includes(task.status))
                continue;
            const accepting = task.status === 'accepting';
            task.status = accepting ? 'review' : 'stopped';
            task.error = say(accepting ? 'DSH stopped while this was being accepted. Check the repository before accepting again.' : 'DSH stopped while this task was running.');
            task.updatedAt = now;
            task.events.push({ at: now, said: task.error });
            interrupted = true;
        }
        if (interrupted)
            await this.saveTasks();
    }
    /** Writes run one at a time, so an earlier one cannot land after a later one. */
    write(name, value) {
        const next = this.queue.then(() => this.files.write(name, `${JSON.stringify(value(), null, 2)}\n`));
        this.queue = next.catch(() => undefined);
        return next;
    }
    async saveSettings(settings) { this.settings = settings; await this.write('settings.json', () => this.settings); }
    savePool() { return this.write('pool.json', () => this.pool); }
    saveMemory() { return this.write('memory.json', () => this.memory); }
    saveTasks() {
        for (const task of Object.values(this.tasks))
            if (task.events.length > MAX_EVENTS)
                task.events = task.events.slice(-MAX_EVENTS);
        return this.write('tasks.json', () => ({ tasks: this.tasks, fetch: this.fetch }));
    }
}
