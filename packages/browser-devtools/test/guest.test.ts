import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { AGENT_KEY, agentScript, commandScript, detachScript, evaluateScript, type NodeSummary, type Poll, type RequestDetail, type Styles } from '../src/client/guest.js';

const HTML = `<!doctype html><html><head><style>#title{color:red}.missing{color:blue}@media (min-width:1px){h1{margin:4px}}</style></head>
<body><!-- note --><h1 id="title" class="big" style="padding:2px">Hello</h1><ul><li>One</li><li>Two</li></ul></body></html>`;
export function page() {
  const { window } = new JSDOM(HTML, { url: 'https://page.test/', runScripts: 'outside-only' });
  // Electron structured-clones what executeJavaScript returns, awaiting promises first.
  const clone = (value: unknown) => value === undefined ? value : structuredClone(value);
  const run = <T>(code: string): T => {
    const value = window.eval(code) as { then?: unknown };
    return (typeof value?.then === 'function' ? Promise.resolve(value).then(clone) : clone(value)) as T;
  };
  return { window, run, command: <T>(name: string, arg?: unknown) => run<T>(commandScript(name, arg)) };
}

test('every injected script parses on its own', () => {
  for (const script of [agentScript(), commandScript('poll', { log: 0 }), detachScript(), evaluateScript('1 + 1')]) assert.doesNotThrow(() => new vm.Script(script));
});

test('the agent installs once, answers commands, and reports a missing agent as null', () => {
  const { run, command } = page();
  assert.equal(command('poll'), null);
  assert.equal(run(agentScript()), true);
  assert.equal(run(agentScript()), true, 'reinstalling the same version is a no-op');
  assert.deepEqual(command<Poll>('poll')?.logs, []);
});

test('the DOM tree is read lazily with stable ids, skipping whitespace and the highlight overlay', () => {
  const { window, run, command } = page();
  run(agentScript());
  const top = command<NodeSummary[]>('node', { id: 0 })!;
  assert.deepEqual(top.map(node => [node.type, node.name]), [[10, 'html'], [1, 'html']]);
  const html = top[1];
  const [, body] = command<NodeSummary[]>('node', { id: html.id })!;
  command('highlight', { id: body.id });
  const children = command<NodeSummary[]>('node', { id: body.id })!;
  assert.deepEqual(children.map(node => node.name), ['#comment', 'h1', 'ul'], 'the overlay host is never listed');
  const heading = children[1];
  assert.equal(heading.text, 'Hello', 'a short single text child is shown inline');
  assert.equal(heading.childCount, 0);
  assert.deepEqual(heading.attrs, [['id', 'title'], ['class', 'big'], ['style', 'padding:2px']]);
  assert.equal(children[2].childCount, 2);
  assert.equal(command<NodeSummary[]>('node', { id: body.id })![1].id, heading.id, 'ids stay stable between reads');
  assert.ok(window.document.querySelector('dsh-browser-devtools-overlay'));
});

test('styles list inline declarations, matched rules (newest first) and the computed values', () => {
  const { run, command } = page();
  run(agentScript());
  const html = command<NodeSummary[]>('node', { id: 0 })![1];
  const body = command<NodeSummary[]>('node', { id: html.id })![1];
  const heading = command<NodeSummary[]>('node', { id: body.id })![1];
  const styles = command<Styles>('styles', { id: heading.id })!;
  // Chromium lists the longhands; jsdom keeps the shorthand.
  assert.ok(styles.inline.some(d => d.name.startsWith('padding') && d.value === '2px'));
  assert.deepEqual(styles.rules.map(rule => [rule.selector, rule.source, rule.media ?? '']), [['h1', '<style>', '@media (min-width:1px)'], ['#title', '<style>', '']]);
  assert.ok(styles.computed.some(([name]) => name === 'display'));
  assert.equal(command('styles', { id: 0 }), null, 'only elements have styles');
});

test('console calls are captured with format specifiers and repeated by sequence; detach restores console', () => {
  const { window, run, command } = page();
  const original = window.console.log;
  run(agentScript());
  run(`console.log('a %s %d%%', 'b', 4.7, {x: 1, y: [1, 'two']}); console.warn(new Error('bad'))`);
  const poll = command<Poll>('poll', { log: 0 })!;
  assert.equal(poll.logs[0].text, 'a b 4% {x: 1, y: (2) [1, "two"]}');
  assert.equal(poll.logs[1].level, 'warn'); assert.match(poll.logs[1].text, /^Error: bad/);
  assert.deepEqual(command<Poll>('poll', { log: poll.logs[1].seq })!.logs, [], 'only newer entries are returned');
  command('clear', 'console');
  assert.deepEqual(command<Poll>('poll', { log: 0 })!.logs, []);
  run(detachScript());
  assert.equal(window.console.log, original);
  assert.equal((window as unknown as Record<string, unknown>)[AGENT_KEY], undefined);
  assert.equal(window.document.querySelector('dsh-browser-devtools-overlay'), null);
});

test('picking swallows the click, selects the element and reports its path from <html>', () => {
  const { window, run, command } = page();
  run(agentScript());
  let clicked = 0;
  const item = window.document.querySelectorAll('li')[1];
  item.addEventListener('click', () => { clicked++; });
  assert.equal(command('pick', { on: true }), true);
  item.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(clicked, 0, 'the page does not see the picking click');
  const poll = command<Poll>('poll')!;
  assert.equal(poll.picking, false);
  assert.equal(poll.picked!.path.length, 4, 'html > body > ul > li');
  assert.equal(command<Poll>('poll')!.picked, undefined, 'a pick is reported once');
  const html = command<NodeSummary[]>('node', { id: 0 })![1];
  assert.equal(poll.picked!.path[0], html.id);
});

test('console input is evaluated as an expression with $0, and errors are returned, not thrown', async () => {
  const { window, run, command } = page();
  run(agentScript());
  const html = command<NodeSummary[]>('node', { id: 0 })![1];
  const body = command<NodeSummary[]>('node', { id: html.id })![1];
  const heading = command<NodeSummary[]>('node', { id: body.id })![1];
  command('select', { id: heading.id });
  assert.deepEqual(await run(evaluateScript('$0.id')), { result: { text: 'title', kind: 'string' } });
  assert.deepEqual(await run(evaluateScript('Promise.resolve([1, 2])')), { result: { text: '(2) [1, 2]', kind: 'object' } });
  assert.deepEqual(await run(evaluateScript('document.querySelector("ul")')), { result: { text: 'ul', kind: 'node' } });
  const failure = await run<Promise<{ error: { kind: string; text: string } }>>(evaluateScript('missing.value'));
  assert.equal(failure.error.kind, 'error'); assert.match(failure.error.text, /missing is not defined/);
  assert.throws(() => run(evaluateScript('let x = 1')), (error: Error) => error.name === 'SyntaxError', 'statements fail to compile, so the panel runs them as a script');
  void window;
});

/** Waits until the response body has been read. */
const settled = async (read: () => RequestDetail | null) => {
  for (let i = 0; i < 100; i++) { const detail = read(); if (detail?.body?.done) return detail; await delay(10); }
  assert.fail('the response body was never read');
};

test('fetch keeps request headers, payload, response headers and a text body; the page still reads its own body', async () => {
  const { window, run, command } = page();
  Object.assign(window, {
    TextDecoder,
    fetch: async () => new Response(JSON.stringify({ ok: true, items: [1, 2] }), { status: 201, statusText: 'Created', headers: { 'Content-Type': 'application/json', 'X-Trace': 'abc' } }),
  });
  run(agentScript());
  const read = await window.eval(`fetch('/api/items?q=1', { method: 'POST', headers: { 'X-Token': 't' }, body: JSON.stringify({ name: 'a' }) }).then(r => r.json())`);
  assert.deepEqual(read, { ok: true, items: [1, 2] });
  const [entry] = command<Poll>('poll')!.network;
  assert.deepEqual([entry.method, entry.url, entry.status], ['POST', 'https://page.test/api/items?q=1', 201]);
  const detail = await settled(() => command<RequestDetail>('request', { seq: entry.seq }));
  assert.equal(detail.statusText, 'Created');
  assert.deepEqual(detail.requestHeaders, [['x-token', 't'], ['content-type', 'text/plain;charset=UTF-8']], 'the browser\'s implicit Content-Type is shown');
  assert.deepEqual(detail.payload, { kind: 'text', text: '{"name":"a"}', truncated: false });
  assert.deepEqual(detail.responseHeaders?.filter(([name]) => name.startsWith('x-')), [['x-trace', 'abc']]);
  assert.deepEqual(detail.body, { text: '{"ok":true,"items":[1,2]}', truncated: false, done: true });
  assert.equal(command('request', { seq: entry.seq + 1 }), null, 'an unknown request has no details');
  command('clear', 'network');
  assert.equal(command('request', { seq: entry.seq }), null, 'clearing the log forgets its details');
});

test('fetch describes form, binary and failed requests without reading binary bodies', async () => {
  const { window, run, command } = page();
  Object.assign(window, {
    TextDecoder,
    fetch: async (input: string) => {
      if (input.includes('fail')) throw new TypeError('Failed to fetch');
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
    },
  });
  run(agentScript());
  await window.eval(`(() => { const form = new FormData(); form.append('name', 'Ada'); form.append('file', new Blob(['x']), 'a.txt'); return fetch('/upload', { method: 'POST', body: form }); })()`);
  await window.eval(`fetch('/fail').catch(() => {})`);
  const [upload, failed] = command<Poll>('poll')!.network;
  const sent = command<RequestDetail>('request', { seq: upload.seq })!;
  assert.deepEqual(sent.payload, { kind: 'form', fields: [['name', 'Ada'], ['file', null]] });
  assert.equal(sent.bodyNote, 'binary'); assert.equal(sent.body, undefined);
  assert.equal(failed.failed, true);
  assert.equal(command<RequestDetail>('request', { seq: failed.seq })!.error, 'Failed to fetch');
});

test('XHR keeps headers set with setRequestHeader, the body sent and the response text', async t => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Echo', 'X-Echo': req.headers['content-type'] ?? '' });
      res.end(`got ${body}`);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const { window, run, command } = page();
  run(agentScript());
  await window.eval(`new Promise(done => { const xhr = new XMLHttpRequest(); xhr.open('post', 'http://127.0.0.1:${port}/echo'); xhr.setRequestHeader('Content-Type', 'text/plain'); xhr.onloadend = done; xhr.send('a=1'); })`);
  const [entry] = command<Poll>('poll')!.network;
  assert.deepEqual([entry.type, entry.method, entry.status], ['xhr', 'POST', 200]);
  const detail = command<RequestDetail>('request', { seq: entry.seq })!;
  assert.deepEqual(detail.requestHeaders, [['content-type', 'text/plain']]);
  assert.deepEqual(detail.payload, { kind: 'text', text: 'a=1', truncated: false });
  assert.deepEqual(detail.responseHeaders?.find(([name]) => name === 'x-echo'), ['x-echo', 'text/plain']);
  assert.deepEqual(detail.body, { text: 'got a=1', truncated: false, done: true });
});

test('a page without TextDecoder still records the response text', async () => {
  const { window, run, command } = page();
  Object.assign(window, { fetch: async () => new Response('plain text') });
  run(agentScript());
  assert.equal(await window.eval(`fetch('/text').then(r => r.text())`), 'plain text');
  const [entry] = command<Poll>('poll')!.network;
  assert.equal((await settled(() => command<RequestDetail>('request', { seq: entry.seq }))).body?.text, 'plain text');
});

test('a long backlog is polled in bounded batches, and release stops picking without detaching', () => {
  const { window, run, command } = page();
  run(agentScript());
  window.eval(`for (let i = 0; i < 400; i++) console.log(String(i).padEnd(1000, '.'))`);
  let since = 0, polls = 0, seen = 0;
  for (;;) {
    const { logs } = command<Poll>('poll', { log: since })!;
    if (!logs.length) break;
    assert.ok(JSON.stringify(logs).length < 200_000, 'each batch stays well under the reply limit');
    seen += logs.length; since = logs.at(-1)!.seq; polls++;
  }
  assert.equal(seen, 400); assert.ok(polls > 1);
  command('pick', { on: true });
  assert.equal(command<Poll>('poll')!.picking, true);
  assert.equal(command('release'), true);
  assert.equal(command<Poll>('poll')!.picking, false);
  assert.ok((window as unknown as Record<string, unknown>)[AGENT_KEY], 'the agent keeps recording');
});
