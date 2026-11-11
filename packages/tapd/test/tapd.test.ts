import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, type TapdSettings } from '../src/settings.js';
import { descriptionText, imageSources, parseBugs, statusField, statusQuery, TapdClient } from '../src/tapd.js';

const settings = (change: Partial<TapdSettings> = {}): TapdSettings => ({ ...defaultSettings(), auth: { kind: 'bearer', token: 'secret-token' }, owner: 'me', workspaces: [{ id: '100', name: 'Dana' }, { id: '200', name: 'Rooh' }], ...change });
function fake(answer: (url: URL, init: RequestInit) => unknown | Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const result = answer(url, init);
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch;
  return { calls, fetcher };
}
const bug = (id: string, workspace: string, more: Record<string, unknown> = {}) => ({ Bug: { id, workspace_id: workspace, title: `bug ${id}`, status: 'new', current_owner: 'me;', ...more } });

test('the owner\'s bugs come from every TAPD project, page by page, in the chosen statuses', async () => {
  const { calls, fetcher } = fake(url => {
    const workspace = url.searchParams.get('workspace_id'), page = Number(url.searchParams.get('page'));
    if (workspace === '100') return { status: 1, data: page === 1 ? Array.from({ length: 100 }, (_, index) => bug(String(index + 1), '100')) : [bug('101', '100', { label: 'ui;h5', module: 'pay', priority: 'high' })] };
    return { status: 1, data: [{ id: '7', workspace_id: '200', name: 'flat shape' }] };
  });
  const bugs = await new TapdClient(() => settings({ statuses: ['new', '待处理', 'reopened'] }), fetcher).listBugs();
  assert.equal(bugs.length, 102);
  assert.deepEqual(bugs[100], { id: '101', workspaceId: '100', title: 'bug 101', description: '', owner: 'me;', status: 'new', labels: ['ui', 'h5'], module: 'pay', priority: 'high' });
  assert.equal(bugs[101].title, 'flat shape');
  assert.deepEqual(calls.map(call => `${call.url.searchParams.get('workspace_id')}/${call.url.searchParams.get('page')}`), ['100/1', '100/2', '200/1']);
  const first = calls[0];
  assert.equal(first.url.origin + first.url.pathname, 'https://api.tapd.cn/bugs');
  assert.equal(first.url.searchParams.get('current_owner'), 'me');
  assert.equal(first.url.searchParams.get('status'), 'new|reopened', 'API values win over shown names');
  assert.equal((first.init.headers as Record<string, string>).Authorization, 'Bearer secret-token');
});

test('statuses are sent under the name TAPD knows them by', () => {
  assert.deepEqual(statusQuery(['待处理', '重新打开']), { v_status: '待处理|重新打开' });
  assert.deepEqual(statusQuery([]), {});
  assert.deepEqual(statusField('resolved'), { status: 'resolved' });
  assert.deepEqual(statusField('已解决'), { v_status: '已解决' });
});

test('a status and a comment are written as a form, with basic sign-in when that is configured', async () => {
  const { calls, fetcher } = fake(() => ({ status: 1, data: {} }));
  const client = new TapdClient(() => settings({ auth: { kind: 'basic', user: 'api', token: 'pw' } }), fetcher);
  await client.update({ id: '9', workspaceId: '100' }, { status: '已解决', comment: 'fixed in abc' });
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[0].init.body))), { workspace_id: '100', id: '9', v_status: '已解决', comment: 'fixed in abc' });
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('api:pw').toString('base64')}`);
});

test('what TAPD refuses is said in its own words, and a missing sign-in before any request', async () => {
  const refused = fake(() => ({ status: 0, info: 'no permission' }));
  await assert.rejects(new TapdClient(() => settings(), refused.fetcher).listBugs(), /TAPD refused the request: no permission/);
  const html = fake(() => new Response('<html>login</html>', { status: 401 }));
  await assert.rejects(new TapdClient(() => settings(), html.fetcher).getBug('100', '1'), /401 without JSON: check the access token/);
  const none = fake(() => ({ status: 1, data: [] }));
  await assert.rejects(new TapdClient(() => settings({ auth: { kind: 'bearer', token: '' } }), none.fetcher).listBugs(), /not signed in/);
  await assert.rejects(new TapdClient(() => settings({ owner: '' }), none.fetcher).listBugs(), /whose bugs/);
  assert.equal(none.calls.length, 0);
  assert.deepEqual(parseBugs({ data: 'nope' }), []);
});

test('a description reads as text with its pictures numbered, and pictures are fetched from where TAPD keeps them', async () => {
  const html = '<p>点击&nbsp;“充值” 后页面白屏</p><div>步骤：<br/>1. 打开 &lt;活动页&gt;</div><img src="/tfl/pictures/a.png?x=1&amp;y=2"><p>期望：正常</p><img src=\'https://cdn.example.com/b.jpg\' /><img src="data:image/png;base64,AAAA">';
  assert.deepEqual(imageSources(html), ['/tfl/pictures/a.png?x=1&y=2', 'https://cdn.example.com/b.jpg']);
  assert.equal(descriptionText(html), '点击 “充值” 后页面白屏\n步骤：\n1. 打开 <活动页>\n [image 1] 期望：正常\n [image 2]');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  const { calls, fetcher } = fake(url => url.hostname === 'cdn.example.com' ? new Response('not an image', { headers: { 'content-type': 'text/html' } }) : new Response(png, { headers: { 'content-type': 'application/octet-stream' } }));
  const client = new TapdClient(() => settings(), fetcher);
  const image = await client.image('/tfl/pictures/a.png?x=1&y=2');
  assert.deepEqual([image?.mediaType, image?.extension, image?.bytes.length], ['image/png', 'png', 16]);
  assert.equal(calls[0].url.href, 'https://www.tapd.cn/tfl/pictures/a.png?x=1&y=2');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer secret-token');
  assert.equal(await client.image('https://cdn.example.com/b.jpg'), undefined);
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, undefined, 'the token never leaves TAPD\'s hosts');
});
