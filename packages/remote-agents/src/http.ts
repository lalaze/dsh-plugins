import { browsePath, cursorInput, field, identifier, PROVIDER_LABELS, record, remotePath, RemoteError, taskInput } from '@dsh-plugins/remote-core/domain.js';
import type { RemoteAgentsService } from './agents/service.js';
import type { adoptModel } from './chat/adopt-model.js';
import { ChatProjects } from './chat/projects.js';
import { nativeSharingStatus, setNativeSharing } from './chat/native-sharing.js';
import type { NativeSharing } from './chat/native-service.js';
import type { WorkspacePlacement } from '@dsh-plugins/remote-core/access.js';
import type { RemoteWorkspaces } from './workspace/remote-workspaces.js';
import { workspaceAction, type WorkspaceFeatures } from './workspace/http.js';
import type { Sharing } from './sharing/sharing.js';

export function createHandler(service: RemoteAgentsService, projects = new ChatProjects(service), workspace?: (sessionId: string, signal: AbortSignal) => Promise<WorkspacePlacement>, workspaces?: Partial<Pick<RemoteWorkspaces, 'create' | 'shared' | 'publish'>>, features?: WorkspaceFeatures, sharing?: Pick<Sharing, 'catalog' | 'set' | 'status'>, adopt?: ReturnType<typeof adoptModel>, native?: NativeSharing) {
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
        case 'nativeSharing': result = native?.status() ?? nativeSharingStatus(); break;
        case 'nativeRollbackFreeze': case 'nativeInspectWork': case 'nativeReconcileWork': case 'nativeRetryWork': {
          if (!native) throw new RemoteError('Native host integration is unavailable', 501);
          const id = field(input.sessionId, 'session ID', 256);
          if (action !== 'nativeInspectWork' && input.confirmed !== true) throw new RemoteError('Explicitly confirm freeze or acceptance recovery');
          if (action === 'nativeRollbackFreeze') { await native.rollbackFreeze(id); result = native.status(); }
          else {
            const key = field(input.workKey, 'work receipt key', 1000);
            if (action === 'nativeInspectWork') result = await native.inspectWork(id, key);
            else if (action === 'nativeRetryWork') { await native.retryWork(id, key); result = native.status(); }
            else result = await native.reconcileWork(id, key, { candidateId: input.candidateId === undefined ? undefined : field(input.candidateId, 'candidate task ID', 256), confirmAbsent: input.confirmAbsent === true });
          }
          break;
        }
        case 'nativeRestoreSource': case 'nativeResumeSource': case 'nativeResumeAutonomy': {
          if (!native) throw new RemoteError('Native host integration is unavailable', 501);
          if (input.confirmed !== true) throw new RemoteError('Explicitly confirm resuming parked queues and selected schedules');
          const schedules = input.schedules;
          if (schedules !== undefined && (!Array.isArray(schedules) || schedules.some(id => typeof id !== 'string' || id.length > 256))) throw new RemoteError('Invalid staged schedule IDs');
          const activatePaused = input.activatePaused;
          if (activatePaused !== undefined && (!Array.isArray(activatePaused) || activatePaused.some(id => typeof id !== 'string' || id.length > 256))) throw new RemoteError('Invalid paused schedule IDs');
          const id = field(input.sessionId, 'session ID', 256), options = { queues: input.queues === true, schedules: schedules as string[] | undefined, activatePaused: activatePaused as string[] | undefined, goals: input.goals === true };
          if (action === 'nativeRestoreSource') await native.restoreCancelledSource(id);
          else if (action === 'nativeResumeSource') await native.resumeSourceWork(id, options);
          else await native.resumeAutonomy(id, options);
          result = native.status(); break;
        }
        case 'nativeMappings': case 'nativeSourceProject': case 'inspectNativeMapping': case 'setNativeMapping': {
          if (!native) throw new RemoteError('Native host integration is unavailable', 501);
          if (!service.store.hosts().some(host => host.id === hostId())) throw new RemoteError('Remote host not found', 404);
          if (action === 'nativeMappings') result = native.mappings(hostId());
          else if (action === 'nativeSourceProject') result = await native.sourceProject(field(input.sessionId, 'session ID', 256), hostId());
          else if (action === 'inspectNativeMapping') result = native.inspectMapping(hostId(), field(input.localDirectory, 'local directory', 4096));
          else {
            if (input.confirmed !== true) throw new RemoteError('Explicitly confirm the target project directory');
            result = await native.setMapping(hostId(), field(input.projectKey, 'project key', 4096), field(input.localDirectory, 'local directory', 4096), field(input.confirmedDirectory, 'confirmed directory', 4096));
          }
          break;
        }
        case 'setNativeSharing': {
          if (!native) { result = setNativeSharing(input.enabled); break; }
          if (typeof input.enabled !== 'boolean') throw new RemoteError('enabled must be a boolean');
          if (!service.store.hosts().some(host => host.id === hostId())) throw new RemoteError('Remote host not found', 404);
          result = await native.configure(hostId(), input.enabled); break;
        }
        case 'nativeList': case 'nativeShare': case 'nativeOpen': case 'nativeHandoff': case 'nativeRecover': case 'nativeCheckpoint': case 'nativeRejected': case 'nativeRestore': case 'nativeCancel': case 'nativeReconcile': case 'nativeLockStatus': {
          if (!native) throw new RemoteError('Native host integration is unavailable', 501);
          const sessionId = () => field(input.sessionId, 'session ID', 256);
          if (action === 'nativeList') result = await native.list(hostId());
          else if (action === 'nativeShare') {
            if (input.confirmed !== true || input.confirmedSessionId !== sessionId()) throw new RemoteError('Confirm the exact conversation ID and closing its original before sharing');
            result = await native.share(sessionId(), hostId());
          }
          else if (action === 'nativeOpen') result = await native.open(hostId(), identifier(input.sharedId), input.writing === true);
          else if (action === 'nativeRestore') { await native.restore(hostId(), identifier(input.sharedId)); result = native.status(); }
          else if (action === 'nativeRecover') {
            if (input.recoverLastCheckpoint !== true) throw new RemoteError('Explicitly confirm recovery of only the last shared checkpoint; unpublished local history is excluded');
            await native.recover(sessionId()); result = native.status();
          }
          else if (action === 'nativeCancel') { await native.cancelEnrollment(sessionId()); result = native.status(); }
          else if (action === 'nativeReconcile') { await native.reconcileEnrollment(sessionId()); result = native.status(); }
          else if (action === 'nativeLockStatus') result = await native.diagnoseLock(hostId(), identifier(input.sharedId));
          else if (action === 'nativeRejected') result = native.recoveryInput(sessionId());
          else if (action === 'nativeCheckpoint') { await native.checkpoint(sessionId()); result = native.status(); }
          else {
            const operation = input.operation ?? 'release';
            if (!['release', 'archive', 'delete', 'withdraw'].includes(String(operation))) throw new RemoteError('Invalid native handoff operation');
            await native.handoff(sessionId(), operation as 'release' | 'archive' | 'delete' | 'withdraw'); result = native.status();
          }
          break;
        }
        case 'workspaceTarget': case 'workspaceFiles': case 'workspaceSync': {
          if (!features) throw new RemoteError('Remote workspaces are unavailable', 501);
          result = await workspaceAction(features, action, input, request.signal); break;
        }
        case 'workspaceModels': result = workspace ? await workspace(field(input.sessionId, 'session ID', 256), request.signal) : { hostIds: [] }; break;
        case 'hostCatalogs': result = projects.hosts(); break;
        case 'sharing': case 'setSharing': {
          if (!sharing) throw new RemoteError('Sharing with remote CLIs is unavailable', 501);
          if (action === 'setSharing') await sharing.set(input.kind, input.name, input.shared);
          result = { ...await sharing.catalog(request.signal), errors: sharing.status() }; break;
        }
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
        case 'markChatRead': await service.markChatRead(field(input.sessionId, 'session ID', 256)); result = { ok: true }; break;
        case 'chatReadMarks': {
          const ids = Array.isArray(input.sessionIds) ? input.sessionIds.slice(0, 500).map(id => field(id, 'session ID', 256)) : [];
          result = { marks: Object.fromEntries(ids.flatMap(id => { const mark = service.chatReadMark(id); return mark ? [[id, mark]] : []; })) };
          break;
        }
        case 'chatSpeed': result = projects.speed(field(input.sessionId, 'session ID', 256), field(input.model, 'model', 1000)); break;
        case 'setChatSpeed': result = await projects.setFast(field(input.sessionId, 'session ID', 256), input.fast === true); break;
        case 'adoptChatModel': {
          const effort = input.reasoningEffort === undefined ? {} : { reasoningEffort: field(input.reasoningEffort, 'thinking level', 200) };
          if (!adopt) throw new RemoteError('Remote workspaces are unavailable', 501);
          await adopt(field(input.sessionId, 'session ID', 256), { provider: field(input.provider, 'provider', 200), model: field(input.model, 'model', 1000), ...effort });
          result = { ok: true }; break;
        }
        case 'setChatEffort': await projects.setEffort(field(input.provider, 'provider', 200), field(input.model, 'model', 1000), field(input.reasoningEffort, 'reasoning effort', 200)); result = { ok: true }; break;
        case 'sshConfig': result = await service.sshConfig(); break;
        case 'addHost': result = await service.addHost(input.host, { discoverModels: true }); break;
        case 'removeHost': {
          const id = hostId();
          if (native?.status().hosts.includes(id)) throw new RemoteError('Handoff native conversations and disable ordinary sharing before removing this host', 409);
          result = await service.removeHost(id, { deleteAgents: input.deleteAgents === true, everywhere: input.everywhere === true }); break;
        }
        case 'connect': result = await service.connect(hostId()); break;
        case 'browse': result = await service.browse(hostId(), input.path === undefined ? undefined : browsePath(input.path)); break;
        case 'createWorkspace': {
          if (!workspaces?.create) throw new RemoteError('Remote workspaces are unavailable', 501);
          result = await workspaces.create(hostId(), browsePath(input.path), request.signal); break;
        }
        case 'setHostSharing': result = await service.setHostSharing(hostId(), input.share); break;
        case 'sharedWorkspaces': result = workspaces?.shared ? await workspaces.shared(request.signal) : []; break;
        case 'publishWorkspaces': {
          if (!Array.isArray(input.paths) || input.paths.length > 500 || input.paths.some(path => typeof path !== 'string' || path.length > 4096)) throw new RemoteError('Invalid workspace paths');
          await workspaces?.publish?.(input.paths as string[], request.signal); result = { ok: true }; break;
        }
        case 'seeWorkspaces': {
          if (!Array.isArray(input.paths) || input.paths.length > 500) throw new RemoteError('Invalid workspace paths');
          await service.seeWorkspaces(hostId(), input.paths.map(path => remotePath(path))); result = { ok: true }; break;
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
        case 'delegations': result = await service.delegations(field(input.sessionId, 'session ID', 256)); break;
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
