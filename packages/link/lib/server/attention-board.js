/**
 * Every machine's attention as this host's pages see it: this machine's own tracker, and one event stream per online
 * machine, read through its listener. Pages read the result from `/dsh-link/attention` on the host that serves
 * them, so a page opened through a mount never chains to another machine's board.
 */
import http from 'node:http';
import https from 'node:https';
import { agents } from './proxy.js';
import { SseParser, sseFrame } from './sse.js';
/** This machine's key on the board. */
export const SELF = 'self';
const FINISHED_KEPT = 20;
const empty = () => ({ connected: false, waiting: [], finished: [], running: [] });
export class AttentionBoard {
    machines = new Map();
    pages = new Set();
    feeds = new Map();
    changed;
    keepAlive = setInterval(() => { for (const page of this.pages)
        page.write(': keep-alive\n\n'); }, 25_000);
    unsubscribe;
    constructor(own) {
        this.keepAlive.unref();
        this.apply(SELF, { type: 'snapshot', snapshot: own.snapshot() });
        this.unsubscribe = own.subscribe(frame => this.apply(SELF, { type: 'frame', frame }));
    }
    state() { return Object.fromEntries(this.machines); }
    /** Follow exactly these machines' streams: `{ id: listener url }`. */
    follow(targets) {
        for (const [id, feed] of this.feeds) {
            if (targets[id] === feed.url)
                continue;
            feed.close();
            this.feeds.delete(id);
            if (!(id in targets)) {
                this.machines.delete(id);
                this.touch();
            }
        }
        for (const [id, url] of Object.entries(targets)) {
            if (!this.feeds.has(id))
                this.feeds.set(id, { url, close: this.subscribe(id, url) });
        }
    }
    /** The user looked at a machine: its finished turns are no longer news. */
    seen(machine) {
        const entry = this.machines.get(machine);
        if (entry && entry.finished.length > 0) {
            entry.finished = [];
            this.touch();
        }
    }
    /** A page's stream: the state now and after each change, and each frame that is news. */
    serve(res) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
        res.write(sseFrame('state', this.state()));
        this.pages.add(res);
        res.on('close', () => this.pages.delete(res));
    }
    close() {
        this.unsubscribe();
        clearInterval(this.keepAlive);
        clearTimeout(this.changed);
        for (const feed of this.feeds.values())
            feed.close();
        this.feeds.clear();
        for (const page of this.pages)
            page.end();
        this.pages.clear();
    }
    apply(machine, update) {
        let entry = this.machines.get(machine);
        if (!entry) {
            entry = empty();
            this.machines.set(machine, entry);
        }
        if (update.type === 'down') {
            if (!entry.connected)
                return;
            entry.connected = false;
            entry.waiting = [];
            entry.running = [];
        }
        else if (update.type === 'snapshot') {
            entry.connected = true;
            entry.waiting = update.snapshot.waiting;
            entry.running = [...new Set(update.snapshot.running.map(frame => frame.sessionId))];
        }
        else {
            const { frame } = update;
            switch (frame.kind) {
                case 'approval':
                case 'question':
                    entry.waiting = [...entry.waiting.filter(item => item.key !== frame.key), frame];
                    this.notice(machine, frame);
                    break;
                case 'resolved':
                    entry.waiting = entry.waiting.filter(item => item.key !== frame.key || item.sessionId !== frame.sessionId);
                    this.notice(machine, frame);
                    break;
                case 'done':
                case 'failed':
                    entry.finished = [frame, ...entry.finished.filter(item => item.sessionId !== frame.sessionId)].slice(0, FINISHED_KEPT);
                    this.notice(machine, frame);
                    break;
                case 'running':
                    if (!entry.running.includes(frame.sessionId))
                        entry.running = [...entry.running, frame.sessionId];
                    break;
                case 'idle':
                    entry.running = entry.running.filter(id => id !== frame.sessionId);
                    break;
            }
        }
        this.touch();
    }
    notice(machine, frame) {
        const body = sseFrame('notice', { machine, frame });
        for (const page of this.pages)
            page.write(body);
    }
    touch() {
        if (this.changed)
            return;
        this.changed = setTimeout(() => {
            this.changed = undefined;
            const body = sseFrame('state', this.state());
            for (const page of this.pages)
                page.write(body);
        }, 80);
    }
    /** One machine's stream, reconnecting with backoff until closed. */
    subscribe(machine, base) {
        let closed = false;
        let delay = 1_000;
        let timer;
        let current;
        const connect = () => {
            if (closed)
                return;
            const url = new URL('/dsh-link/events', base);
            const out = (url.protocol === 'https:' ? https : http).request(url, { headers: { accept: 'text/event-stream' }, agent: url.protocol === 'https:' ? agents.https : agents.http });
            current = out;
            // A stream that went quiet past two keep-alives is dead (a sleeping machine never closes it).
            let silence;
            const quiet = () => { clearTimeout(silence); silence = setTimeout(() => out.destroy(new Error('silent')), 70_000); };
            const retry = () => {
                clearTimeout(silence);
                if (current !== out)
                    return;
                current = undefined;
                this.apply(machine, { type: 'down' });
                if (closed)
                    return;
                timer = setTimeout(connect, delay);
                delay = Math.min(delay * 2, 30_000);
            };
            out.on('response', res => {
                if (res.statusCode !== 200) {
                    res.resume();
                    retry();
                    return;
                }
                delay = 1_000;
                quiet();
                res.setEncoding('utf8');
                const parser = new SseParser(({ event, data }) => {
                    try {
                        if (event === 'snapshot')
                            this.apply(machine, { type: 'snapshot', snapshot: JSON.parse(data) });
                        else if (event === 'frame')
                            this.apply(machine, { type: 'frame', frame: JSON.parse(data) });
                    }
                    catch { /* a malformed frame is skipped */ }
                });
                res.on('data', (chunk) => { quiet(); parser.push(chunk); });
                res.on('end', retry);
                res.on('error', retry);
            });
            out.on('error', retry);
            out.end();
        };
        connect();
        return () => { closed = true; clearTimeout(timer); current?.destroy(); current = undefined; };
    }
}
/** This machine's own stream for other machines: a snapshot, then every frame, with keep-alives. */
export function serveEvents(tracker, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(sseFrame('snapshot', tracker.snapshot()));
    const unsubscribe = tracker.subscribe(frame => res.write(sseFrame('frame', frame)));
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    res.on('close', () => { unsubscribe(); clearInterval(keepAlive); });
}
