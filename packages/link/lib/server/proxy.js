/** HTTP and WebSocket forwarding: header filtering, `Location` rewriting, HTML rewriting, bodies streamed. */
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
/** Set on every request a mount forwards; a mount refuses one that already carries it, so hops never chain. */
export const HOP_HEADER = 'x-dsh-link-hop';
export const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade']);
/**
 * What never crosses a hop: the browser's own credentials and markers (the next hop authenticates its own way and
 * runs its own fence), forwarding claims the browser could forge, and conditional headers of documents we rewrite.
 */
const DROP_REQUEST = new Set([...HOP_BY_HOP, 'host', 'origin', 'referer', 'cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', HOP_HEADER]);
/**
 * Connections made by this plugin. Own agents: the global ones may be sent through an env proxy. `local` takes the
 * self-signed certificate of a development server on this machine's own network (forward/target.ts).
 */
export const agents = {
    http: new http.Agent({ keepAlive: true, keepAliveMsecs: 4_000, maxSockets: 64 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 64 }),
    local: new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false }),
};
const agentFor = (url, insecure = false) => url.protocol === 'https:' ? (insecure ? agents.local : agents.https) : agents.http;
const moduleFor = (url) => url.protocol === 'https:' ? https : http;
export function connectionTokens(headers) {
    const value = headers.connection;
    return new Set((Array.isArray(value) ? value.join(',') : value ?? '').split(',').map(token => token.trim().toLowerCase()).filter(Boolean));
}
/** Headers to send upstream: the browser's own minus what {@link DROP_REQUEST} names, plus `extra`. */
export function requestHeaders(headers, extra = {}) {
    const listed = connectionTokens(headers);
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || DROP_REQUEST.has(name) || listed.has(name))
            continue;
        out[name] = value;
    }
    return { ...out, ...extra };
}
/**
 * A `Location` rewrite for a hop that serves `upstream` under `prefix`: absolute paths and absolute URLs to the
 * upstream origin get the prefix, anything else (relative, another site) is left alone.
 */
export function locationUnder(upstream, prefix) {
    return location => {
        if (location.startsWith('/') && !location.startsWith('//'))
            return prefix + location;
        try {
            const url = new URL(location);
            if (url.origin === upstream.origin)
                return prefix + url.pathname + url.search + url.hash;
        }
        catch { /* relative */ }
        return location;
    };
}
/** Response headers to pass back: no hop-by-hop headers, and no cookie of the next hop unless `cookies`. */
export function responseHeaders(headers, location, cookies = false) {
    const listed = connectionTokens(headers);
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name) || (name === 'set-cookie' && !cookies))
            continue;
        out[name] = name === 'location' && location && typeof value === 'string' ? location(value) : value;
    }
    return out;
}
/** Longest body {@link Forward.text} rewrites. */
export const TEXT_LIMIT = 8 * 1024 * 1024;
/** Text a navigation shows: Chromium replaces an error status without a body by its own error page. */
export function sendText(res, status, text) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
    res.end(text);
}
export function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}
export function decoded(body, encoding) {
    switch ((encoding ?? '').trim().toLowerCase()) {
        case '':
        case 'identity': return body;
        case 'gzip':
        case 'x-gzip': return zlib.gunzipSync(body);
        case 'br': return zlib.brotliDecompressSync(body);
        case 'deflate': return zlib.inflateSync(body);
        default: throw new Error(`unsupported content-encoding ${encoding}`);
    }
}
/** Arms a connect deadline on a client request; cleared once the socket connects. */
function connectDeadline(out, ms) {
    out.on('socket', socket => {
        if (!socket.connecting)
            return;
        const timer = setTimeout(() => out.destroy(Object.assign(new Error(`no answer within ${ms / 1000} s`), { code: 'ETIMEDOUT' })), ms);
        socket.once('connect', () => clearTimeout(timer));
        socket.once('secureConnect', () => clearTimeout(timer));
        socket.once('close', () => clearTimeout(timer));
    });
}
/** Forward one HTTP request; the response (event streams included) is copied as it arrives. */
export function forwardHttp(req, res, forward) {
    const { target } = forward;
    const rewrite = forward.html !== undefined && req.method === 'GET';
    const headers = { ...forward.headers };
    if (rewrite && /text\/html/i.test(String(req.headers.accept ?? ''))) {
        // A document we rewrite: ask for it whole and unencoded, and never take a 304 for an older rewrite.
        delete headers['if-none-match'];
        delete headers['if-modified-since'];
    }
    const out = moduleFor(target).request(target, { method: req.method, headers, agent: agentFor(target, forward.insecure) });
    connectDeadline(out, forward.connectTimeoutMs ?? 6_000);
    let answered = false;
    const headersOut = (incoming) => {
        const passed = responseHeaders(incoming, forward.location, forward.cookies);
        return forward.headersOut ? forward.headersOut(passed) : passed;
    };
    out.on('response', up => {
        answered = true;
        const status = up.statusCode ?? 502;
        forward.onStatus?.(status);
        up.on('error', () => res.destroy());
        const type = String(up.headers['content-type'] ?? '');
        if (rewrite && status === 200 && /text\/html/i.test(type)) {
            rewriteHtml(up, res, status, headersOut, forward.html);
            return;
        }
        const text = req.method === 'HEAD' ? undefined : forward.text?.(status, up.headers);
        if (text) {
            rewriteText(up, res, status, headersOut, text);
            return;
        }
        const stream = req.method === 'HEAD' ? undefined : forward.stream?.(status, up.headers);
        res.writeHead(status, up.statusMessage, headersOut(up.headers));
        if (stream) {
            stream.on('error', () => res.destroy());
            up.pipe(stream).pipe(res);
        }
        else
            up.pipe(res);
    });
    out.on('error', error => {
        if (!answered)
            forward.onUnreachable?.(error);
        if (res.headersSent) {
            res.destroy();
            return;
        }
        const answer = forward.unreachable ? forward.unreachable(error) : `Cannot reach ${target.host}: ${describe(error)}`;
        if (typeof answer === 'string')
            sendText(res, 502, answer);
        else {
            res.writeHead(307, { location: answer.location, 'cache-control': 'no-store', 'content-length': 0 });
            res.end();
        }
    });
    // An event stream lasts until the browser leaves; then the upstream request goes too.
    res.on('close', () => { if (!res.writableFinished)
        out.destroy(); });
    req.pipe(out);
}
/** A document this plugin changes: whole, decoded, never cached (the next load may change it differently). */
function rewriteHtml(up, res, status, headersOut, html) {
    const chunks = [];
    up.on('data', (chunk) => chunks.push(chunk));
    up.on('end', () => {
        let page;
        try {
            page = html(decoded(Buffer.concat(chunks), up.headers['content-encoding']).toString('utf8'));
        }
        catch (error) {
            sendText(res, 502, `Could not read the page: ${error.message}`);
            return;
        }
        const outHeaders = headersOut(up.headers);
        for (const name of ['content-encoding', 'content-length', 'etag', 'last-modified'])
            delete outHeaders[name];
        const body = Buffer.from(page, 'utf8');
        res.writeHead(status, up.statusMessage, { ...outHeaders, 'content-length': body.length, 'cache-control': 'no-store' });
        res.end(body);
    });
}
/**
 * A text body rewritten the same way every time, so its validators still hold. Passes as it came when it is longer
 * than {@link TEXT_LIMIT}, not UTF-8, in an unknown encoding, or left unchanged.
 */
function rewriteText(up, res, status, headersOut, text) {
    const declared = Number(up.headers['content-length'] ?? NaN);
    const passAll = (head) => {
        res.writeHead(status, up.statusMessage, headersOut(up.headers));
        for (const chunk of head)
            res.write(chunk);
        up.pipe(res);
    };
    if (declared > TEXT_LIMIT) {
        passAll([]);
        return;
    }
    const chunks = [];
    let size = 0;
    let passing = false;
    const onData = (chunk) => {
        size += chunk.length;
        chunks.push(chunk);
        if (size <= TEXT_LIMIT)
            return;
        passing = true;
        up.off('data', onData);
        up.off('end', onEnd);
        passAll(chunks.splice(0));
    };
    const onEnd = () => {
        if (passing)
            return;
        const raw = Buffer.concat(chunks);
        let next;
        try {
            const plain = decoded(raw, up.headers['content-encoding']);
            const body = plain.toString('utf8');
            // Not UTF-8 (a legacy charset): rewriting would garble it.
            if (Buffer.from(body, 'utf8').equals(plain)) {
                const changed = text(body);
                if (changed !== body)
                    next = Buffer.from(changed, 'utf8');
            }
        }
        catch { /* an encoding this plugin cannot undo: pass it */ }
        const outHeaders = headersOut(up.headers);
        if (next) {
            delete outHeaders['content-encoding'];
            outHeaders['content-length'] = next.length;
            res.writeHead(status, up.statusMessage, outHeaders);
            res.end(next);
        }
        else {
            res.writeHead(status, up.statusMessage, outHeaders);
            res.end(raw);
        }
    };
    up.on('data', onData);
    up.on('end', onEnd);
}
/** A short reason for an upstream failure, no stack, no URL. */
export function describe(error) {
    const code = error.code;
    switch (code) {
        case 'ECONNREFUSED': return 'nothing listens there (is DSH running with this plugin?)';
        case 'ETIMEDOUT':
        case 'ESOCKETTIMEDOUT': return 'no answer (asleep or offline?)';
        case 'EHOSTUNREACH':
        case 'ENETUNREACH':
        case 'EHOSTDOWN': return 'the machine is unreachable';
        case 'ECONNRESET': return 'the connection was reset';
        default: return error instanceof Error ? error.message : String(error);
    }
}
function writeHead(socket, status, message, rawHeaders, cookies = false) {
    let head = `HTTP/1.1 ${status} ${message}\r\n`;
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
        if (rawHeaders[i].toLowerCase() === 'set-cookie' && !cookies)
            continue;
        head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
    }
    socket.write(`${head}\r\n`);
}
/** Forward an HTTP upgrade (WebSocket): the handshake with filtered headers, then bytes both ways. */
export function forwardUpgrade(req, socket, head, forward) {
    const { target } = forward;
    const headers = { ...forward.headers, connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' };
    // One connection per WebSocket, never a pooled one.
    const out = moduleFor(target).request(target, { method: 'GET', headers, agent: false, ...(forward.insecure ? { rejectUnauthorized: false } : {}) });
    connectDeadline(out, forward.connectTimeoutMs ?? 6_000);
    const fail = (status, text) => {
        if (socket.destroyed)
            return;
        socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
    };
    socket.on('error', () => out.destroy());
    out.on('upgrade', (up, upSocket, upHead) => {
        forward.onStatus?.(up.statusCode ?? 101);
        writeHead(socket, up.statusCode ?? 101, up.statusMessage ?? 'Switching Protocols', up.rawHeaders, forward.cookies);
        if (upHead.length > 0)
            socket.write(upHead);
        if (head.length > 0)
            upSocket.write(head);
        upSocket.on('error', () => socket.destroy());
        socket.on('error', () => upSocket.destroy());
        upSocket.on('close', () => socket.destroy());
        socket.on('close', () => upSocket.destroy());
        upSocket.pipe(socket);
        socket.pipe(upSocket);
    });
    out.on('response', up => {
        // The upstream refused the upgrade: pass its answer on and close.
        forward.onStatus?.(up.statusCode ?? 502);
        const chunks = [];
        up.on('data', (chunk) => chunks.push(chunk));
        up.on('end', () => {
            if (socket.destroyed)
                return;
            const body = Buffer.concat(chunks);
            const raw = up.rawHeaders.filter((_, i, all) => i % 2 === 0 ? !/^(content-length|transfer-encoding|connection)$/i.test(all[i]) : !/^(content-length|transfer-encoding|connection)$/i.test(all[i - 1]));
            writeHead(socket, up.statusCode ?? 502, up.statusMessage ?? '', [...raw, 'content-length', String(body.length), 'connection', 'close'], forward.cookies);
            socket.end(body);
        });
    });
    out.on('error', error => {
        forward.onUnreachable?.(error);
        const answer = forward.unreachable?.(error);
        fail(502, typeof answer === 'string' ? answer : `Cannot reach ${target.host}: ${describe(error)}`);
    });
    out.end();
}
/** One small request through the plugin's own agents, e.g. a hello probe or the loopback login. */
export function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const out = moduleFor(url).request(url, { method: options.method ?? 'GET', headers: options.body === undefined ? options.headers : { 'content-type': 'application/json', ...options.headers, 'content-length': Buffer.byteLength(options.body) }, agent: agentFor(url) });
        const timer = setTimeout(() => out.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), options.timeoutMs ?? 6_000);
        out.on('response', up => {
            const chunks = [];
            let size = 0;
            up.on('data', (chunk) => {
                size += chunk.length;
                if (size > (options.maxBytes ?? 1024 * 1024)) {
                    out.destroy(new Error('answer too large'));
                    return;
                }
                chunks.push(chunk);
            });
            up.on('end', () => { clearTimeout(timer); resolve({ status: up.statusCode ?? 0, headers: up.headers, body: Buffer.concat(chunks) }); });
            up.on('error', error => { clearTimeout(timer); reject(error); });
        });
        out.on('error', error => { clearTimeout(timer); reject(error); });
        out.end(options.body);
    });
}
/** Reads a small JSON request body. */
export async function readJson(req, limit = 16 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit)
            throw new Error('request body too large');
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text ? JSON.parse(text) : {};
}
/** The peer address of a socket without the IPv4-mapped prefix. */
export function remoteIp(address) {
    return (address ?? '').replace(/^::ffff:/, '');
}
/** Host name of a `Host` header, without port or IPv6 brackets. */
export function hostnameOf(host) {
    if (!host)
        return '';
    if (host.startsWith('['))
        return host.slice(1, host.indexOf(']'));
    const colon = host.lastIndexOf(':');
    return (colon > 0 && host.indexOf(':') === colon ? host.slice(0, colon) : host).toLowerCase();
}
