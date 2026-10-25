import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BingService, createGalleryHandler, parseBingFeed } from '../src/bing.js';
import { MAX_IMAGE_BYTES } from '../src/domain.js';
import { apply } from '../src/index.js';

const id = 'OHR.Mountain_ZH-CN1234567890_1920x1080.jpg';
const row = { startdate: '20261023', url: `/th?id=${id}&rf=LaDigue_1920x1080.jpg`, title: '山间秋色', copyright: '© Test photographer', copyrightlink: 'https://www.bing.com/search?q=mountains' };
const feed = { images: [row] };
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
test('Bing feed is normalized, sorted and limited to fixed Bing image/attribution endpoints', () => {
  const entries = parseBingFeed({ images: [{ ...row, startdate: '20261022' }, row] }, 'zh-CN');
  assert.equal(entries[0].date, '2026-10-23'); assert.equal(entries[0].id, id); assert.equal(entries[0].market, 'zh-CN');
  for (const invalid of [
    { images: [] }, { images: [{ ...row, url: 'https://evil.test/th?id=' + id }] },
    { images: [{ ...row, url: '/th?id=../../etc/passwd' }] },
    { images: [{ ...row, copyrightlink: 'javascript:alert(1)' }] },
    { images: [{ ...row, startdate: 'tomorrow' }] },
    { images: [{ ...row, url: 'https://user@www.bing.com/th?id=' + id }] },
  ]) assert.throws(() => parseBingFeed(invalid, 'zh-CN'));
});
test('concurrent feed reads share one upstream request, cache for an hour and retry after failure', async () => {
  let count = 0; let now = 10_000; let fail = false;
  const service = new BingService(async input => {
    count++; const url = new URL(String(input));
    assert.equal(url.origin, 'https://www.bing.com'); assert.equal(url.searchParams.get('n'), '8');
    assert.equal(url.searchParams.get('mkt'), 'zh-CN');
    if (fail) return new Response(null, { status: 503 });
    return Response.json(feed);
  }, () => now);
  const values = await Promise.all([service.feed('zh-CN'), service.feed('zh-CN')]);
  assert.deepEqual(values[0], values[1]); assert.equal(count, 1);
  await service.feed('zh-CN'); assert.equal(count, 1);
  now += 3_600_001; fail = true; await assert.rejects(service.feed('zh-CN'), /503/);
  fail = false; await service.feed('zh-CN'); assert.equal(count, 3);
  await assert.rejects(service.feed('unknown'), /region/); assert.equal(count, 3);
});
test('image proxy validates bytes, bounds streamed bodies and prevents redirect/proxy injection', async () => {
  let calls = 0;
  const service = new BingService(async (input, options) => {
    calls++; assert.equal(String(input), `https://www.bing.com/th?id=${id}`);
    assert.equal(options?.redirect, 'error'); assert.ok(options?.signal);
    return new Response(jpeg);
  });
  assert.deepEqual(await service.image(id), jpeg);
  for (const invalid of ['https://evil.test/a.jpg', '../secret', `${id}&url=http://localhost`, 'OHR.bad.svg']) await assert.rejects(service.image(invalid), /ID/);
  assert.equal(calls, 1);
  await assert.rejects(new BingService(async () => new Response('<html>bad</html>')).image(id), /JPEG/);
  let cancelled = false;
  const oversized = new BingService(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(oversized.image(id), /10 MB/); assert.equal(cancelled, true);
  await assert.rejects(new BingService(async () => new Response(jpeg, { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } })).image(id), /10 MB/);
});
test('authenticated host fetch registration covers only gallery routes; handler reports actionable HTTP errors', async () => {
  const routes: { path: string; methods: string[] }[] = [];
  apply({ connection: { fetch: { register(spec: { path: string; methods: string[] }) { routes.push(spec); } } } } as never);
  assert.deepEqual(routes.map(r => [r.path, r.methods]), [['/api/gallery/bing', ['GET']], ['/api/gallery/image', ['GET']]]);
  const handler = createGalleryHandler(new BingService(async input => String(input).includes('HPImageArchive') ? Response.json(feed) : new Response(jpeg)));
  const request = (path: string, init?: RequestInit) => handler(new Request(`http://dsh.test${path}`, init));
  const catalog = await request('/api/gallery/bing'); assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).entries[0].title, row.title);
  const image = await request(`/api/gallery/image?id=${id}`); assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), jpeg);
  assert.equal((await request('/api/gallery/image?id=evil')).status, 400);
  assert.equal((await request('/api/gallery/bing?market=evil')).status, 400);
  assert.equal((await request('/api/gallery/bing', { method: 'POST' })).status, 405);
  assert.equal((await request('/other')).status, 404);
  const failed = createGalleryHandler(new BingService(async () => { throw new Error('Bing unavailable'); }));
  const error = await failed(new Request('http://dsh.test/api/gallery/bing'));
  assert.equal(error.status, 502); assert.equal((await error.json()).error, 'Bing unavailable');
});
