import { FileError, TEXT_LIMIT, type LocalFiles } from './files.js';

/** Sent by the client; links, forms and images from other pages cannot add it. */
export const CLIENT_HEADER = 'X-DSH-File-Editor';
// A UTF-8 byte may become six JSON bytes (for example U+0001 becomes \u0001).
// Leave room for escaped paths and metadata as well; decoded text has its own limit.
const BODY_LIMIT = TEXT_LIMIT * 6 + 64 * 1024;
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new FileError(`Invalid ${label}`);
  return value;
};

export function createHandler(files: LocalFiles, log?: (message: string) => void) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (request.headers.get(CLIENT_HEADER) !== '1') throw new FileError('Open files from the DSH file editor', 403);
      if (request.method === 'GET') {
        const query = new URL(request.url).searchParams;
        const data = await files.raw(text(query.get('sessionId'), 'session ID'), text(query.get('path'), 'file path'));
        // The client makes typed blobs itself; served bytes never render, so an SVG cannot run script here.
        return new Response(new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.length), { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
      }
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new FileError('Requests must be JSON', 415);
      if (Number(request.headers.get('content-length')) > BODY_LIMIT) throw new FileError('The file exceeds the 4 MB editor limit', 413);
      const body = await request.text();
      if (Buffer.byteLength(body) > BODY_LIMIT) throw new FileError('The file exceeds the 4 MB editor limit', 413);
      let input: Record<string, unknown>;
      try { input = JSON.parse(body); } catch { throw new FileError('Requests must be JSON'); }
      if (!input || typeof input !== 'object') throw new FileError('Requests must be JSON');
      const sessionId = text(input.sessionId, 'session ID'), path = text(input.path, 'file path');
      switch (input.action) {
        case 'read': return Response.json(await files.read(sessionId, path), { headers });
        case 'stat': return Response.json(await files.stat(sessionId, path), { headers });
        case 'write':
          if (typeof input.content !== 'string') throw new FileError('Invalid file contents');
          return Response.json(await files.write(sessionId, path, input.content, text(input.revision, 'file revision')), { headers });
        default: throw new FileError('Unknown file action');
      }
    } catch (error) {
      if (error instanceof FileError) return Response.json({ error: error.message }, { status: error.status, headers });
      log?.(`File editor request failed: ${String(error)}`);
      return Response.json({ error: 'The file could not be read or saved' }, { status: 500, headers });
    }
  };
}
