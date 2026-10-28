import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { BridgeError, pageState, record, string, type Command, type PageState, type SessionKey } from './protocol.js';
import { launchWindow, type LaunchWindow, type WindowProcess } from './launcher.js';

const secret = () => randomBytes(32).toString('hex');
const LIMIT = 4 * 1024 * 1024;
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; revision: number }
interface Session {
  host: string; window: string; page: PageState; queue: Command[]; pending: Map<string, Pending>;
  hostSeen: number; windowSeen: number; process?: WindowProcess;
}
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH · Page debugger</title><style>
html,body{margin:0;height:100%;overflow:hidden;font:13px system-ui;background:#fff;color:#202124}body{display:flex;flex-direction:column}body[data-ds-dark-theme]{background:#202124;color:#e8eaed}
#target{padding:9px 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none;border-bottom:1px solid #8884}#panel{flex:1;min-height:0;display:flex;flex-direction:column}#message{padding:24px}#message[hidden]{display:none}
</style></head><body><header id="target">DSH · Page debugger</header><div id="panel"></div><div id="message" role="status">Connecting…</div><script src="/window.js" defer></script></body></html>`;

/** DSH's authenticated Connection transports owner traffic. The browser gets a separate, local capability. */
export class DebuggerBridge {
  private sessions = new Map<string, Session>();
  private server?: Server;
  private starting?: Promise<string>;
  private origin = '';
  private disposed = false;
  private cleanupJobs = new Set<Promise<void>>();
  private sweep = setInterval(() => this.expire(), 5000);
  constructor(private readonly launch: LaunchWindow = launchWindow, private readonly now = Date.now,
    private readonly asset = () => readFile(new URL('../window.js', import.meta.url), 'utf8')) { this.sweep.unref(); }

  private async listen(): Promise<string> {
    if (this.disposed) throw new BridgeError('Debugger is closed', 410);
    this.starting ??= (async () => {
      const js = await this.asset();
      const server = createServer(async (req, res) => {
        const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
        try {
          // Reject DNS rebinding and cross-origin requests, including form/beacon requests.
          if (req.headers.host !== new URL(this.origin).host || (req.headers.origin && req.headers.origin !== this.origin)) throw new BridgeError('Forbidden', 403);
          if (req.method === 'GET' && (req.url === '/' || req.url === '/window.js')) {
            res.writeHead(200, { ...headers, 'Content-Type': req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
            res.end(req.url === '/' ? html : js); return;
          }
          if (req.method !== 'POST' || req.url !== '/rpc' || !req.headers['content-type']?.startsWith('application/json')) throw new BridgeError('Not found', 404);
          let size = 0; const chunks: Buffer[] = [];
          for await (const chunk of req) { size += chunk.length; if (size > LIMIT) throw new BridgeError('Request too large', 413); chunks.push(chunk); }
          const input = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const value = await this.windowRequest(input, req.headers.authorization ?? '');
          res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(value ?? null));
        } catch (error) {
          res.writeHead(error instanceof BridgeError ? error.status : 500, { ...headers, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Debugger request failed' }));
        }
      });
      this.server = server;
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Debugger listener unavailable');
      this.origin = `http://127.0.0.1:${address.port}`;
      if (this.disposed) { server.close(); throw new BridgeError('Debugger is closed', 410); }
      return this.origin;
    })().catch(error => { this.starting = undefined; throw error; });
    return this.starting;
  }

  async create(page: PageState): Promise<SessionKey> {
    const origin = await this.listen();
    if (this.sessions.size >= 8) throw new BridgeError('Too many debugger windows', 429);
    const id = secret(), session: Session = { host: secret(), window: secret(), page, queue: [], pending: new Map(), hostSeen: this.now(), windowSeen: this.now() + 30_000 };
    this.sessions.set(id, session);
    try {
      const process = await this.launch(`${origin}/#${id}.${session.window}`, () => this.closeSession(id));
      if (!this.sessions.has(id)) { await process.close(); throw new BridgeError('Debugger window closed', 410); }
      session.process = process;
      return { id, token: session.host };
    } catch (error) { this.closeSession(id); throw error; }
  }

  private session(id: unknown, token: unknown, role: 'host' | 'window'): Session {
    const session = this.sessions.get(string(id, 64));
    if (!session) throw new BridgeError('Debugger window closed', 410);
    if (session[role] !== token) throw new BridgeError('Forbidden', 403);
    return session;
  }

  async ownerRequest(input: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new BridgeError('Debugger is closed', 410);
    if (input.action === 'create') return this.create(pageState(input.page));
    const session = this.session(input.id, input.token, 'host');
    if (input.action === 'close') { this.closeSession(string(input.id)); return { ok: true }; }
    if (input.action !== 'exchange') throw new BridgeError('Unknown action');
    const page = pageState(input.page);
    if (!Array.isArray(input.replies) || input.replies.length > 64) throw new BridgeError('Invalid replies');
    session.hostSeen = this.now();
    // Never execute or apply a command belonging to the document before navigation.
    if (page.revision !== session.page.revision) {
      for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(new BridgeError('Page navigated', 409)); }
      session.pending.clear(); session.queue = [];
    }
    session.page = page;
    for (const raw of input.replies) {
      const reply = record(raw), id = string(reply.id, 64), pending = session.pending.get(id);
      if (!pending) continue;
      session.pending.delete(id); clearTimeout(pending.timer);
      if (reply.error !== undefined) pending.reject(new BridgeError(string(reply.error, 2048), 502));
      else pending.resolve(reply.value ?? null);
    }
    return { commands: session.queue.splice(0) };
  }

  async windowRequest(input: Record<string, unknown>, authorization: string): Promise<unknown> {
    const session = this.session(input.id, authorization.replace(/^Bearer /, ''), 'window');
    session.windowSeen = this.now();
    if (input.action === 'status') return session.page;
    if (input.action === 'close') { this.closeSession(string(input.id)); return { ok: true }; }
    if (input.action !== 'execute' || typeof input.gesture !== 'boolean') throw new BridgeError('Unknown action');
    if (input.revision !== session.page.revision || !session.page.ready) throw new BridgeError('Page navigated or is loading', 409);
    if (session.pending.size >= 32) throw new BridgeError('Debugger is busy', 429);
    const code = string(input.code, 512_000), id = secret(), gesture = input.gesture;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id); session.queue = session.queue.filter(c => c.id !== id);
        reject(new BridgeError('Page command timed out', 504));
      }, 15_000);
      timer.unref();
      session.pending.set(id, { resolve, reject, timer, revision: session.page.revision });
      session.queue.push({ id, code, gesture, revision: session.page.revision });
    });
  }

  closeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(new BridgeError('Debugger window closed', 410)); }
    session.pending.clear(); session.queue = [];
    if (session.process) {
      const job = session.process.close().catch(() => {}).finally(() => this.cleanupJobs.delete(job));
      this.cleanupJobs.add(job);
    }
  }
  expire(): void {
    for (const [id, s] of this.sessions) if (this.now() - s.hostSeen > 20_000 || this.now() - s.windowSeen > 20_000) this.closeSession(id);
  }
  async dispose(): Promise<void> {
    this.disposed = true; clearInterval(this.sweep);
    for (const id of this.sessions.keys()) this.closeSession(id);
    await this.starting?.catch(() => {});
    await Promise.all(this.cleanupJobs);
    if (this.server?.listening) {
      this.server.closeAllConnections();
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
    }
  }
}

export function createHandler(bridge: DebuggerBridge) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') throw new BridgeError('Method not allowed', 405);
      if (request.headers.get('X-DSH-Debugger') !== '1' || !request.headers.get('content-type')?.startsWith('application/json')) throw new BridgeError('Forbidden', 403);
      if (Number(request.headers.get('content-length')) > LIMIT) throw new BridgeError('Request too large', 413);
      const body = await request.text();
      if (Buffer.byteLength(body) > LIMIT) throw new BridgeError('Request too large', 413);
      return Response.json(await bridge.ownerRequest(record(JSON.parse(body))), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Debugger request failed' },
        { status: error instanceof BridgeError ? error.status : 500, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
