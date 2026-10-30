import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { editorHandler } from '../src/editor-route.js';

test('the editor bundle is served as a module, gzipped when accepted, and revalidated by its ETag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-file-editor-bundle-'));
  try {
    const file = join(directory, 'editor.js');
    const missing = await editorHandler(pathToFileURL(file))(new Request('http://dsh.test/api/file-editor/editor.js'));
    assert.equal(missing.status, 404, 'an unbuilt bundle is missing');
    await writeFile(file, 'export const editor = {};\n');
    const handler = editorHandler(pathToFileURL(file));
    const plain = await handler(new Request('http://dsh.test/api/file-editor/editor.js'));
    assert.equal(plain.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(await plain.text(), 'export const editor = {};\n');
    const zipped = await handler(new Request('http://dsh.test/api/file-editor/editor.js', { headers: { 'accept-encoding': 'gzip, deflate, br' } }));
    assert.equal(zipped.headers.get('content-encoding'), 'gzip');
    assert.equal(gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString(), 'export const editor = {};\n');
    const etag = plain.headers.get('etag')!;
    const cached = await handler(new Request('http://dsh.test/api/file-editor/editor.js', { headers: { 'if-none-match': etag } }));
    assert.equal(cached.status, 304);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
