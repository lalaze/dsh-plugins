import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { join } from 'node:path';
import type { RemoteAgentsService } from '../agents/service.js';
import { loggerOf, permissionOf, type ToolHost } from '../core/dsh-host.js';
import type { Store } from '../core/store.js';
import type { WorkspaceAccess } from '../workspace/access.js';
import { dshHome } from '../workspace/access.js';
import type { WorkspaceService } from '../workspace/service.js';
import { CHAT_IMAGE_LIMIT } from './images.js';
import { CHAT_PROVIDERS, RemoteCliAdapter, type SyncAgent } from './native-chat.js';
import type { ChatProjects } from './projects.js';
import { repairStoredSessions } from './session-repair.js';

/** Conversations saved by 0.2.53 and earlier stored a remote tool row out of order, and DSH refuses to reopen them. */
export function scheduleSessionRepair(ctx: Context, store: Store): void {
  const persistence = ctx.get('sessionPersistence') as { root?: unknown } | undefined;
  const open = (id: string) => !!(ctx.get('sessions') as { get?(id: string): unknown } | undefined)?.get?.(id);
  // Let DSH finish opening before a one-time scan competes for filesystem and compression workers.
  const repairTimer = setTimeout(() => {
    void repairStoredSessions(typeof persistence?.root === 'string' ? persistence.root : join(dshHome(), 'sessions'), store.directory, open)
      .then(paths => { if (paths.length) loggerOf(ctx)?.info?.(`Repaired ${paths.length} remote CLI conversation log(s) DSH could not reopen; originals kept in ${join(store.directory, 'session-backups')}`); })
      .catch(error => loggerOf(ctx)?.warn?.(`Remote CLI conversation repair failed: ${String(error)}`));
  }, 2000);
  repairTimer.unref?.();
  ctx.effect(() => () => clearTimeout(repairTimer));
}

/** Remote CLI models in DSH's model picker and main conversation. */
export function installChat(ctx: Context, service: RemoteAgentsService, projects: ChatProjects, workspace: { access: WorkspaceAccess; files: WorkspaceService }): void {
  const { access, files } = workspace;
  ctx.inject(['llm', 'sessions', 'agents', 'approval', 'userQuestions'], scoped => {
    const host = scoped as unknown as ToolHost & { agents: { get(id: string): unknown; list?(): SyncAgent[] } };
    const steps = new Map<string, { session: Session; turn: number; step: number }>();
    scoped.on('session/event', (session, event) => {
      if (event.type === 'step/start') steps.set(session.id, { session, ...event.data });
      else if (event.type === 'step/end' || event.type === 'turn/end') steps.delete(session.id);
    }, { global: true });
    const adapter = new RemoteCliAdapter(projects, { approval: host.approval, userQuestions: host.userQuestions,
      agent: id => host.agents.get(id), step: id => steps.get(id), cwd: id => steps.get(id)?.session.header.cwd ?? scoped.sessions.get(id)?.header.cwd,
      permission: id => permissionOf(scoped, steps.get(id)?.session ?? scoped.sessions.get(id)),
      userContent: (id, messageId) => (steps.get(id)?.session ?? scoped.sessions.get(id))?.deriveMessages().find(m => m.id === messageId && m.role === 'user' && (!m.source || m.source.kind === 'user'))?.content,
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
      workspace: (cwd, signal) => access.resolve(cwd, signal) });
    const registration = scoped.llm.registerAdapter(CHAT_PROVIDERS, adapter);
    scoped.effect(() => projects.onChange(() => registration.replace(CHAT_PROVIDERS)));
    // A model's remembered reasoning effort is its advertised default; DSH reloads the catalog on replace.
    scoped.effect(() => adapter.onModelInfoChange(() => registration.replace(CHAT_PROVIDERS)));
    scoped.effect(() => () => adapter.close());
    // A response cut off by quitting DSH or reloading the plugin catches up when its conversation opens.
    // Restore only that conversation: eagerly attaching every saved relay would start an SSH storm on launch.
    const wake = (agent: SyncAgent) => { void service.resumeConversation(agent.session.id).then(() => adapter.sync(agent)).catch(() => {}); };
    scoped.on('agent/created', ({ agent }) => { wake(agent); return undefined; }, { global: true });
    for (const agent of host.agents.list?.() ?? []) wake(agent);
  });
}
