import { CLIENT_HEADER, type Asset, type ScanResult, type ScannedAsset } from './domain.js';
import { AssetError, parseRules, type AssetService } from './service.js';

/** Room for a selection of thousands of paths. */
const BODY_LIMIT = 2 * 1024 * 1024;
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new AssetError(`Invalid ${label}`);
  return value;
};

/** A scan as the client lists it; references are asked for one image at a time. */
const summary = (scan: ScanResult<ScannedAsset>): ScanResult => ({ ...scan, assets: scan.assets.map(({ refs: _refs, ...asset }): Asset => asset) });

/**
 * `GET ?sessionId&path` answers an image's bytes; `POST` takes a JSON `action`: `scan`, `detail` and `configure` read a workspace;
 * `retire`, `restore`, `tag` and `note` change it (see manage.ts);
 * `project`, `setProject`, `mode` and `setMode` decide where the tab appears. */
export function createHandler(service: AssetService, log?: (message: string) => void) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (request.headers.get(CLIENT_HEADER) !== '1') throw new AssetError('Open assets from the DSH Assets tab', 403);
      if (request.method === 'GET') {
        const query = new URL(request.url).searchParams;
        const data = await service.raw(text(query.get('sessionId'), 'session ID'), text(query.get('path'), 'file path'));
        // The client makes typed blobs itself; served bytes never render, so an SVG cannot run script here.
        return new Response(new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.length), { headers: { ...headers, 'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
      }
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AssetError('Requests must be JSON', 415);
      const body = await request.text();
      if (Buffer.byteLength(body) > BODY_LIMIT) throw new AssetError('The request is too large', 413);
      let input: Record<string, unknown>;
      try { input = JSON.parse(body); } catch { throw new AssetError('Requests must be JSON'); }
      if (!input || typeof input !== 'object') throw new AssetError('Requests must be JSON');
      if (input.action === 'mode') return Response.json({ mode: await service.mode() }, { headers });
      if (input.action === 'setMode') {
        if (input.mode !== 'games' && input.mode !== 'all') throw new AssetError('Invalid tab setting');
        return Response.json({ mode: await service.setMode(input.mode) }, { headers });
      }
      const sessionId = text(input.sessionId, 'session ID');
      switch (input.action) {
        case 'project': return Response.json(await service.project(sessionId), { headers });
        case 'setProject':
          if (input.game !== null && typeof input.game !== 'boolean') throw new AssetError('Invalid tab setting');
          return Response.json(await service.setProject(sessionId, input.game), { headers });
        case 'scan': return Response.json(summary(await service.scan(sessionId, input.refresh === true)), { headers });
        case 'detail': return Response.json(await service.detail(sessionId, text(input.path, 'file path')), { headers });
        case 'configure': return Response.json(summary(await service.configure(sessionId, parseRules(input.folders), input.retireDir)), { headers });
        case 'retire': case 'restore': {
          const result = await (input.action === 'retire' ? service.retire(sessionId, input.paths) : service.restore(sessionId, input.paths));
          return Response.json({ ...result, scan: summary(result.scan) }, { headers });
        }
        case 'tag': return Response.json(await service.tag(sessionId, input.paths, input.add, input.remove), { headers });
        case 'note': return Response.json(await service.note(sessionId, input.path, input.note), { headers });
        default: throw new AssetError('Unknown assets action');
      }
    } catch (error) {
      if (error instanceof AssetError) return Response.json({ error: error.message }, { status: error.status, headers });
      log?.(`Game assets request failed: ${String(error)}`);
      return Response.json({ error: 'The workspace could not be scanned' }, { status: 500, headers });
    }
  };
}
