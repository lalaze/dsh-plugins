// A minimal Codex app-server, Claude stream-json and ACP CLI. The prompt selects the behavior:
// `gate` waits for $HOME/gate, `stream N` streams N chunks, `approve` asks for permission,
// `exit` crashes. Every prompt and permission reply is logged to detect duplicates.
import fs from 'node:fs';
import { basename, join } from 'node:path';

const name = basename(process.argv[1]), home = process.env.DSH_FAKE_HOME ?? process.env.HOME;
const log = (file, value) => fs.appendFileSync(join(home, file), `${JSON.stringify(value)}\n`);
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waiting = new Map();
let nextRequest = 0, cancel;

async function run(text, out) {
  log('prompts.log', { cli: name, text });
  let cancelled = false; cancel = () => { cancelled = true; };
  try {
    if (/\bexit\b/.test(text)) { process.stderr.write('fatal: simulated crash\n'); process.exit(3); }
    if (/\bgate\b/.test(text)) {
      out.delta('waiting 🌏 ');
      while (!fs.existsSync(join(home, 'gate'))) { if (cancelled) return out.cancelled(); await sleep(20); }
      out.delta('after-gate 你好');
    } else if (/\bstream (\d+)/.test(text)) {
      const count = Number(text.match(/\bstream (\d+)/)[1]);
      for (let i = 0; i < count; i++) { if (cancelled) return out.cancelled(); out.delta(`c${i}🌏 `); await sleep(25); }
    } else if (/\bapprove\b/.test(text)) {
      out.delta('asking ');
      const decision = await out.approval();
      log('replies.log', { cli: name, decision });
      out.delta(`decision ${decision}`);
    } else out.delta('ok');
    out.done();
  } finally { cancel = undefined; }
}
function request(message) {
  const id = message.id ?? message.request_id;
  return new Promise(resolve => { waiting.set(String(id), resolve); send(message); });
}

const codex = {
  handle(m) {
    const reply = result => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') reply({ userAgent: 'fake-codex' });
    if (m.method === 'model/list') reply({ data: [{ id: 'fake-model', model: 'fake-model', displayName: 'Fake model', isDefault: true, supportedReasoningEfforts: [] }] });
    if (m.method === 'thread/start') reply({ thread: { id: 'thread-1' } });
    if (m.method === 'thread/resume') reply({ thread: { id: m.params.threadId } });
    if (m.method === 'turn/interrupt') { reply({}); cancel?.(); }
    if (m.method === 'turn/start') {
      const turn = `turn-${Date.now()}`;
      reply({ turn: { id: turn } }); send({ method: 'turn/started', params: { turn: { id: turn } } });
      void run(m.params.input[0].text, {
        delta: delta => send({ method: 'item/agentMessage/delta', params: { delta } }),
        approval: async () => (await request({ jsonrpc: '2.0', id: ++nextRequest, method: 'item/commandExecution/requestApproval', params: { command: 'make', availableDecisions: ['accept', 'decline'] } })).result?.decision,
        done: () => send({ method: 'turn/completed', params: { turn: { id: turn, status: 'completed' } } }),
        cancelled: () => send({ method: 'turn/completed', params: { turn: { id: turn, status: 'interrupted' } } }),
      });
    }
  },
};
const claude = {
  handle(m) {
    if (m.type === 'control_request') {
      const response = response => send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
      const subtype = m.request.subtype;
      if (subtype === 'interrupt') { response({}); cancel?.(); return; }
      response(subtype === 'initialize' ? { account: {} } : subtype === 'list_models' ? { models: [{ value: 'fake-model', displayName: 'Fake model' }] } : {});
    }
    if (m.type === 'user') {
      let text = '';
      void run(m.message.content[0].text, {
        delta: delta => { text += delta; send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } } }); },
        approval: async () => (await request({ type: 'control_request', request_id: `req-${++nextRequest}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'make' } } })).response?.response?.behavior,
        done: () => { send({ type: 'assistant', message: { content: [{ type: 'text', text }] } }); send({ type: 'result', subtype: 'success' }); },
        cancelled: () => send({ type: 'result', subtype: 'error_during_execution', is_error: true }),
      });
    }
  },
};
const acp = {
  handle(m) {
    const reply = result => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    if (m.method === 'session/new') reply({ sessionId: 'acp-1', models: { currentModelId: 'fake-model', availableModels: [{ modelId: 'fake-model', name: 'Fake model' }] } });
    if (m.method === 'session/load') reply({});
    if (m.method === 'session/cancel') cancel?.();
    if (m.method === 'session/prompt') {
      void run(m.params.prompt[0].text, {
        delta: text => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }),
        approval: async () => (await request({ jsonrpc: '2.0', id: ++nextRequest, method: 'session/request_permission', params: { sessionId: 'acp-1', toolCall: { title: 'make' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] } })).result?.outcome?.optionId,
        done: () => reply({ stopReason: 'end_turn' }),
        cancelled: () => reply({ stopReason: 'cancelled' }),
      });
    }
  },
};
const protocol = name === 'codex' ? codex : name === 'claude' ? claude : acp;
let buffer = Buffer.alloc(0);
process.stdin.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  let index;
  while ((index = buffer.indexOf(10)) >= 0) {
    const message = JSON.parse(buffer.subarray(0, index).toString('utf8')); buffer = buffer.subarray(index + 1);
    const key = message.type === 'control_response' ? message.response?.request_id : !message.method ? message.id : undefined;
    if (key !== undefined && waiting.has(String(key))) { const resolve = waiting.get(String(key)); waiting.delete(String(key)); resolve(message); continue; }
    if (key !== undefined && !message.method && message.type !== 'control_response') { log('unexpected.log', message); continue; }
    if (message.type === 'control_response') { log('unexpected.log', message); continue; }
    protocol.handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
