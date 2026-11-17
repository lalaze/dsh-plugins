import { messageOf } from './domain.js';
import { decodePictures } from './pictures.js';
import type { AutofixService } from './service.js';
import type { Tasks } from './tasks.js';

export { API_PATH } from './shared.js';
/** `<source>:<the bug's ID there>`. */
const key = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 300 || !/^[a-z][a-z0-9-]{0,30}:.+$/u.test(value)) throw new Error('The bug is missing');
  return value;
};

/** One JSON route for the board and the settings page. Only pages of this DSH reach it, and only with the plugin's own header. */
export function createHandler(service: AutofixService, tasks: Tasks, chat: { lastCommand(): string | undefined } = { lastCommand: () => undefined }) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
      if (request.headers.get('X-DSH-Autofix') !== '1' || !request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'Use the Autofix board.' }, { status: 403, headers });
      const input = await request.json() as Record<string, unknown>;
      let result: unknown = {};
      switch (input.action) {
        case 'state': break;
        // A card in a conversation follows one task; the settings come along for the words it needs.
        case 'task': return Response.json({ task: service.task(key(input.key)) ?? null, routes: service.state().settings.routes }, { headers });
        case 'lastCommand': return Response.json({ sessionId: chat.lastCommand() ?? null }, { headers });
        // What one step of the task's flow said in full, asked for when its line in the card is opened.
        case 'stepBody': return Response.json({ body: Number.isSafeInteger(input.index) ? tasks.stepBody(key(input.key), input.index as number) ?? null : null }, { headers });
        case 'saveSettings': await service.saveSettings(input.settings); break;
        // With the repositories whose folder is no longer a workspace of this DSH, for the settings page to point out.
        case 'projects': { const [projects, missing] = await Promise.all([service.projects(request.signal), service.missingProjects(request.signal)]); result = { projects, missing }; break; }
        case 'addFolder': result = await service.addFolder(input.path, request.signal); break;
        case 'project': result = await service.project(String(input.path ?? ''), Array.isArray(input.globs) ? input.globs.map(String) : [], request.signal); break;
        case 'fetch': result = await service.fetch(typeof input.source === 'string' ? input.source : undefined); break;
        case 'assign': await service.assign(key(input.key), input.assignment === null ? null : (input.assignment ?? {}) as Record<string, unknown>); break;
        case 'dismiss': await service.dismiss(key(input.key), input.dismissed !== false); break;
        case 'discard': await service.discard(key(input.key)); break;
        case 'createManual': result = await service.createManual(input.bug && typeof input.bug === 'object' ? input.bug as Record<string, unknown> : {}); break;
        case 'start': await tasks.start(key(input.key)); break;
        case 'stop': result = { stopped: tasks.stop(key(input.key)) }; break;
        case 'sendBack': await tasks.sendBack(key(input.key), typeof input.feedback === 'string' ? input.feedback.slice(0, 8000) : '', decodePictures(input.images)); break;
        case 'accept': await tasks.accept(key(input.key)); break;
        case 'retryReport': await tasks.retryReport(key(input.key)); break;
        case 'removeWorkspace': await tasks.removeWorkspace(key(input.key)); break;
        case 'forget': await tasks.forget(key(input.key)); break;
        case 'diff': return Response.json(await service.diff(key(input.key), request.signal), { headers });
        default: return Response.json({ error: 'Unknown action' }, { status: 400, headers });
      }
      return Response.json({ ...(result as object), state: service.state() }, { headers });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Request failed', said: messageOf(error), state: service.state() }, { status: 400, headers });
    }
  };
}
