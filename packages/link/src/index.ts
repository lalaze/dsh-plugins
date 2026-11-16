/**
 * dsh-link: open the full DSH of the same tailnet user's other machines from this one.
 *
 * Every DSH that runs the plugin has two halves:
 * - the tailnet listener (listener.ts) admits only this node's own tailnet user and forwards into this machine's DSH;
 * - the mounts serve every machine found on the tailnet under `/dsh-link/peer/<id>/` on this host's own
 *   webServer, behind DSH's own connection fence, so a page here opens that machine's complete UI.
 * On top: an attention board (waiting approvals and questions, finished turns) and a safe remote restart.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Schema from '@deepseek-ai/schemastery';
import { AttentionTracker } from './attention.js';
import { AttentionBoard, SELF, serveEvents } from './attention-board.js';
import type { HostContext } from './dsh.js';
import { Admission, Frontend, listen, type Listening } from './listener.js';
import { LoopbackSession } from './login.js';
import { candidatesOf, MachineBook } from './machines.js';
import type { Hello, MachinesAnswer, SelfInfo } from './model.js';
import { forwardHttp, forwardUpgrade, HOP_HEADER, locationUnder, readJson, requestHeaders, sendJson, sendText } from './proxy.js';
import { MOUNT_ROOT, mountedIndex, mountPrefix } from './rewrite.js';
import { RestartService } from './restart/service.js';
import { inspectBusy, processFacts, readVersions, restartTarget } from './restart/target.js';
import { readStatus, whois, type TailnetStatus } from './tailscale.js';

export const name = 'dsh-link';
export const inject = ['webServer', 'connection'];

export interface Config {
  name: string;
  port: number;
  listen: boolean;
  discover: boolean;
  peers: string[];
  tailscale: string;
  refreshSeconds: number;
  allowSelf: boolean;
  listenHost: string;
}

export const Config: Schema<Config> = Schema.object({
  name: Schema.string().default('').description('Name other machines show for this one; empty uses the Tailscale machine name / 本机在其他机器上显示的名字，留空用 Tailscale 机器名'),
  port: Schema.natural().min(1).max(65535).default(7390).description('Port opened on this machine\'s Tailscale address; machines find each other on the same port / 在本机 Tailscale 地址上开放的端口，各机器一致才能互相发现'),
  listen: Schema.boolean().default(true).description('Let other machines open this DSH / 允许其他机器打开本机的 DSH'),
  discover: Schema.boolean().default(true).description('Find the computers of the same Tailscale account / 自动发现同一 Tailscale 账号下的电脑'),
  peers: Schema.array(Schema.string()).default([]).description('Machines added by address, e.g. http://100.96.195.115:7390 / 手动添加的机器地址'),
  tailscale: Schema.string().default('').description('Path of the tailscale command; empty finds it / tailscale 命令的路径，留空自动查找'),
  refreshSeconds: Schema.natural().min(10).max(600).default(30).description('How often other machines are checked, in seconds / 多久检查一次其他机器（秒）'),
  allowSelf: Schema.boolean().default(false).description('Testing: admit requests from this machine\'s own address / 测试用：接受来自本机地址的请求'),
  listenHost: Schema.string().default('').description('Testing: listen address; empty uses this machine\'s Tailscale IPv4 / 测试用：监听地址'),
});

const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');

function readVersion(): string {
  try { return String((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version ?? ''); } catch { return ''; }
}

/** This DSH's id among machines: lets a listener tell that a probe reached itself. */
function identity(dir: string): string {
  const file = join(dir, 'identity.json');
  try { const id = (JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown }).id; if (typeof id === 'string' && id) return id; } catch { /* first start */ }
  const id = randomUUID();
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify({ id }), { mode: 0o600 }); } catch { /* in memory then */ }
  return id;
}

const OS_NAMES: Record<string, string> = { darwin: 'macOS', linux: 'linux', win32: 'windows' };

export function apply(ctx: HostContext, config: Config): void {
  const logger = ctx.logger ?? ctx.get('logger');
  const warn = (text: string) => logger?.warn?.(text);
  const dir = join(dshHome(), 'storages', name);
  const selfId = identity(dir);
  const version = readVersion();
  const origin = () => {
    const port = ctx.webServer.port;
    if (port === undefined) throw new Error('DSH\'s webServer does not listen yet');
    return `http://127.0.0.1:${port}`;
  };

  const self: SelfInfo = { name: config.name || hostname().replace(/\.local$/, ''), os: OS_NAMES[platform()] ?? platform(), version, tailnet: { running: false } };

  // Every Session's appends, open in a page or not.
  const tracker = new AttentionTracker(session => ctx.get('sessionTitle')?.get(session)?.title);
  ctx.on('session/event', (session, event) => tracker.observe(session, event), { global: true });
  ctx.on('session/disposed', session => tracker.forget(session.id), { global: true });
  const board = new AttentionBoard(tracker);
  ctx.effect(() => () => board.close(), 'dsh-link: attention board');

  const restart = new RestartService({
    dir: join(dir, 'restart'),
    helper: fileURLToPath(new URL('./restart/helper.js', import.meta.url)),
    target: () => restartTarget(processFacts()),
    busy: () => inspectBusy(ctx.get('agents'), ctx.get('jobs'), agent => { try { return agent.session ? ctx.get('sessionTitle')?.get(agent.session)?.title : undefined; } catch { return undefined; } }),
    versions: () => readVersions(ctx.get('profileContext')?.dir, process.argv[1]),
    warn,
  });
  ctx.effect(() => () => restart.dispose(), 'dsh-link: restart');

  const book = new MachineBook(join(dir, 'machines.json'), () => selfId);
  book.load();

  const hello = (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 200, { dshLink: 1, id: selfId, name: self.name, os: self.os, version } satisfies Hello);

  // ---- Routes on this host's own webServer, behind DSH's connection fence.
  const fenced = (handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => async (req: IncomingMessage, res: ServerResponse) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection) { sendText(res, rejection, rejection === 401 ? 'Sign in to this DSH first.' : 'Forbidden'); return; }
    await handler(req, res);
  };
  const peers = (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 200, { self, machines: book.list() } satisfies MachinesAnswer);
  const seen = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST' }); return; }
    const body = await readJson(req, 1024).catch(() => undefined) as { machine?: unknown } | undefined;
    if (typeof body?.machine !== 'string') { sendJson(res, 400, { error: 'expected {machine}' }); return; }
    board.seen(body.machine);
    sendJson(res, 200, { ok: true });
  };
  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>> = {
    '/dsh-link/hello': hello,
    '/dsh-link/peers': peers,
    '/dsh-link/attention': (_req, res) => board.serve(res),
    '/dsh-link/attention/seen': seen,
    '/dsh-link/restart': (req, res) => restart.serve(req, res),
  };
  ctx.effect(() => {
    const disposers = Object.entries(routes).map(([path, handler]) => ctx.webServer.register({ kind: 'exact', path, handler: fenced(handler) }));
    return () => { for (const dispose of disposers) dispose(); };
  }, 'dsh-link: routes');

  // ---- Mounts: another machine's whole DSH under /dsh-link/peer/<id>/.
  let reprobe: (() => void) | undefined;
  const loggedMisses = new Set<string>();
  const mountTarget = (req: IncomingMessage, res: ServerResponse | undefined): { id: string; rest: string; search: string } | undefined => {
    const url = new URL(req.url ?? '/', 'http://x');
    const match = /^\/dsh-link\/peer\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
    if (!match) { if (res) sendText(res, 404, 'Not found'); return undefined; }
    if (match[2] === undefined) {
      if (res) { res.writeHead(308, { location: `${mountPrefix(match[1]!)}/${url.search}` }); res.end(); }
      return undefined;
    }
    return { id: match[1]!, rest: match[2], search: url.search };
  };
  const mountHttp = (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers[HOP_HEADER] !== undefined) { sendText(res, 508, 'A machine opened through another machine cannot open a third one.'); return; }
    const where = mountTarget(req, res);
    if (!where) return;
    const machine = book.get(where.id);
    if (!machine) { sendText(res, 404, 'This machine is not known here (any more). Go back and pick it again.'); return; }
    const upstream = new URL(machine.url);
    forwardHttp(req, res, {
      target: new URL(where.rest + where.search, upstream),
      headers: requestHeaders(req.headers, { host: upstream.host, [HOP_HEADER]: '1' }),
      location: locationUnder(upstream, mountPrefix(where.id)),
      html: html => {
        const page = mountedIndex(html, where.id);
        for (const miss of page.misses) {
          if (loggedMisses.has(miss.point)) continue;
          loggedMisses.add(miss.point);
          warn(`dsh-link: ${machine.name}'s page: ${miss.point}: ${miss.reason}`);
        }
        return page.html;
      },
      onUnreachable: () => reprobe?.(),
    });
  };
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: MOUNT_ROOT, handler: fenced(mountHttp) }), 'dsh-link: mounts');

  // The webServer only has exact upgrade routes: one per machine, for DSH's event stream.
  const upgrades = new Map<string, () => void>();
  const mountUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const deny = (status: number, text: string) => socket.end(`HTTP/1.1 ${status} ${text}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
    const rejection = ctx.connection.requestRejection(req);
    if (rejection) { deny(rejection, rejection === 401 ? 'Unauthorized' : 'Forbidden'); return; }
    if (req.headers[HOP_HEADER] !== undefined) { deny(508, 'Loop Detected'); return; }
    const where = mountTarget(req, undefined);
    const machine = where && book.get(where.id);
    if (!where || !machine) { deny(404, 'Not Found'); return; }
    const upstream = new URL(machine.url);
    forwardUpgrade(req, socket, head, { target: new URL(where.rest + where.search, upstream), headers: requestHeaders(req.headers, { host: upstream.host, [HOP_HEADER]: '1' }), onUnreachable: () => reprobe?.() });
  };
  const syncMounts = () => {
    const ids = new Set(book.list().map(machine => machine.id));
    for (const id of ids) {
      if (!upgrades.has(id)) upgrades.set(id, ctx.webServer.registerUpgrade({ path: `${mountPrefix(id)}/api/remote.mux`, handler: mountUpgrade }));
    }
    for (const [id, dispose] of upgrades) if (!ids.has(id)) { dispose(); upgrades.delete(id); }
    board.follow(Object.fromEntries(book.list().filter(machine => machine.state === 'online').map(machine => [machine.id, machine.url])));
  };
  ctx.effect(() => {
    const off = book.onChange(syncMounts);
    syncMounts();
    return () => { off(); for (const dispose of upgrades.values()) dispose(); upgrades.clear(); };
  }, 'dsh-link: mount streams');

  // ---- The tailnet listener and the refresh loop.
  ctx.effect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> | undefined;
    let listening: Listening | undefined;
    let starting = false;
    let lastRefresh = 0;
    let markedBack = false;
    const refused = new Map<string, number>();
    const session = new LoopbackSession(ctx.connection, origin);
    const frontend = new Frontend(session, origin, { http: { '/dsh-link/hello': hello, '/dsh-link/events': (_req, res) => serveEvents(tracker, res), '/dsh-link/restart': (req, res) => restart.serve(req, res) } });

    const startListener = async (status: TailnetStatus) => {
      if (!config.listen || listening || starting || stopped) return;
      const host = config.listenHost || status.self.ips.find(ip => !ip.includes(':'));
      if (!host) { self.listenError = 'this machine has no Tailscale IPv4 address'; return; }
      starting = true;
      try {
        const admission = new Admission(status, host, config.allowSelf, ip => whois(config.tailscale, ip));
        const started = await listen(host, config.port, admission, frontend, (verdict, url) => {
          // One line per address and reason a minute, not one per request.
          const key = `${verdict.ip} ${verdict.reason}`;
          if (Date.now() - (refused.get(key) ?? 0) < 60_000) return;
          refused.set(key, Date.now());
          warn(`dsh-link: refused ${verdict.ip}${verdict.node ? ` (${verdict.node})` : ''}: ${verdict.reason} ${url.split('?')[0]}`);
        });
        if (stopped) { await started.close(); return; }
        listening = started;
        self.url = started.url;
        delete self.listenError;
        logger?.info?.(`dsh-link: listening on ${started.url}`);
      } catch (error) {
        self.listenError = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `port ${config.port} is in use on ${host}` : (error as Error).message;
        warn(`dsh-link: the tailnet listener did not start: ${self.listenError}`);
      } finally { starting = false; }
    };

    const refresh = async () => {
      let status: TailnetStatus | undefined;
      try {
        status = await readStatus(config.tailscale);
        if (!config.name && status.self.name) self.name = status.self.name;
        self.tailnet = { running: status.running, ...(status.self.ips[0] ? { address: status.self.ips.find(ip => !ip.includes(':')) ?? status.self.ips[0] } : {}) };
      } catch (error) {
        self.tailnet = { running: false, error: (error as Error).message };
      }
      if (stopped) return;
      if (status?.running) await startListener(status);
      await book.refresh(candidatesOf(status, config.port, config.peers, config.discover));
      lastRefresh = Date.now();
      if (!markedBack && ctx.webServer.port !== undefined) {
        markedBack = true;
        const back = restart.markBack();
        if (back) logger?.info?.(`dsh-link: back after restart ${back.id}${back.changes?.length ? `: ${back.changes.map(change => `${change.name} ${change.from ?? '-'} -> ${change.to ?? '-'}`).join(', ')}` : ''}`);
      }
    };
    const loop = () => {
      if (stopped) return;
      running = refresh().catch(error => warn(`dsh-link: refresh failed: ${(error as Error).message}`)).finally(() => {
        running = undefined;
        if (!stopped) timer = setTimeout(loop, config.refreshSeconds * 1000);
      });
    };
    // A mount could not reach its machine: look again soon instead of at the next round.
    reprobe = () => {
      if (stopped || running || Date.now() - lastRefresh < 5_000) return;
      clearTimeout(timer);
      timer = setTimeout(loop, 0);
    };
    loop();
    return async () => {
      stopped = true;
      reprobe = undefined;
      clearTimeout(timer);
      await running?.catch(() => undefined);
      await listening?.close();
      self.url = undefined;
    };
  }, 'dsh-link: tailnet listener');
}

export { SELF };
