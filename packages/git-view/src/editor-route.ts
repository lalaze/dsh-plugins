import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

/**
 * Serves the code editor bundle that the build writes next to the server entry. The browser loads it as a module the
 * first time an editor opens and revalidates it after that; browsers that accept gzip get it compressed.
 */
export function editorHandler(file: URL) {
  let bundle: Promise<{ raw: Buffer; gzipped: Buffer; etag: string }> | undefined;
  const load = () => bundle ??= readFile(file).then(async raw => ({
    raw, gzipped: await promisify(gzip)(raw), etag: `"${createHash('sha256').update(raw).digest('base64url').slice(0, 32)}"`,
  })).catch(error => { bundle = undefined; throw error; });
  return async (request: Request): Promise<Response> => {
    let loaded;
    try { loaded = await load(); } catch { return new Response('The code editor is not built', { status: 404, headers: { 'Cache-Control': 'no-store' } }); }
    const headers = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ETag: loaded.etag, Vary: 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff' };
    if (request.headers.get('if-none-match') === loaded.etag) return new Response(null, { status: 304, headers });
    const compressed = /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '');
    const body = compressed ? loaded.gzipped : loaded.raw;
    return new Response(new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.length), { headers: compressed ? { ...headers, 'Content-Encoding': 'gzip' } : headers });
  };
}
