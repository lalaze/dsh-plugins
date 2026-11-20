import { CLIENT_HEADER } from './domain.js';
import type { ProjectStatusService } from './service.js';
import { StatusError } from './store.js';

/** A field of a few thousand characters and the text it replaces, with room to spare. */
const BODY_LIMIT = 256 * 1024;
const sessionOf = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 512) throw new StatusError('Invalid session ID');
  return value;
};

/** `POST` takes a JSON `action`: `get` reads the status of a conversation's project, `save` writes one of its fields. */
export function createHandler(service: ProjectStatusService, log?: (message: string) => void) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (request.headers.get(CLIENT_HEADER) !== '1') throw new StatusError('Open the status from the DSH Status tab', 403);
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new StatusError('Requests must be JSON', 415);
      const body = await request.text();
      if (Buffer.byteLength(body) > BODY_LIMIT) throw new StatusError('The request is too large', 413);
      let input: Record<string, unknown>;
      try { input = JSON.parse(body); } catch { throw new StatusError('Requests must be JSON'); }
      if (!input || typeof input !== 'object') throw new StatusError('Requests must be JSON');
      const sessionId = sessionOf(input.sessionId);
      switch (input.action) {
        case 'get': return Response.json(await service.get(sessionId, request.signal), { headers });
        case 'save': return Response.json(await service.save(sessionId, input.field, input.value, input.was, input.language, request.signal), { headers });
        default: throw new StatusError('Unknown status action');
      }
    } catch (error) {
      if (error instanceof StatusError) return Response.json({ error: error.message }, { status: error.status, headers });
      log?.(`Project status request failed: ${String(error)}`);
      return Response.json({ error: 'The status could not be read' }, { status: 500, headers });
    }
  };
}
