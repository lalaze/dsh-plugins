import { createHash } from 'node:crypto';

/**
 * Runs on the SSH host and keeps the session registry every DSH connected to this SSH account shares.
 *
 * `serve <base> <instance>` answers JSON-RPC requests on stdin and reports changed sessions as
 * `changed` notifications. Each session directory holds `manifest.json` (the portable task record),
 * `events.jsonl` (its history, one timeline entry per line, appended in sequence), `head.json` (the
 * history length), `lease.json` (the DSH instance driving the CLI) and `live.json` (that instance's
 * live status). Only the lease holder may append history, so two instances can never interleave a
 * session's history. A deleted session leaves `deleted.json` so other instances forget it too.
 */
export const SHARED_SCRIPT = String.raw`
import fs from 'node:fs';
import { join } from 'node:path';

const [command, base, instance] = process.argv.slice(2);
const number = name => Number(process.env[name]) > 0 ? Number(process.env[name]) : undefined;
const LEASE = number('DSH_SHARED_LEASE_MS') ?? 180_000, SCAN = number('DSH_SHARED_SCAN_MS') ?? 500, TOMBSTONE = 180 * 24 * 3600_000;
const READ = 4 * 1024 * 1024, SESSIONS = 5000, WORKSPACES = 500, PAGE = 200;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/, INSTANCE = /^[A-Za-z0-9_-]{8,100}$/;
const sessions = join(base, 'sessions'), locks = join(base, 'locks'), workspaceFile = join(base, 'workspaces.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = path => { try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return undefined; } };
const writeJson = (path, value) => { const temporary = path + '.' + process.pid + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, path); };
const dirOf = id => { if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid shared session ID'); return join(sessions, id); };
/** Lease age is measured on this host, so DSH instances with different clocks agree on it. */
const leaseOf = lease => lease && typeof lease.instance === 'string' ? { instance: lease.instance, label: String(lease.label ?? ''), age: Math.max(0, Date.now() - Date.parse(lease.at)) } : undefined;
const fresh = lease => !!lease && Date.now() - Date.parse(lease.at) < LEASE;

/** One writer at a time per session, across every DSH instance's server. A crashed holder's lock expires. */
async function locked(key, action) {
  fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lock = join(locks, key);
  for (let attempt = 0; ; attempt++) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmdirSync(lock); continue; } } catch { continue; }
      if (attempt > 2000) throw new Error('The shared session stayed locked');
      await sleep(5);
    }
  }
  try { return await action(); } finally { try { fs.rmdirSync(lock); } catch {} }
}
/** The history length. An append interrupted before its head was saved is counted again; a partial line is dropped. */
function head(dir, repair) {
  const file = join(dir, 'events.jsonl'), saved = readJson(join(dir, 'head.json'));
  let size = 0; try { size = fs.statSync(file).size; } catch {}
  // A longer file is an append under way elsewhere; its head follows. Readers never count a large history.
  if (saved && Number.isSafeInteger(saved.seq) && Number.isSafeInteger(saved.bytes) && (saved.bytes === size || (!repair && saved.bytes < size))) return { seq: saved.seq, bytes: saved.bytes };
  if (!size) return { seq: 0, bytes: 0 };
  const data = fs.readFileSync(file), end = data.lastIndexOf(10) + 1;
  let seq = 0; for (let i = 0; i < end; i++) if (data[i] === 10) seq++;
  const value = { seq, bytes: end };
  if (repair) { if (end < size) fs.truncateSync(file, end); writeJson(join(dir, 'head.json'), value); }
  return value;
}
function state(id) {
  const dir = dirOf(id), deleted = readJson(join(dir, 'deleted.json'));
  if (deleted) return { id, deleted: true, ...(typeof deleted.withdrawn === 'string' ? { withdrawnBy: deleted.withdrawn } : {}) };
  const manifest = readJson(join(dir, 'manifest.json'));
  if (!manifest) return { id, missing: true };
  return { id, manifest, lease: leaseOf(readJson(join(dir, 'lease.json'))), live: readJson(join(dir, 'live.json')), head: head(dir, false) };
}
const ids = () => { try { return fs.readdirSync(sessions).filter(id => ID.test(id)); } catch { return []; } };
const workspaces = () => { const list = readJson(workspaceFile); return Array.isArray(list) ? list.filter(w => w && typeof w.path === 'string') : []; };
/** Lines from a byte offset, at least one and about READ bytes at most. */
function readFrom(file, position) {
  const fd = fs.openSync(file, 'r'), lines = [], buffer = Buffer.allocUnsafe(1024 * 1024);
  let parts = [], at = position, total = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, at);
      if (read <= 0) return { lines, bytes: position + total };
      const chunk = buffer.subarray(0, read); at += read;
      let start = 0;
      for (let newline; (newline = chunk.indexOf(10, start)) >= 0; start = newline + 1) {
        const line = Buffer.concat([...parts, chunk.subarray(start, newline)]); parts = [];
        lines.push(line.toString('utf8')); total += line.length + 1;
        if (total >= READ) return { lines, bytes: position + total };
      }
      parts.push(Buffer.from(chunk.subarray(start)));
    }
  } finally { fs.closeSync(fd); }
}
/** Byte offset of entry seq: the client's hint when it still matches, else counted from the start. */
function offsetOf(file, seq, hint) {
  if (Number.isSafeInteger(hint) && hint >= 0) {
    try {
      const fd = fs.openSync(file, 'r'), probe = Buffer.alloc(64);
      try {
        const before = hint === 0 ? 1 : fs.readSync(fd, probe, 0, 1, hint - 1), boundary = hint === 0 || (before === 1 && probe[0] === 10);
        const read = fs.readSync(fd, probe, 0, probe.length, hint);
        if (boundary && probe.subarray(0, read).toString('utf8').startsWith('{"seqStart":' + seq + ',')) return hint;
      } finally { fs.closeSync(fd); }
    } catch {}
  }
  if (seq === 1) return 0;
  const fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024);
  let count = 0, at = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, at);
      if (read <= 0) return undefined;
      for (let i = 0; i < read; i++) if (buffer[i] === 10 && ++count === seq - 1) return at + i + 1;
      at += read;
    }
  } finally { fs.closeSync(fd); }
}
function removeTombstones() {
  for (const id of ids()) {
    const dir = join(sessions, id);
    try { if (fs.existsSync(join(dir, 'deleted.json')) && Date.now() - fs.statSync(join(dir, 'deleted.json')).mtimeMs > TOMBSTONE) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const methods = {
  hello: () => ({ lease: LEASE }),
  /** Sessions in pages, so a large registry never exceeds a message's size limit. */
  list: ({ after }) => {
    const page = ids().sort().filter(id => typeof after !== 'string' || id > after).slice(0, PAGE);
    return { sessions: page.map(state).filter(s => !s.missing), ...(page.length === PAGE ? { next: page.at(-1) } : {}), ...(typeof after === 'string' ? {} : { workspaces: workspaces() }) };
  },
  get: ({ id }) => state(id),
  /** Fields set to null are removed. Concurrent edits of different fields both survive. */
  put: ({ id, patch }) => locked(id, () => {
    const dir = dirOf(id);
    if (fs.existsSync(join(dir, 'deleted.json'))) return { deleted: true };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid manifest patch');
    const current = readJson(join(dir, 'manifest.json'));
    if (!current && ids().length >= SESSIONS) throw new Error('The shared session registry is full');
    const next = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(patch)) { if (key === 'rev') continue; if (value === null) delete next[key]; else next[key] = value; }
    next.rev = (Number(current?.rev) || 0) + 1;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJson(join(dir, 'manifest.json'), next);
    return { rev: next.rev };
  }),
  /** Take the lease. Without force, only a free, expired or already held lease is taken. revive shares again a session this instance withdrew. */
  claim: ({ id, force, label, revive }) => locked(id, () => {
    const dir = dirOf(id), lease = readJson(join(dir, 'lease.json')), deleted = readJson(join(dir, 'deleted.json'));
    if (deleted && revive && deleted.withdrawn === instance) fs.rmSync(join(dir, 'deleted.json'), { force: true });
    else if (deleted || fs.existsSync(join(dir, 'deleted.json'))) return { deleted: true };
    if (!force && lease && lease.instance !== instance && fresh(lease)) return { claimed: false, lease: leaseOf(lease) };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const next = { instance, label: String(label ?? '').slice(0, 100), at: new Date().toISOString() };
    writeJson(join(dir, 'lease.json'), next);
    return { claimed: true, lease: leaseOf(next), head: head(dir, false) };
  }),
  /** Keep this instance's leases alive while it drives their CLIs. */
  refresh: async ({ ids: list }) => {
    const refreshed = [];
    for (const id of Array.isArray(list) ? list : []) await locked(id, () => {
      const path = join(dirOf(id), 'lease.json'), lease = readJson(path);
      if (lease?.instance === instance) { writeJson(path, { ...lease, at: new Date().toISOString() }); refreshed.push(id); }
    });
    return { refreshed };
  },
  release: ({ id }) => locked(id, () => {
    const path = join(dirOf(id), 'lease.json');
    if (readJson(path)?.instance === instance) { fs.rmSync(path, { force: true }); fs.rmSync(join(dirOf(id), 'live.json'), { force: true }); }
    return {};
  }),
  /** Append history lines starting at entry seq. Refused unless this instance holds the lease and the history ends just before seq. */
  append: ({ id, seq, lines }) => locked(id, () => {
    const dir = dirOf(id);
    if (fs.existsSync(join(dir, 'deleted.json'))) return { conflict: 'deleted' };
    if (!Array.isArray(lines) || !lines.length || lines.some(line => typeof line !== 'string' || line.includes('\n'))) throw new Error('Invalid history lines');
    const lease = readJson(join(dir, 'lease.json'));
    if (lease?.instance !== instance) return { conflict: 'lease', lease: leaseOf(lease) };
    const current = head(dir, true);
    if (seq !== current.seq + 1) return { conflict: 'seq', head: current };
    const data = Buffer.from(lines.join('\n') + '\n');
    fs.appendFileSync(join(dir, 'events.jsonl'), data, { mode: 0o600 });
    const next = { seq: current.seq + lines.length, bytes: current.bytes + data.length };
    writeJson(join(dir, 'head.json'), next);
    return { head: next };
  }),
  read: ({ id, seq, bytes }) => {
    const dir = dirOf(id), current = head(dir, false);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid history position');
    if (seq > current.seq) return { lines: [], bytes: current.bytes, head: current };
    const position = offsetOf(join(dir, 'events.jsonl'), seq, bytes);
    if (position === undefined) return { lines: [], bytes: current.bytes, head: current };
    const result = readFrom(join(dir, 'events.jsonl'), position);
    return { ...result, lines: result.lines.slice(0, current.seq - seq + 1), head: current };
  },
  live: ({ id, live }) => {
    const dir = dirOf(id);
    if (readJson(join(dir, 'lease.json'))?.instance !== instance) return { conflict: 'lease' };
    writeJson(join(dir, 'live.json'), { ...live, instance, at: new Date().toISOString() });
    return {};
  },
  /** Other instances forget a deleted session. One withdrawn by the instance that started it stays with that instance. */
  delete: ({ id, label, withdrawn }) => locked(id, () => {
    const dir = dirOf(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(dir)) if (name !== 'deleted.json') fs.rmSync(join(dir, name), { recursive: true, force: true });
    writeJson(join(dir, 'deleted.json'), { by: String(label ?? '').slice(0, 100), ...(withdrawn === true ? { withdrawn: instance } : {}), at: new Date().toISOString() });
    return {};
  }),
  workspaces: () => ({ workspaces: workspaces() }),
  addWorkspace: ({ path, label }) => locked('workspaces', () => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\n') || path.length > 4096) throw new Error('Invalid workspace path');
    const list = workspaces();
    if (list.some(w => w.path === path)) return { added: false };
    if (list.length >= WORKSPACES) throw new Error('The shared workspace list is full');
    writeJson(workspaceFile, [...list, { path, by: String(label ?? '').slice(0, 100), at: new Date().toISOString() }]);
    return { added: true };
  }),
};

/**
 * Directory mtimes reveal changes: every file in a session is replaced by renaming. Within a few
 * seconds of a change, file identities are compared as well, since two renames can share a timestamp.
 */
const seen = new Map(); let seenWorkspaces;
function key(dir) {
  const stat = fs.statSync(dir, { bigint: true });
  if (Date.now() - Number(stat.mtimeMs) > 5000) return String(stat.mtimeNs);
  return [stat.mtimeNs, ...['manifest.json', 'head.json', 'lease.json', 'live.json', 'deleted.json'].map(name => { try { return fs.statSync(join(dir, name), { bigint: true }).ino; } catch { return 0n; } })].join(':');
}
function scan(report) {
  const names = ids(), changed = [];
  for (const id of names) {
    let value; try { value = key(join(sessions, id)); } catch { continue; }
    if (seen.get(id) === value) continue;
    seen.set(id, value);
    if (report) { const current = state(id); if (!current.missing) changed.push(current); }
  }
  for (const id of [...seen.keys()]) if (!names.includes(id)) { seen.delete(id); if (report) changed.push({ id, deleted: true }); }
  let shared; try { shared = String(fs.statSync(workspaceFile, { bigint: true }).mtimeNs); } catch { shared = ''; }
  const workspacesChanged = shared !== seenWorkspaces; seenWorkspaces = shared;
  if (report && workspacesChanged) send({ jsonrpc: '2.0', method: 'changed', params: { sessions: [], workspaces: workspaces() } });
  for (let i = 0; report && i < changed.length; i += PAGE) send({ jsonrpc: '2.0', method: 'changed', params: { sessions: changed.slice(i, i + PAGE) } });
}
let writing = Promise.resolve();
function send(value) {
  const line = JSON.stringify(value) + '\n';
  writing = writing.then(() => new Promise(resolve => { if (process.stdout.write(line)) resolve(); else process.stdout.once('drain', resolve); }));
}
async function serve() {
  if (!INSTANCE.test(instance ?? '')) throw new Error('Invalid DSH instance ID');
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  removeTombstones();
  // Changes from now on are reported; the client lists everything after subscribing.
  scan(false);
  setInterval(() => { try { scan(true); } catch {} }, SCAN);
  let queue = Promise.resolve(), parts = [], size = 0;
  const handle = async line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message?.id === undefined || typeof message.method !== 'string') return;
    try {
      if (!Object.hasOwn(methods, message.method)) throw new Error('Unknown shared registry method');
      send({ jsonrpc: '2.0', id: message.id, result: await methods[message.method](message.params ?? {}) });
    } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { message: String(error?.message ?? error) } }); }
  };
  process.stdin.on('data', data => {
    let index = 0;
    while (index < data.length) {
      const newline = data.indexOf(10, index);
      if (newline < 0) { parts.push(data.subarray(index)); size += data.length - index; if (size > 64 * 1024 * 1024) process.exit(1); return; }
      const line = Buffer.concat([...parts, data.subarray(index, newline)]).toString('utf8'); parts = []; size = 0; index = newline + 1;
      // Requests run in order, so an append is never overtaken by a later one.
      queue = queue.then(() => handle(line));
    }
  });
  for (const stream of [process.stdin, process.stdout]) { stream.on('end', () => process.exit(0)); stream.on('error', () => process.exit(0)); }
}
if (command === 'serve') await serve();
else { process.stderr.write('Unknown shared registry command\n'); process.exit(2); }
`;
export const SHARED_VERSION = createHash('sha256').update(SHARED_SCRIPT).digest('hex').slice(0, 16);
