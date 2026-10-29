import { createHash } from 'node:crypto';
/**
 * Runs on the SSH host beside the relay and shares DSH's MCP servers and skills with remote CLIs.
 *
 * - `proxy <task file> <server>`: a stdio MCP server for one DSH MCP server. Each list and call goes to DSH over
 *   the reverse-forwarded socket named in `bridge/current`, authenticated with the task's token. While DSH is
 *   away it lists the last tools it saw and fails calls with a reason the model can relay.
 * - `skills <shared dir>`: a stdio MCP server that loads the skills synced from DSH. It needs no DSH connection.
 * - `manifest <shared dir>` / `sync <shared dir>`: report and replace the synced skills; `sync` reads its JSON
 *   payload from stdin. The shared directory is also a Claude Code plugin, so Claude loads the skills natively.
 *
 * Each DSH instance has its own socket pointer, tool cache and shared directory: one remote account may be
 * used from several computers.
 *
 * The source is embedded in a template literal: it must not contain backticks or dollar-brace sequences.
 */
export const BRIDGE_SCRIPT = String.raw `
import fs from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SKILL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const [mode, ...args] = process.argv.slice(2);
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const log = text => process.stderr.write('[dsh-bridge] ' + text + '\n');
const readJson = path => { try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return undefined; } };
const writeJson = (path, value) => { const temporary = path + '.' + process.pid + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, path); };
const text = value => ({ content: [{ type: 'text', text: value }], isError: true });

/** A minimal MCP stdio server: tools only, newline-delimited JSON-RPC. */
function serve(options) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', async line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') return;
    const id = message.id, request = id !== undefined && id !== null;
    const reply = result => { if (request) send({ jsonrpc: '2.0', id, result }); };
    const fail = (code, error) => { if (request) send({ jsonrpc: '2.0', id, error: { code, message: error } }); };
    try {
      switch (message.method) {
        case 'initialize': {
          const asked = message.params && message.params.protocolVersion;
          reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[1], capabilities: { tools: { listChanged: true } },
            serverInfo: { name: options.name, version: '1.0.0' }, ...(options.instructions ? { instructions: options.instructions } : {}) });
          return;
        }
        case 'ping': reply({}); return;
        case 'tools/list': reply({ tools: await options.list() }); return;
        case 'tools/call': {
          const params = message.params || {};
          reply(await options.call(String(params.name), params.arguments && typeof params.arguments === 'object' ? params.arguments : {}, id));
          return;
        }
        case 'notifications/cancelled': if (options.cancel && message.params) options.cancel(message.params.requestId); return;
        default: if (!message.method.startsWith('notifications/')) fail(-32601, 'Method not found: ' + message.method);
      }
    } catch (error) { fail(-32603, error instanceof Error ? error.message : String(error)); }
  });
  input.on('close', () => process.exit(0));
}

function proxy(taskFile, server) {
  const task = readJson(taskFile);
  if (!task || typeof task.task !== 'string' || typeof task.token !== 'string' || typeof task.pointer !== 'string') { log('Invalid task file ' + taskFile); process.exit(1); }
  const cache = join(task.cache, server + '.json');
  let socket, connecting, nextId = 0, delay = 2000, failed = false, ended = false;
  const pending = new Map();
  const changed = () => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  function drop(error) {
    socket = undefined;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }
  function connect() {
    if (socket) return Promise.resolve(socket);
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      let path;
      try { path = fs.readFileSync(task.pointer, 'utf8').trim(); } catch { reject(new Error('DSH has not connected to this host yet')); return; }
      const next = createConnection(path);
      let buffer = '', ready = false;
      const timer = setTimeout(() => { next.destroy(); reject(new Error('DSH did not answer')); }, 10000);
      next.setEncoding('utf8');
      next.on('connect', () => next.write(JSON.stringify({ op: 'hello', task: task.task, token: task.token, server }) + '\n'));
      next.on('data', chunk => {
        buffer += chunk;
        for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (!ready) {
            clearTimeout(timer);
            if (message.hello !== 'ok') { next.destroy(); reject(new Error(message.error || 'DSH refused this connection')); return; }
            ready = true; socket = next; resolve(next);
            if (failed) { failed = false; changed(); }
            continue;
          }
          if (message.event === 'changed') { changed(); continue; }
          const entry = pending.get(message.id);
          if (!entry) continue;
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.result);
        }
      });
      next.on('error', error => { clearTimeout(timer); if (!ready) reject(error); });
      next.on('close', () => { clearTimeout(timer); if (socket === next) { failed = true; drop(new Error('DSH disconnected')); retry(); } else if (!ready) reject(new Error('DSH closed the connection')); });
    }).finally(() => { connecting = undefined; });
    return connecting;
  }
  /** Stay connected, so tool changes in DSH reach the CLI; reconnect after DSH comes back. */
  function retry() {
    if (ended) return;
    setTimeout(() => connect().then(() => { delay = 2000; }, () => { failed = true; delay = Math.min(delay * 2, 60000); retry(); }), delay).unref();
  }
  async function request(op, params, mcpId) {
    const connection = await connect();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, mcpId });
      connection.write(JSON.stringify({ id, op, ...params }) + '\n');
    });
  }
  connect().catch(() => { failed = true; retry(); });
  process.stdin.on('end', () => { ended = true; });
  serve({
    name: 'dsh-' + server,
    instructions: 'Tools of the "' + server + '" MCP server configured in DSH. They run in DSH on the user\'s computer, not on this host, and DSH may ask the user to approve a call.',
    async list() {
      try { const tools = (await request('list', {})).tools; writeJson(cache, tools); return tools; }
      catch (error) { log('Listing tools from DSH failed: ' + error.message); return readJson(cache) || []; }
    },
    async call(name, input, mcpId) {
      try { return await request('call', { name, arguments: input }, mcpId); }
      catch (error) { return text('DSH could not run this tool: ' + error.message + '. It runs in DSH on the user\'s computer; ask the user to open DSH and reconnect this host, then retry.'); }
    },
    cancel(requestId) {
      for (const [id, entry] of pending) if (entry.mcpId === requestId && socket) socket.write(JSON.stringify({ op: 'cancel', id }) + '\n');
    },
  });
}

function skills(shared) {
  const catalog = () => (readJson(join(shared, 'catalog.json')) || []).filter(skill => skill && SKILL.test(skill.name) && fs.existsSync(join(shared, 'skills', skill.name, 'SKILL.md')));
  let seen = JSON.stringify(catalog());
  fs.watchFile(join(shared, 'catalog.json'), { interval: 2000 }, () => {
    const next = JSON.stringify(catalog());
    if (next !== seen) { seen = next; send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); }
  }).unref();
  serve({
    name: 'dsh',
    instructions: 'Skills shared from DSH: task-specific instructions. When a task matches a skill listed in load_skill, load it before you start.',
    async list() {
      const entries = catalog();
      if (!entries.length) return [];
      const lines = entries.map(skill => '- ' + skill.name + ': ' + skill.description + (skill.whenToUse ? ' ' + skill.whenToUse : ''));
      let listing = lines.join('\n');
      if (listing.length > 12000) listing = entries.map(skill => '- ' + skill.name + ': ' + skill.description.slice(0, 120)).join('\n').slice(0, 12000);
      return [{ name: 'load_skill', title: 'Load a DSH skill',
        description: 'Load the full instructions of a skill shared from DSH. Load the matching skill before starting a task it covers, then follow it.\n\nAvailable skills:\n' + listing,
        inputSchema: { type: 'object', properties: { name: { type: 'string', enum: entries.map(skill => skill.name), description: 'Skill name' } }, required: ['name'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false } }];
    },
    async call(name, input) {
      if (name !== 'load_skill') return text('Unknown tool: ' + name);
      const skill = catalog().find(entry => entry.name === input.name);
      if (!skill) return text('No shared skill is named "' + String(input.name) + '".');
      const directory = join(shared, 'skills', skill.name);
      const body = fs.readFileSync(join(directory, 'SKILL.md'), 'utf8');
      return { content: [{ type: 'text', text: 'Skill "' + skill.name + '" from DSH. Its files are in ' + directory + '; resolve relative paths in these instructions against that directory.\n\n' + body }] };
    },
  });
}

/** Skills whose directory still exists, so a deleted copy is sent again; the last sync's fingerprint while nothing is missing. */
function manifest(shared) {
  const saved = readJson(join(shared, 'manifest.json')) || {}, skills = {};
  for (const [name, hash] of Object.entries(saved)) if (SKILL.test(name) && fs.existsSync(join(shared, 'skills', name, 'SKILL.md'))) skills[name] = hash;
  const complete = Object.keys(skills).length === Object.keys(saved).length && fs.existsSync(join(shared, 'catalog.json')) && fs.existsSync(join(shared, '.claude-plugin', 'plugin.json'));
  const fingerprint = complete ? readJson(join(shared, 'fingerprint.json')) : undefined;
  return { skills, ...(typeof fingerprint === 'string' ? { fingerprint } : {}) };
}

function sync(shared) {
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const root = join(shared, 'skills');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // An interrupted sync leaves no fingerprint, so the next one checks every skill again.
    fs.rmSync(join(shared, 'fingerprint.json'), { force: true });
    const before = readJson(join(shared, 'manifest.json')) || {};
    for (const [name, files] of Object.entries(payload.files || {})) {
      if (!SKILL.test(name) || !Array.isArray(files)) throw new Error('Invalid skill ' + name);
      const staging = join(root, '.staging-' + name + '-' + process.pid);
      fs.rmSync(staging, { recursive: true, force: true });
      for (const file of files) {
        const parts = String(file.path).split('/');
        if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0') || part.includes('\\'))) throw new Error('Invalid skill file path');
        const target = join(staging, ...parts);
        fs.mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, Buffer.from(String(file.data), 'base64'), { mode: file.executable ? 0o700 : 0o600 });
      }
      fs.rmSync(join(root, name), { recursive: true, force: true });
      fs.renameSync(staging, join(root, name));
    }
    const next = payload.manifest || {};
    for (const name of Object.keys(before)) if (!Object.hasOwn(next, name) && SKILL.test(name)) fs.rmSync(join(root, name), { recursive: true, force: true });
    // A skill not sent must already be here as the same version. One that is not is left out and reported, so DSH sends it.
    const missing = Object.keys(next).filter(name => !Object.hasOwn(payload.files || {}, name) && (before[name] !== next[name] || !fs.existsSync(join(root, name, 'SKILL.md'))));
    const manifest = Object.fromEntries(Object.entries(next).filter(([name]) => !missing.includes(name)));
    fs.mkdirSync(join(shared, '.claude-plugin'), { recursive: true, mode: 0o700 });
    writeJson(join(shared, '.claude-plugin', 'plugin.json'), { name: 'dsh', version: '1.0.0', description: 'Skills shared from DSH' });
    writeJson(join(shared, 'manifest.json'), manifest);
    writeJson(join(shared, 'catalog.json'), (payload.catalog || []).filter(skill => !missing.includes(skill.name)));
    if (!missing.length && typeof payload.fingerprint === 'string') writeJson(join(shared, 'fingerprint.json'), payload.fingerprint);
    send({ ok: true, missing });
  });
}

try {
  if (mode === 'proxy') proxy(args[0], args[1]);
  else if (mode === 'skills') skills(args[0]);
  else if (mode === 'manifest') send(manifest(args[0]));
  else if (mode === 'sync') sync(args[0]);
  else { log('Unknown mode ' + mode); process.exit(2); }
} catch (error) { log(error instanceof Error ? error.message : String(error)); process.exit(1); }
`;
export const BRIDGE_VERSION = createHash('sha256').update(BRIDGE_SCRIPT).digest('hex').slice(0, 12);
