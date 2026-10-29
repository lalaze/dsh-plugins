import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatImageLinks, imagePathOf, saveChatImage } from '../src/chat/images.js';

test('only workspace image paths are copied; URLs, anchors and other files stay as written', () => {
  assert.equal(imagePathOf('.dsh/shots/a.png'), '.dsh/shots/a.png');
  assert.equal(imagePathOf('/srv/project/A%20B.JPG?raw=1'), '/srv/project/A B.JPG');
  assert.equal(imagePathOf('<shots/with space.webp>'), 'shots/with space.webp');
  for (const value of ['https://example.com/a.png', 'data:image/png;base64,AA', '//cdn/a.png', '#a.png', 'notes.txt', 'bad%zz.png']) assert.equal(imagePathOf(value), undefined, value);
});

test('streamed images are held until complete, then point at local copies', async () => {
  const asked: string[] = [];
  const links = new ChatImageLinks(async path => { asked.push(path); return path === 'missing.png' ? undefined : `C:\\cache\\${path}`; });
  let out = '';
  for (const delta of ['Before\n!', '[Shot](shots/a', '.png "Title")', ' and ![Again](shots/a.png) ![Gone](missing.png) ![Web](https://x/y.png)', ' tail ![par']) out += await links.push(delta);
  assert.equal(out, 'Before\n![Shot](<C:/cache/shots/a.png> "Title") and ![Again](<C:/cache/shots/a.png>) ![Gone](missing.png) ![Web](https://x/y.png) tail ');
  assert.equal(links.flush(), '![par', 'an unfinished image is released as written');
  assert.deepEqual(asked, ['shots/a.png', 'missing.png'], 'each path is fetched once');
  assert.equal(await links.push('Line ![not an image\nnext'), 'Line ![not an image\nnext');
});

test('a failed fetch leaves the image as written', async () => {
  const links = new ChatImageLinks(async () => { throw new Error('outside the workspace'); });
  assert.equal(await links.push('![x](../secret.png)'), '![x](../secret.png)');
});

test('saved images are content-addressed and reused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-images-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await saveChatImage(dir, 'a/Shot.PNG', Buffer.from('png'));
  assert.equal(await saveChatImage(dir, 'b/other.png', Buffer.from('png')), first);
  assert.match(first, /[0-9a-f]{64}\.png$/); assert.equal(await readFile(first, 'utf8'), 'png');
  assert.deepEqual(await readdir(dir), [first.slice(dir.length + 1)]);
});
