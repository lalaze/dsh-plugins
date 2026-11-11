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
/** Tasks another DSH runs, reached through a workspace of this one. */
export interface Remote {
  task(at: string, key: string): Promise<{ task: unknown; route: unknown } | undefined>;
  diff(at: string, key: string): Promise<unknown>;
  act(at: string, ask: { kind: 'sendBack'; key: string; feedback: string } | { kind: 'accept' | 'stop' | 'retryReport'; key: string }, pictures?: ReturnType<typeof decodePictures>): Promise<void>;
}
export function createHandler(service: AutofixService, tasks: Tasks, chat: { lastCommand(): string | undefined } = { lastCommand: () => undefined }, remote?: Remote) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
      if (request.headers.get('X-DSH-Autofix') !== '1' || !request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'Use the Autofix board.' }, { status: 403, headers });
      const input = await request.json() as Record<string, unknown>;
      let result: unknown = {};
      // A card that follows a task of another DSH names the workspace it reaches that DSH through.
      const at = typeof input.at === 'string' && input.at.length <= 4096 ? input.at : '';
      if (at) {
        if (!remote) return Response.json({ error: 'Handing bugs to another DSH is not available.' }, { status: 400, headers });
        switch (input.action) {
          case 'task': { const found = await remote.task(at, key(input.key)); return Response.json({ task: found?.task ?? null, routes: found ? [found.route] : [] }, { headers }); }
          case 'diff': return Response.json(await remote.diff(at, key(input.key)), { headers });
          case 'sendBack': await remote.act(at, { kind: 'sendBack', key: key(input.key), feedback: typeof input.feedback === 'string' ? input.feedback.slice(0, 8000) : '' }, decodePictures(input.images)); break;
          case 'accept': case 'stop': case 'retryReport': await remote.act(at, { kind: input.action, key: key(input.key) }); break;
          default: return Response.json({ error: 'Unknown action' }, { status: 400, headers });
        }
        return Response.json({}, { headers });
      }
      switch (input.action) {
        case 'state': break;
        // A card in a conversation follows one task; the settings come along for the words it needs.
        case 'task': return Response.json({ task: service.task(key(input.key)) ?? null, routes: service.state().settings.routes }, { headers });
        case 'lastCommand': return Response.json({ sessionId: chat.lastCommand() ?? null }, { headers });
        case 'saveSettings': await service.saveSettings(input.settings); break;
        case 'projects': result = { projects: await service.projects(request.signal) }; break;
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
