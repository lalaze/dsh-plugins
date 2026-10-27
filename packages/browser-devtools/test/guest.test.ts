import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { AGENT_KEY, agentScript, commandScript, detachScript, evaluateScript, type NodeSummary, type Poll, type Styles } from '../src/client/guest.js';

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
