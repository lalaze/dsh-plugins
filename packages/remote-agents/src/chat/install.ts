import type { ClaudeGoalBridge } from './claude-goal.js';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { RemoteAgentsService } from '../agents/service.js';
import { busy } from '@dsh-plugins/remote-core/domain.js';
import { accessOf, loggerOf, type ToolHost } from '@dsh-plugins/remote-core/dsh-host.js';
import type { WorkspaceAccess } from '@dsh-plugins/remote-core/access.js';
import type { RemoteWorkspaces } from '../workspace/remote-workspaces.js';
import type { WorkspaceService } from '../workspace/service.js';
import { SharedChatAdoption } from './adopt.js';
import { isTeamPrompt, teamMemberOf } from './agent-teams.js';
import { CHAT_IMAGE_LIMIT } from './images.js';
import { CHAT_PROVIDERS, RemoteCliAdapter, type SyncAgent } from './native-chat.js';
import type { ChatProjects } from './projects.js';

/** Remote CLI models in DSH's model picker and main conversation. */
export function installChat(ctx: Context, service: RemoteAgentsService, projects: ChatProjects, workspace: { access: WorkspaceAccess; files: WorkspaceService; workspaces: RemoteWorkspaces }, claudeGoals?: ClaudeGoalBridge): void {
  const { access, files, workspaces } = workspace;
  ctx.inject(['llm', 'sessions', 'agents', 'approval', 'userQuestions'], scoped => {
    const host = scoped as unknown as ToolHost & { agents: { get(id: string): unknown; list?(): SyncAgent[] } };
    const steps = new Map<string, { session: Session; turn: number; step: number }>();
    scoped.on('session/event', (session, event) => {
      if (event.type === 'step/start') steps.set(session.id, { session, ...event.data });
      else if (event.type === 'step/end' || event.type === 'turn/end') steps.delete(session.id);
    }, { global: true });
    const sessionOf = (id: string) => steps.get(id)?.session ?? scoped.sessions.get(id as Parameters<typeof scoped.sessions.get>[0]);
    const adapter = new RemoteCliAdapter(projects, { claudeGoals, approval: host.approval, userQuestions: host.userQuestions,
      agent: id => host.agents.get(id), step: id => steps.get(id), cwd: id => sessionOf(id)?.header.cwd,
      permission: id => accessOf(scoped, sessionOf(id)).permission,
      unattended: id => accessOf(scoped, sessionOf(id)).unattended,
      subagent: id => !!sessionOf(id)?.header.parentSession,
      teamMember: id => teamMemberOf(sessionOf(id)),
      tui: id => service.store.snapshot().tuiSessions?.includes(id) === true,
      userContent: (id, messageId) => sessionOf(id)?.deriveMessages().find(m => m.id === messageId && m.role === 'user' && (!m.source || m.source.kind === 'user' || isTeamPrompt(m.source)))?.content,
      attachments: {
        image: async (ref, signal) => {
          const storage = scoped.get('attachments');
          if (!storage) throw new Error('The DSH attachment service is unavailable');
          return storage.readImageRequest(ref, { width: Math.min(ref.width, 1568), height: Math.min(ref.height, 1568), maxBytes: 4 * 1024 * 1024 }, signal);
        },
        file: async function* (ref, signal) {
          const storage = scoped.get('attachments');
          if (!storage) throw new Error('The DSH attachment service is unavailable');
          yield* storage.readFileStream(ref, signal);
        },
      },
      image: async (id, path, signal) => {
        const file = await files.operate(id, { op: 'stat', path }, signal) as { revision: string; size: number };
        return file.size <= CHAT_IMAGE_LIMIT ? files.download(id, path, file.revision, signal) : undefined;
      },
      viewedImage: (id, path, signal) => files.readViewed(id, path, CHAT_IMAGE_LIMIT, signal),
      workspace: (cwd, signal) => access.resolve(cwd, signal) });
    const registration = scoped.llm.registerAdapter(CHAT_PROVIDERS, adapter);
    scoped.effect(() => projects.onChange(() => registration.replace(CHAT_PROVIDERS)));
    // A model's remembered reasoning effort is its advertised default; DSH reloads the catalog on replace.
    scoped.effect(() => adapter.onModelInfoChange(() => registration.replace(CHAT_PROVIDERS)));
    scoped.effect(() => () => adapter.close());
    // A response cut off by quitting DSH or reloading the plugin catches up when its conversation opens.
    // Restore only that conversation: eagerly attaching every saved relay would start an SSH storm on launch.
    // Turns another DSH or Open sessions ran in its CLI session meanwhile are shown then too.
    const wake = (agent: SyncAgent) => { void service.resumeConversation(agent.session.id).then(() => adapter.sync(agent) || adapter.catchUp(agent)).catch(() => {}); };
    scoped.on('agent/created', ({ agent }) => { wake(agent); return undefined; }, { global: true });
    // A subagent's agent goes away when its work is done. Its CLI on the host would stay running, one per subagent, up to
    // the account's relay limit, and then no CLI could start. A later message to the subagent resumes the CLI.
    scoped.on('agent/disposed' as never, (({ agent }: { agent: { id: string; session?: Session } }) => {
      if (!agent.session?.header.parentSession) return;
      const task = service.store.task(t => t.chat?.sessionId === agent.id);
      if (task) void service.release(task.id).catch(error => loggerOf(scoped)?.warn?.(`remote-agents: could not release ${task.id}: ${String(error)}`));
    }) as never, { global: true });
    for (const agent of host.agents.list?.() ?? []) wake(agent);
    // A conversation shows a turn another DSH runs in its CLI session as it goes, and one the CLI runs by itself too.
    // The history changes many times during a turn: look at most once a second. A conversation without an agent,
    // as after DSH restarted, gets one when such a turn runs, which shows it through `wake`.
    const followed = new Map<string, ReturnType<typeof setTimeout>>();
    const historyChanged = (taskId: string) => {
      const sessionId = service.store.task(t => t.id === taskId)?.chat?.sessionId;
      if (!sessionId || followed.has(taskId)) return;
      const timer = setTimeout(() => {
        followed.delete(taskId);
        const agent = host.agents.get(sessionId) as SyncAgent | undefined;
        void (agent ? Promise.resolve().then(() => adapter.sync(agent) || adapter.catchUp(agent)) : service.summary(taskId).then(summary => { if (busy(summary) && !summary.archived) return controller('sessionController').resolveAgent(sessionId); })).catch(() => {});
      }, 1000);
      timer.unref?.(); followed.set(taskId, timer);
    };
    service.sharedHistoryListeners.add(historyChanged);
    scoped.effect(() => () => { service.sharedHistoryListeners.delete(historyChanged); for (const timer of followed.values()) clearTimeout(timer); followed.clear(); });
    // Sessions other DSH instances started on shared hosts continue here as conversations in their remote workspaces.
    const controller = (name: 'sessionController' | 'workspaceController') => {
      const value = scoped.get(name) as any;
      if (!value) throw new Error(`DSH ${name === 'sessionController' ? 'sessions are' : 'workspaces are'} not available yet`);
      return value;
    };
    const adoption = new SharedChatAdoption(projects, {
      anchor: async (hostId, cwd, signal) => (await workspaces.create(hostId, cwd, signal)).path,
      workspace: async path => String((await controller('workspaceController').create({ path })).workspace.workspaceId),
      sessions: async () => {
        const items = ((await controller('sessionController').list({})) as { items?: { sessionId: string; blank?: boolean }[] }).items ?? [];
        return new Map(items.map(item => [item.sessionId, { blank: item.blank === true }]));
      },
      create: async (workspaceId, sessionId) => String((await controller('sessionController').create({ workspaceId, sessionId })).sessionId),
      select: async (sessionId, selection) => {
        await controller('sessionController').selectModel({ sessionId, provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) });
        // The composer's permission decides the CLI mode of the next message: start from the mode the session has. DSH has
        // no read-only preset by default; a permission without one takes the closest stricter preset, else the strictest there is.
        const presets = scoped.get('permissionPresets') as { set?(session: Session, preset: string): void } | undefined, session = scoped.sessions.get(sessionId as Parameters<typeof scoped.sessions.get>[0]);
        if (!selection.permission || !session || !presets?.set) return;
        const levels = ['read-only', 'workspace-write', 'auto', 'danger-full-access'], at = levels.indexOf(selection.permission);
        for (const preset of [...levels.slice(0, at + 1).reverse(), ...levels.slice(at + 1)]) {
          try { presets.set(session, preset); return; } catch { /* Not a preset of this DSH: try the next one. */ }
        }
      },
      rename: async (sessionId, title) => { await controller('sessionController').rename({ sessionId, title }); },
      wake: sessionId => { const agent = host.agents.get(sessionId) as SyncAgent | undefined; if (agent) adapter.sync(agent); },
      // DSH has no logger service by default: its output log keeps the reason a conversation could not be added.
      warn: message => { const logger = loggerOf(scoped); if (logger?.warn) logger.warn(message); else console.warn(`[dsh-remote-agents] ${message}`); },
    });
    adoption.start();
    scoped.effect(() => () => adoption.close());
  });
}
