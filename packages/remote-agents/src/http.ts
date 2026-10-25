import { cursorInput, field, identifier, record, remotePath, RemoteError } from './domain.js';
import type { RemoteAgentsService } from './service.js';

export function createHandler(service: RemoteAgentsService) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (request.method === 'GET') return Response.json(service.snapshot(), { headers });
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
      if (request.headers.get('X-DSH-Remote-Agents') !== '1' || !request.headers.get('content-type')?.startsWith('application/json')) throw new RemoteError('Use the remote task client to submit requests', 403);
      if (Number(request.headers.get('content-length')) > 256_000) throw new RemoteError('Request is too large', 413);
      const text = await request.text();
      if (Buffer.byteLength(text) > 256_000) throw new RemoteError('Request is too large', 413);
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new RemoteError('Request must be valid JSON'); }
      const input = record(raw), action = field(input.action, 'action', 50);
      const hostId = () => identifier(input.hostId), taskId = () => identifier(input.taskId);
      let result: unknown;
      switch (action) {
        case 'addHost': result = await service.addHost(input.host); break;
        case 'removeHost': result = await service.removeHost(hostId()); break;
        case 'connect': result = await service.connect(hostId()); break;
        case 'workspaces': result = await service.workspaces(hostId()); break;
        case 'providers': result = await service.providers(hostId(), remotePath(input.cwd), input.refresh === true); break;
        case 'create': result = await service.create(input.task); break;
        case 'retry': result = await service.retry(taskId()); break;
        case 'task': {
          if (input.direction !== undefined && input.direction !== 'before' && input.direction !== 'after') throw new RemoteError('Invalid timeline direction');
          result = await service.detail(taskId(), cursorInput(input.cursor), input.direction); break;
        }
        case 'send': result = await service.send(taskId(), input.message); break;
        case 'stop': await service.stop(taskId()); result = { ok: true }; break;
        case 'respond': await service.respond(taskId(), field(input.requestId, 'permission request', 500), input.answer); result = { ok: true }; break;
        default: throw new RemoteError('Unknown remote task action');
      }
      return Response.json(result, { headers });
    } catch (error) {
      // Service errors have already had saved secrets removed.
      return Response.json({ error: error instanceof Error ? error.message : 'Remote task request failed' }, { status: error instanceof RemoteError ? error.status : 502, headers });
    }
  };
}
