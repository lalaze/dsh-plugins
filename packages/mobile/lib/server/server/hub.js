/**
 * The phone hub: pairing, paired phones and what they may do, the encrypted connection of each phone that is online,
 * and notifications. Sessions come from the executor, which is the only part that reaches DSH's session API.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Channel, ChannelError, hubHandshake } from '../shared/channel.js';
import { DEFAULT_GRANTS, encodeOffer, OFFER_TTL_MS, pairingCode, } from '../shared/protocol.js';
import { CommandError, Executor } from './bridge/executor.js';
import { lastAssistantText } from './bridge/events.js';
import { PushGone, sendPush } from './push.js';
import { parseEndpoint, Relay } from './relay.js';
import { Store } from './store.js';
import { taskCommand, taskDetail, taskEntry, tasksFingerprint, usableTasks } from './tasks.js';
import { nodeX25519 } from './x25519.js';
export class HttpError extends Error {
    status;
    name = 'HttpError';
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
const HANDSHAKE_MS = 15_000;
/** A phone pings every 20 seconds; one silent for longer than this is gone. */
const IDLE_MS = 70_000;
const MAX_REQUESTS = 64;
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const FINISHED_GAP_MS = 30_000;
/** How often a connected phone's task list is checked: a task finishing changes nothing Remote Agents saves. */
const TASKS_CHECK_MS = 5000;
export class Hub {
    options;
    store;
    executor;
    relay;
    offer;
    requests = new Map();
    connections = new Set();
    lastFinished = new Map();
    changedTimer;
    stops = [];
    tasksTimer;
    tasksDue = 0;
    tasksSeen;
    constructor(options, store) {
        this.options = options;
        this.store = store;
        this.executor = new Executor({
            host: options.host,
            data: store.state.executor,
            save: () => store.save(),
            changed: () => this.notifyChanged(),
            approvalPeers: () => Object.values(store.state.phones).some(phone => phone.grants.control && (this.online(phone.id) || phone.push !== undefined)),
            watched: () => this.connections.size > 0,
            log: options.log,
        });
    }
    static async open(options) {
        const relay = normalizeRelay(options.defaults?.relay ?? '');
        let appUrl = '';
        try {
            appUrl = normalizeAppUrl(options.defaults?.appUrl ?? '');
        }
        catch { /* left for the settings page */ }
        return new Hub(options, await Store.open(options.stateDir, { name: options.defaults?.name, relay: relay.relay, tls: relay.tls, appUrl }));
    }
    get state() { return this.store.state; }
    log(message) { this.options.log?.(message); }
    async start() {
        this.executor.start();
        this.stops.push(this.options.host.bridgeApprovals(this.executor.approvalBridge));
        this.stops.push(this.executor.onEntry((entry, previous) => this.observe(entry, previous)));
        this.followTags();
        this.followTasks();
        this.restartRelay();
    }
    async close() {
        for (const stop of this.stops.splice(0))
            stop();
        this.relay?.stop();
        this.relay = undefined;
        for (const connection of [...this.connections])
            connection.close(4005, 'This machine is shutting down');
        clearTimeout(this.changedTimer);
        this.executor.close();
        await this.store.flush();
    }
    restartRelay() {
        this.relay?.stop();
        this.relay = undefined;
        const { relay, tls } = this.state.settings;
        if (!relay)
            return;
        this.relay = new Relay({
            endpoint: relay, tls, serverId: this.state.hub.id,
            accept: (socket, connectionId) => this.accept(socket, connectionId),
            log: message => this.log(message),
            WebSocket: this.options.WebSocket, fetch: this.options.fetch,
        });
        this.relay.start();
    }
    /** Tell phones when tags change. Workspace Tags may load after this plugin, so look for it until it is there. */
    followTags() {
        let timer;
        const attach = () => {
            const service = this.options.tags?.();
            if (service?.subscribe) {
                this.stops.push(service.subscribe(() => this.notifyChanged()));
                return;
            }
            if (this.options.tags)
                timer = setTimeout(attach, 10_000);
        };
        attach();
        this.stops.push(() => clearTimeout(timer));
    }
    /**
     * Tell phones when the task list changes. Remote Agents saves often while a reply streams, so the list is compared
     * before telling anyone; it is also checked while a phone is connected, as a finished turn saves nothing.
     */
    followTasks() {
        let subscribed;
        const schedule = (delay) => {
            // A change only brings the next check closer: changes saved while a reply streams must not keep postponing it.
            const due = Date.now() + delay;
            if (this.tasksTimer && this.tasksDue <= due)
                return;
            clearTimeout(this.tasksTimer);
            this.tasksDue = due;
            this.tasksTimer = setTimeout(() => { this.tasksTimer = undefined; void run(); }, delay);
            this.tasksTimer.unref?.();
        };
        const run = async () => {
            const service = usableTasks(this.options.tasks?.());
            // Remote Agents may load after this plugin, or not be installed.
            if (!service) {
                if (this.options.tasks)
                    schedule(10_000);
                return;
            }
            subscribed ??= service.subscribe?.(() => schedule(1000));
            if (this.connections.size === 0)
                this.tasksSeen = undefined;
            else {
                try {
                    const seen = tasksFingerprint((await service.list()).map(taskEntry));
                    if (this.tasksSeen !== undefined && seen !== this.tasksSeen)
                        for (const connection of this.connections)
                            connection.tasksChanged();
                    this.tasksSeen = seen;
                }
                catch { /* checked again next time */ }
            }
            schedule(TASKS_CHECK_MS);
        };
        schedule(0);
        this.stops.push(() => { clearTimeout(this.tasksTimer); subscribed?.(); });
    }
    tasks() {
        const service = usableTasks(this.options.tasks?.());
        if (!service)
            throw new CommandError('Remote Agents is not installed on this machine, or is too old for background tasks', 404);
        return service;
    }
    tags() {
        const state = this.options.tags?.()?.snapshot();
        return state ? { tags: state.tags.map(({ id, name, color }) => ({ id, name, color })), assignments: state.assignments } : { tags: [], assignments: {} };
    }
    online(phoneId) { return [...this.connections].some(connection => connection.phone?.id === phoneId); }
    /** A phone's socket from the relay, before the handshake. */
    accept(socket, connectionId) {
        const connection = new Connection(this, socket, connectionId);
        this.connections.add(connection);
        socket.addEventListener('close', () => { this.connections.delete(connection); connection.closed(); }, { once: true });
    }
    // ---------------------------------------------------------------------------------------------------------------
    // Pairing
    info(phoneKey) {
        const phone = this.phoneByKey(phoneKey);
        const pending = [...this.requests.values()].find(request => request.key === phoneKey);
        return {
            name: this.state.settings.name, hubId: this.state.hub.id, version: this.options.version,
            ...(phone ? { phone: { id: phone.id, name: phone.name, grants: phone.grants }, pushKey: this.state.vapid.publicKey } : {}),
            ...(!phone && pending ? { pairing: { code: pending.code } } : {}),
        };
    }
    phoneByKey(key) { return Object.values(this.state.phones).find(phone => phone.key === key); }
    async requestPairing(phoneKey, args) {
        if (this.phoneByKey(phoneKey))
            return this.info(phoneKey);
        const existing = [...this.requests.values()].find(request => request.key === phoneKey);
        if (existing)
            return this.info(phoneKey);
        const offer = this.offer;
        if (!offer || typeof args.token !== 'string' || args.token !== offer.token)
            throw new CommandError('This pairing code is not valid. Show a new one on the computer.', 403);
        if (Date.now() > offer.expires)
            throw new CommandError('This pairing code expired. Show a new one on the computer.', 403);
        // One phone per code.
        this.offer = undefined;
        const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 80) : 'Phone';
        const request = {
            requestId: randomUUID(), key: phoneKey, name, at: Date.now(),
            ...(typeof args.platform === 'string' ? { platform: args.platform.slice(0, 80) } : {}),
            code: await pairingCode(this.state.hub.publicKey, phoneKey, offer.token),
        };
        this.requests.set(request.requestId, request);
        setTimeout(() => this.requests.delete(request.requestId), OFFER_TTL_MS).unref?.();
        return this.info(phoneKey);
    }
    confirm(requestId, grants) {
        const request = this.requests.get(requestId);
        if (!request)
            throw new HttpError('This pairing request is no longer pending', 404);
        this.requests.delete(requestId);
        const phone = { id: randomUUID(), key: request.key, name: request.name, grants: normalizeGrants(grants), pairedAt: Date.now(), ...(request.platform ? { platform: request.platform } : {}) };
        this.state.phones[phone.id] = phone;
        this.store.save();
        for (const connection of this.connections)
            if (connection.phoneKey === request.key)
                connection.paired();
    }
    reject(requestId) {
        const request = this.requests.get(requestId);
        if (!request)
            return;
        this.requests.delete(requestId);
        for (const connection of this.connections)
            if (connection.phoneKey === request.key)
                connection.revoke('Pairing was declined on the computer');
    }
    // ---------------------------------------------------------------------------------------------------------------
    // Desktop settings page
    status() {
        const { settings } = this.state;
        const offer = this.offer && this.offer.expires > Date.now() ? this.offer : undefined;
        return {
            name: settings.name, hubId: this.state.hub.id,
            relay: { state: this.relay?.state ?? 'off', endpoint: settings.relay ? `${settings.tls ? 'wss' : 'ws'}://${settings.relay}` : '', ...(this.relay?.error ? { error: this.relay.error } : {}), ...(this.relay?.since ? { since: this.relay.since } : {}) },
            appUrl: settings.appUrl,
            ...(offer ? { offer: { url: offerUrl(settings.appUrl, offer), expires: offer.expires } } : {}),
            requests: [...this.requests.values()].map(({ requestId, name, platform, code, at }) => ({ requestId, name, code, at, ...(platform ? { platform } : {}) })),
            phones: Object.values(this.state.phones).sort((a, b) => a.pairedAt - b.pairedAt).map(phone => ({
                id: phone.id, name: phone.name, grants: phone.grants, pairedAt: phone.pairedAt, online: this.online(phone.id), push: phone.push !== undefined,
                ...(phone.platform ? { platform: phone.platform } : {}), ...(phone.lastSeen ? { lastSeen: phone.lastSeen } : {}),
            })),
        };
    }
    async action(input) {
        switch (input?.action) {
            case 'settings': {
                const settings = this.state.settings;
                if (input.name !== undefined)
                    settings.name = String(input.name).trim().slice(0, 80) || settings.name;
                if (input.appUrl !== undefined)
                    settings.appUrl = normalizeAppUrl(String(input.appUrl));
                if (input.relay !== undefined) {
                    const { relay, tls } = normalizeRelay(String(input.relay));
                    if (relay !== settings.relay || tls !== settings.tls) {
                        settings.relay = relay;
                        settings.tls = tls;
                        this.offer = undefined;
                        this.restartRelay();
                    }
                }
                this.store.save();
                return this.status();
            }
            case 'offer': {
                const { relay, tls, appUrl, name } = this.state.settings;
                if (!relay)
                    throw new HttpError('Enter the relay address first');
                if (!appUrl)
                    throw new HttpError('Enter the phone app address first');
                this.offer = { v: 1, server: this.state.hub.id, key: this.state.hub.publicKey, relay, tls, token: randomBytes(16).toString('base64url'), name, expires: Date.now() + OFFER_TTL_MS };
                return { url: offerUrl(appUrl, this.offer), expires: this.offer.expires };
            }
            case 'cancelOffer':
                this.offer = undefined;
                return { ok: true };
            case 'confirm':
                this.confirm(String(input.requestId), input.grants);
                return { ok: true };
            case 'reject':
                this.reject(String(input.requestId));
                return { ok: true };
            case 'grants': {
                const phone = this.phone(input.phoneId);
                phone.grants = normalizeGrants(input.grants);
                this.store.save();
                for (const connection of this.connections)
                    if (connection.phone?.id === phone.id)
                        connection.updated();
                return { ok: true };
            }
            case 'rename': {
                const phone = this.phone(input.phoneId);
                phone.name = String(input.name ?? '').trim().slice(0, 80) || phone.name;
                this.store.save();
                return { ok: true };
            }
            case 'unpair': {
                const phone = this.phone(input.phoneId);
                delete this.state.phones[phone.id];
                this.store.save();
                for (const connection of this.connections)
                    if (connection.phoneKey === phone.key)
                        connection.revoke('This phone was unpaired on the computer');
                return { ok: true };
            }
            case 'testPush': {
                const phone = this.phone(input.phoneId);
                if (!phone.push)
                    throw new HttpError('Notifications are off on this phone');
                await this.push(phone, { title: this.state.settings.name, body: 'Notifications work.', tag: 'test' });
                return { ok: true };
            }
            default: throw new HttpError('Unknown action');
        }
    }
    phone(id) {
        const phone = typeof id === 'string' ? this.state.phones[id] : undefined;
        if (!phone)
            throw new HttpError('Unknown phone', 404);
        return phone;
    }
    // ---------------------------------------------------------------------------------------------------------------
    // Changes and notifications
    notifyChanged() {
        if (this.changedTimer)
            return;
        this.changedTimer = setTimeout(() => {
            this.changedTimer = undefined;
            const cursor = this.executor.cursor();
            for (const connection of this.connections)
                connection.changed(cursor);
        }, 100);
    }
    setPush(phone, subscription, preferences) {
        if (subscription) {
            const endpoint = new URL(subscription.endpoint);
            if (endpoint.protocol !== 'https:' || typeof subscription.keys?.p256dh !== 'string' || typeof subscription.keys?.auth !== 'string')
                throw new CommandError('Invalid push subscription');
            phone.push = { subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } }, preferences: { finished: preferences?.finished !== false, attention: preferences?.attention !== false }, since: Date.now() };
        }
        else
            delete phone.push;
        this.store.save();
    }
    async push(phone, notification) {
        if (!phone.push)
            return;
        try {
            await sendPush(phone.push.subscription, { ...notification, hubId: this.state.hub.id }, this.state.vapid, {
                subject: 'mailto:dsh-mobile@users.noreply.github.com', urgency: 'high', fetch: this.options.fetch,
                topic: createHash('sha256').update(notification.tag).digest('base64url').slice(0, 32),
            });
        }
        catch (error) {
            if (error instanceof PushGone) {
                delete phone.push;
                this.store.save();
            }
            throw error;
        }
    }
    /** Notify phones when a session starts waiting for an answer, or finishes a turn. */
    observe(entry, previous) {
        if (!previous || entry.removed || entry.archived || entry.origin === 'subagent' || entry.parentSessionId)
            return;
        const phones = Object.values(this.state.phones).filter(phone => phone.push && phone.grants.view);
        if (phones.length === 0)
            return;
        const title = entry.title || 'Untitled session';
        const asked = entry.pending.filter(item => !previous.pending.some(old => old.id === item.id));
        if (entry.state === 'waiting' && asked.length > 0) {
            const item = asked[0];
            const body = item.kind === 'approval' ? `Asks to approve ${item.toolName}${item.reason ? `: ${item.reason}` : ''}` : item.questions[0]?.question ?? 'Asks a question';
            for (const phone of phones)
                if (phone.push.preferences.attention)
                    void this.push(phone, { title, body: clip(body), tag: `${entry.sessionId}:attention`, sessionId: entry.sessionId }).catch(error => this.log(`Notification failed: ${String(error)}`));
            return;
        }
        if (previous.state !== 'idle' && entry.state === 'idle') {
            if (Date.now() - (this.lastFinished.get(entry.sessionId) ?? 0) < FINISHED_GAP_MS)
                return;
            this.lastFinished.set(entry.sessionId, Date.now());
            void (async () => {
                const page = await this.executor.events(entry.sessionId, { limit: 8 }, AbortSignal.timeout(10_000)).catch(() => undefined);
                const body = clip(lastAssistantText(page?.events ?? []) ?? 'Finished');
                for (const phone of phones)
                    if (phone.push.preferences.finished)
                        await this.push(phone, { title, body, tag: `${entry.sessionId}:finished`, sessionId: entry.sessionId }).catch(error => this.log(`Notification failed: ${String(error)}`));
            })();
        }
    }
    /** Run one method for a connection. */
    async call(connection, method, args, stream, signal) {
        const key = connection.phoneKey;
        if (method === 'hub.info')
            return this.info(key);
        if (method === 'pair.request')
            return this.requestPairing(key, args ?? {});
        if (method === 'ping')
            return { ok: true };
        const phone = this.phoneByKey(key);
        if (!phone)
            throw new CommandError('This phone is not paired with this machine', 401);
        phone.lastSeen = Date.now();
        const input = (args ?? {});
        if (method === 'push.subscribe') {
            this.setPush(phone, input.subscription, input.preferences);
            return { ok: true };
        }
        if (method === 'push.unsubscribe') {
            this.setPush(phone, undefined);
            return { ok: true };
        }
        if (method === 'push.test') {
            await this.push(phone, { title: this.state.settings.name, body: 'Notifications work.', tag: 'test' });
            return { ok: true };
        }
        if (!phone.grants.view)
            throw new CommandError('This phone may not read this machine’s sessions', 403);
        switch (method) {
            case 'sessions.changes': return this.executor.changes(typeof input.since === 'string' ? input.since : undefined);
            case 'session.events': return this.executor.events(String(input.sessionId), {
                ...(typeof input.after === 'number' ? { after: input.after } : {}), ...(typeof input.before === 'number' ? { before: input.before } : {}),
                limit: typeof input.limit === 'number' ? input.limit : 100,
            }, signal);
            case 'session.live': {
                for await (const frame of this.executor.live(String(input.sessionId), signal))
                    stream(frame);
                return undefined;
            }
            case 'models': return this.options.host.modelChoices();
            case 'tags': return this.tags();
            case 'tasks.list': {
                const service = usableTasks(this.options.tasks?.());
                return service ? { available: true, tasks: (await service.list()).map(taskEntry) } : { available: false, tasks: [] };
            }
            case 'task.detail': {
                const taskId = String(input.taskId ?? '');
                if (!taskId)
                    throw new CommandError('Choose a task');
                return taskDetail(this.tasks(), { taskId, ...(typeof input.before === 'number' ? { before: input.before } : {}),
                    ...(typeof input.after === 'number' ? { after: input.after } : {}), ...(typeof input.epoch === 'string' ? { epoch: input.epoch } : {}) });
            }
            case 'task.command': {
                if (!phone.grants.control)
                    throw new CommandError('This phone may only read this machine’s sessions', 403);
                await taskCommand(this.tasks(), args);
                return { ok: true };
            }
            case 'attachment': {
                const sessionId = String(input.sessionId), attachmentId = String(input.attachmentId);
                const ref = await this.executor.sharesAttachment(sessionId, attachmentId, signal);
                if (!ref)
                    throw new CommandError('Unknown attachment', 404);
                if (ref.kind === 'image') {
                    const image = await this.options.host.readImage(ref, signal);
                    if (image.data.length > MAX_ATTACHMENT_BYTES)
                        throw new CommandError('This attachment is too large to open on a phone', 413);
                    return { mediaType: image.mediaType, data: Buffer.from(image.data).toString('base64'), ...(ref.name ? { name: ref.name } : {}) };
                }
                const chunks = [];
                let bytes = 0;
                for await (const chunk of this.options.host.readFile(ref, signal)) {
                    bytes += chunk.length;
                    if (bytes > MAX_ATTACHMENT_BYTES)
                        throw new CommandError('This attachment is too large to open on a phone', 413);
                    chunks.push(chunk);
                }
                return { mediaType: ref.mediaType ?? 'application/octet-stream', data: Buffer.concat(chunks).toString('base64'), ...(ref.name ? { name: ref.name } : {}) };
            }
            case 'command': {
                if (!phone.grants.control)
                    throw new CommandError('This phone may only read this machine’s sessions', 403);
                return this.executor.command(args);
            }
            default: throw new CommandError('Unknown method', 404);
        }
    }
}
/** One phone's connection through the relay: handshake first, then encrypted requests and streams. */
export class Connection {
    hub;
    socket;
    connectionId;
    phoneKey;
    channel;
    controllers = new Map();
    idle;
    ended = false;
    constructor(hub, socket, connectionId) {
        this.hub = hub;
        this.socket = socket;
        this.connectionId = connectionId;
        const handshakeTimer = setTimeout(() => { if (!this.channel)
            this.close(4001, 'Handshake timed out'); }, HANDSHAKE_MS);
        const pending = [];
        let handshaking = false;
        socket.onmessage = event => {
            if (this.channel) {
                void this.frame(event.data);
                return;
            }
            if (typeof event.data !== 'string') {
                if (handshaking)
                    pending.push(event.data);
                else
                    this.close(4002, 'Expected a hello');
                return;
            }
            if (handshaking)
                return;
            handshaking = true;
            void (async () => {
                try {
                    const { ready, keys, phoneKey } = await hubHandshake(nodeX25519, { secretKey: Buffer.from(hub.state.hub.secretKey, 'base64url'), publicKey: Buffer.from(hub.state.hub.publicKey, 'base64url') }, JSON.parse(event.data));
                    this.phoneKey = phoneKey;
                    this.channel = new Channel(keys, frame => { if (socket.readyState === socket.OPEN)
                        socket.send(frame); });
                    clearTimeout(handshakeTimer);
                    socket.send(JSON.stringify(ready));
                    this.touch();
                    for (const frame of pending.splice(0))
                        await this.frame(frame);
                }
                catch (error) {
                    this.close(4002, error instanceof ChannelError ? error.message : 'Handshake failed');
                }
            })();
        };
    }
    get phone() { return this.phoneKey ? this.hub.phoneByKey(this.phoneKey) : undefined; }
    touch() {
        clearTimeout(this.idle);
        this.idle = setTimeout(() => this.close(4003, 'The phone stopped answering'), IDLE_MS);
    }
    async frame(data) {
        if (typeof data === 'string') {
            this.close(4002, 'Plain text after the handshake');
            return;
        }
        let message;
        try {
            message = await this.channel.receive(new Uint8Array(data));
        }
        catch (error) {
            this.close(4002, error instanceof Error ? error.message : 'Invalid frame');
            return;
        }
        if (!message)
            return;
        this.touch();
        const phone = this.phone;
        if (phone)
            phone.lastSeen = Date.now();
        if (typeof message.id !== 'number' || typeof message.m !== 'string')
            return;
        if (message.m === 'cancel') {
            const id = Number(message.a?.id);
            this.controllers.get(id)?.abort();
            this.send({ id: message.id, r: { ok: true } });
            return;
        }
        if (this.controllers.size >= MAX_REQUESTS) {
            this.send({ id: message.id, e: { code: 'busy', message: 'Too many requests at once' } });
            return;
        }
        const controller = new AbortController();
        this.controllers.set(message.id, controller);
        const id = message.id, streaming = message.m === 'session.live';
        try {
            const result = await this.hub.call(this, message.m, message.a, frame => this.send({ id, f: frame }), controller.signal);
            this.send(streaming ? { id, end: true } : { id, r: result ?? null });
        }
        catch (error) {
            const failure = { code: error instanceof CommandError || error instanceof HttpError ? String(error.status) : 'error', message: error instanceof Error ? error.message : String(error) };
            this.send(streaming ? { id, end: true, e: failure } : { id, e: failure });
        }
        finally {
            this.controllers.delete(id);
        }
    }
    send(message) {
        if (!this.channel || this.ended)
            return;
        void this.channel.send(message).catch(() => this.close(4002, 'Could not send'));
    }
    changed(cursor) { if (this.phone?.grants.view)
        this.send({ n: 'changed', cursor }); }
    tasksChanged() { if (this.phone?.grants.view)
        this.send({ n: 'tasks' }); }
    paired() { if (this.phoneKey)
        this.send({ n: 'paired', info: this.hub.info(this.phoneKey) }); }
    /** Grants changed: streams the phone may no longer read end. */
    updated() {
        if (this.phoneKey)
            this.send({ n: 'paired', info: this.hub.info(this.phoneKey) });
        if (!this.phone?.grants.view)
            for (const controller of this.controllers.values())
                controller.abort();
    }
    revoke(message) {
        this.send({ n: 'unpaired', message });
        setTimeout(() => this.close(4004, message), 300);
    }
    close(code, reason) {
        try {
            this.socket.close(code, reason.slice(0, 120));
        }
        catch { /* already closed */ }
        this.closed();
    }
    closed() {
        if (this.ended)
            return;
        this.ended = true;
        clearTimeout(this.idle);
        for (const controller of this.controllers.values())
            controller.abort();
        this.controllers.clear();
    }
}
function normalizeGrants(value) {
    const grants = value;
    return { view: grants?.view ?? DEFAULT_GRANTS.view, control: grants?.control ?? DEFAULT_GRANTS.control };
}
export function normalizeRelay(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return { relay: '', tls: true };
    const tls = !/^(ws|http):\/\//i.test(trimmed);
    const { host, port } = parseEndpoint(trimmed, tls);
    return { relay: `${host.includes(':') ? `[${host}]` : host}:${port}`, tls };
}
export function normalizeAppUrl(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return '';
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        throw new HttpError('Enter the full address of the phone app, starting with https://');
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
        throw new HttpError('The phone app must be served over HTTPS');
    url.hash = '';
    return url.toString();
}
const offerUrl = (appUrl, offer) => `${appUrl}#pair=${encodeOffer(offer)}`;
const clip = (text, max = 180) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
