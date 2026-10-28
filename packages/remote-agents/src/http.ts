import { browsePath, cursorInput, field, identifier, PROVIDER_LABELS, record, remotePath, RemoteError, taskInput } from './domain.js';
import type { RemoteAgentsService } from './service.js';
import { ChatProjects } from './chat-projects.js';
import type { WorkspacePlacement } from './workspace-access.js';
import type { RemoteWorkspaces } from './remote-workspaces.js';
import { workspaceAction, type WorkspaceFeatures } from './workspace-http.js';

export function createHandler(service: RemoteAgentsService, projects = new ChatProjects(service), workspace?: (sessionId: string, signal: AbortSignal) => Promise<WorkspacePlacement>, workspaces?: Pick<RemoteWorkspaces, 'create'>, features?: WorkspaceFeatures) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (request.method === 'GET') return Response.json(await service.snapshot(), { headers });
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
      if (request.headers.get('X-DSH-Remote-Agents') !== '1' || !request.headers.get('content-type')?.startsWith('application/json')) throw new RemoteError('Use the remote agents client to submit requests', 403);
      if (Number(request.headers.get('content-length')) > 2_000_000) throw new RemoteError('Request is too large', 413);
      const text = await request.text();
      if (Buffer.byteLength(text) > 2_000_000) throw new RemoteError('Request is too large', 413);
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new RemoteError('Request must be valid JSON'); }
      const input = record(raw), action = field(input.action, 'action', 50);
      const hostId = () => identifier(input.hostId), agentId = () => identifier(input.agentId);
      let result: unknown;
      switch (action) {
        case 'legacyMachines': case 'importLegacyMachine': case 'workspaceTarget': case 'workspaceFiles': case 'workspaceSync':
        case 'workspaceTunnels': case 'addWorkspaceTunnel': case 'startWorkspaceTunnel': case 'stopWorkspaceTunnel': case 'removeWorkspaceTunnel': {
          if (!features) throw new RemoteError('Remote workspaces are unavailable', 501);
          result = await workspaceAction(features, action, input, request.signal); break;
        }
        case 'workspaceModels': result = workspace ? await workspace(field(input.sessionId, 'session ID', 256), request.signal) : { hostIds: [] }; break;
        case 'hostCatalogs': result = projects.hosts(); break;
        case 'usage': {
          const route = input.model === undefined ? undefined : field(input.model, 'model', 1000);
          const [projectId, cli] = route?.split('/') ?? [], project = projects.routes().find(p => p.id === projectId);
          let provider: string | undefined;
          try { provider = cli === undefined ? undefined : decodeURIComponent(cli); } catch { provider = undefined; }
          const target = project && provider && Object.hasOwn(PROVIDER_LABELS, provider) ? { hostId: project.hostId, provider } : undefined;
          result = await service.usage(field(input.sessionId, 'session ID', 256), { route, target, account: input.account === true, refresh: input.refresh === true }); break;
        }
        case 'discoverHost': result = await service.discoverHost(hostId()); break;
        case 'setHostProviders': result = await service.setHostProviders(hostId(), input.providers); break;
        case 'chatProjects': result = projects.list(); break;
        case 'addChatProject': result = await projects.add(input.project); break;
        case 'refreshChatProject': result = await projects.refresh(identifier(input.projectId)); break;
        case 'removeChatProject': result = await projects.remove(identifier(input.projectId)); break;
        case 'sshConfig': result = await service.sshConfig(); break;
        case 'addHost': result = await service.addHost(input.host, { discoverModels: true }); break;
        case 'removeHost': {
          const id = hostId(); result = await service.removeHost(id, { deleteAgents: input.deleteAgents === true });
          await features?.tunnels.removeHost(id); break;
        }
        case 'connect': result = await service.connect(hostId()); break;
        case 'browse': result = await service.browse(hostId(), input.path === undefined ? undefined : browsePath(input.path)); break;
        case 'createWorkspace': {
          if (!workspaces) throw new RemoteError('Remote workspaces are unavailable', 501);
          result = await workspaces.create(hostId(), browsePath(input.path), request.signal); break;
        }
        case 'providers': result = await service.providers(hostId(), remotePath(input.cwd), input.refresh === true); break;
        case 'create': result = await service.create(input.agent, input.title === undefined ? {} : { title: field(input.title, 'title', 100) }); break;
        case 'createWorkspaceSession': {
          if (!workspace) throw new RemoteError('Remote workspaces are unavailable', 501);
          const sessionId = field(input.sessionId, 'session ID', 256), agent = taskInput(input.agent);
          const beforeStart = async () => {
            request.signal.throwIfAborted();
            const placement = await workspace(sessionId, request.signal);
            if (!placement.hostIds.includes(agent.hostId) || !placement.cwd || placement.cwd !== agent.cwd) {
              throw new RemoteError('This remote model does not belong to the current workspace machine. Select a matching workspace and model.', 409);
            }
          };
          await beforeStart();
          result = await service.create(agent, { signal: request.signal, beforeStart,
            ...(input.title === undefined ? {} : { title: field(input.title, 'title', 100) }) });
          break;
        }
        case 'agent': {
          if (input.direction !== undefined && input.direction !== 'before' && input.direction !== 'after') throw new RemoteError('Invalid timeline direction');
          result = await service.detail(agentId(), cursorInput(input.cursor), input.direction); break;
        }
        case 'send': {
          if ((await service.summary(agentId())).chatSessionId) throw new RemoteError('Continue this session in the DSH main chat.', 409);
          result = await service.send(agentId(), input.message, { interrupt: input.interrupt === true }); break;
        }
        case 'stop': await service.stop(agentId()); result = { ok: true }; break;
        case 'respond': await service.respond(agentId(), field(input.requestId, 'permission request', 500), input.answer); result = { ok: true }; break;
        case 'retry': result = await service.retry(agentId()); break;
        case 'archive': result = await service.archive(agentId(), input.archived !== false, { onlyIdle: input.onlyIdle === true }); break;
        case 'rename': result = await service.rename(agentId(), field(input.title, 'title', 100)); break;
        case 'delete': await service.delete(agentId()); result = { ok: true }; break;
        case 'mode': result = await service.setMode(agentId(), field(input.modeId, 'mode', 200)); break;
        default: throw new RemoteError('Unknown remote agent action');
      }
      return Response.json(result, { headers });
    } catch (error) {
      // Service errors have already had saved secrets removed.
      return Response.json({ error: error instanceof Error ? error.message : 'Remote agent request failed' }, { status: error instanceof RemoteError ? error.status : 502, headers });
    }
  };
}
