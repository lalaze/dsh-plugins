import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_ROUTE, DEFAULT_PORT, LIVE_ROUTE, LOCAL_ROUTE } from './shared/protocol.js';
import { CommandError } from './server/executor.js';
import { dshHost } from './server/host.js';
import { DeviceSync, HttpError } from './server/service.js';
export const name = 'dsh-device-sync';
export const inject = ['connection'];
const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
const defaultStateDir = () => join(dshHome(), 'storages', name);
export const Config = Schema.object({
    stateDir: Schema.string().default(defaultStateDir()),
    port: Schema.natural().max(65535).default(DEFAULT_PORT).description('Port paired machines connect to, on this machine\'s Tailscale address.'),
    listenHost: Schema.string().description('Address to listen on instead of the Tailscale address.'),
    advertise: Schema.string().description('Address paired machines use to reach this one, such as a MagicDNS name with its port.'),
    anyNetwork: Schema.boolean().default(false).description('Accept paired machines from networks other than Tailscale.'),
});
const headers = { 'Cache-Control': 'no-store' };
const failure = (error) => {
    const status = error instanceof HttpError || error instanceof CommandError ? error.status : 500;
    if (status === 500)
        console.warn('[dsh-device-sync] Request failed', error);
    return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status, headers });
};
export async function apply(ctx, config = {}) {
    const log = (message) => ctx.get('logger')?.warn?.(message) ?? console.warn(`[dsh-device-sync] ${message}`);
    const sync = await DeviceSync.open({
        stateDir: config.stateDir ?? defaultStateDir(),
        host: dshHost(ctx),
        tags: () => ctx.get('workspaceTags'),
        dshHome: dshHome(),
        listen: { port: config.port ?? DEFAULT_PORT, host: config.listenHost || undefined, advertise: config.advertise || undefined, anyNetwork: config.anyNetwork === true },
        log,
    });
    await sync.start();
    ctx.effect(() => () => sync.close());
    // The host connection authenticates these routes; only the owner's browsers reach them.
    ctx.effect(() => ctx.connection.fetch.register({ path: LOCAL_ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: request => handleLocal(sync, request) }));
    ctx.effect(() => ctx.connection.fetch.register({ path: LIVE_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: request => handleLive(sync, request) }));
    ctx.effect(() => ctx.connection.fetch.register({ path: ATTACHMENT_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: request => handleAttachment(sync, request) }));
}
export async function handleLocal(sync, request) {
    try {
        if (request.method === 'GET')
            return Response.json(await sync.status(), { headers });
        // A page on another origin cannot set this header without a preflight the host refuses.
        if (request.headers.get('X-DSH-Device-Sync') !== '1')
            throw new HttpError('Use the device sync client to send requests', 403);
        let input;
        try {
            input = await request.json();
        }
        catch {
            throw new HttpError('Invalid request');
        }
        return Response.json(await sync.action(input) ?? { ok: true }, { headers });
    }
    catch (error) {
        return failure(error);
    }
}
export async function handleLive(sync, request) {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('device') ?? '', sessionId = url.searchParams.get('session') ?? '';
    const abort = new AbortController();
    request.signal.addEventListener('abort', () => abort.abort(), { once: true });
    const frames = sync.live(deviceId, sessionId, abort.signal)[Symbol.asyncIterator]();
    // Report a failure to open as an ordinary error response rather than an empty stream.
    let first;
    try {
        first = await frames.next();
    }
    catch (error) {
        return failure(error);
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        start(controller) { if (!first.done)
            controller.enqueue(encoder.encode(`${JSON.stringify(first.value)}\n`)); },
        async pull(controller) {
            try {
                const next = await frames.next();
                if (next.done)
                    controller.close();
                else
                    controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
            }
            catch (error) {
                if (!abort.signal.aborted)
                    controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })}\n`));
                controller.close();
            }
        },
        cancel() { abort.abort(); void frames.return?.(); },
    });
    return new Response(body, { headers: { ...headers, 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' } });
}
export async function handleAttachment(sync, request) {
    try {
        const url = new URL(request.url);
        const { data, mediaType, name } = await sync.attachment(url.searchParams.get('device') ?? '', url.searchParams.get('session') ?? '', url.searchParams.get('attachment') ?? '');
        // Images display inline; anything else downloads, so a synced file never runs as a page of this origin.
        const inline = /^image\/(png|jpeg|gif|webp)$/.test(mediaType);
        return new Response(new Uint8Array(data), { headers: { ...headers,
                'Content-Type': inline ? mediaType : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
                'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name ?? 'attachment')}` } });
    }
    catch (error) {
        return failure(error);
    }
}
