import { join } from 'node:path';
import { busy } from '../core/domain.js';
import { accessOf, loggerOf } from '../core/dsh-host.js';
import { dshHome } from '../workspace/access.js';
import { SharedChatAdoption } from './adopt.js';
import { isTeamPrompt, teamMemberOf } from './agent-teams.js';
import { CHAT_IMAGE_LIMIT } from './images.js';
import { CHAT_PROVIDERS, RemoteCliAdapter } from './native-chat.js';
import { repairStoredSessions } from './session-repair.js';
/** Conversations saved by 0.2.53 and earlier stored a remote tool row out of order, and DSH refuses to reopen them. */
export function scheduleSessionRepair(ctx, store) {
    const persistence = ctx.get('sessionPersistence');
    const open = (id) => !!ctx.get('sessions')?.get?.(id);
    // Let DSH finish opening before a one-time scan competes for filesystem and compression workers.
    const repairTimer = setTimeout(() => {
        void repairStoredSessions(typeof persistence?.root === 'string' ? persistence.root : join(dshHome(), 'sessions'), store.directory, open)
            .then(paths => { if (paths.length)
            loggerOf(ctx)?.info?.(`Repaired ${paths.length} remote CLI conversation log(s) DSH could not reopen; originals kept in ${join(store.directory, 'session-backups')}`); })
            .catch(error => loggerOf(ctx)?.warn?.(`Remote CLI conversation repair failed: ${String(error)}`));
    }, 2000);
    repairTimer.unref?.();
    ctx.effect(() => () => clearTimeout(repairTimer));
}
/** Remote CLI models in DSH's model picker and main conversation. */
export function installChat(ctx, service, projects, workspace) {
    const { access, files, workspaces } = workspace;
    ctx.inject(['llm', 'sessions', 'agents', 'approval', 'userQuestions'], scoped => {
        const host = scoped;
        const steps = new Map();
        scoped.on('session/event', (session, event) => {
            if (event.type === 'step/start')
                steps.set(session.id, { session, ...event.data });
            else if (event.type === 'step/end' || event.type === 'turn/end')
                steps.delete(session.id);
        }, { global: true });
        const sessionOf = (id) => steps.get(id)?.session ?? scoped.sessions.get(id);
        const adapter = new RemoteCliAdapter(projects, { approval: host.approval, userQuestions: host.userQuestions,
            agent: id => host.agents.get(id), step: id => steps.get(id), cwd: id => sessionOf(id)?.header.cwd,
            permission: id => accessOf(scoped, sessionOf(id)).permission,
            unattended: id => accessOf(scoped, sessionOf(id)).unattended,
            teamMember: id => teamMemberOf(sessionOf(id)),
            userContent: (id, messageId) => sessionOf(id)?.deriveMessages().find(m => m.id === messageId && m.role === 'user' && (!m.source || m.source.kind === 'user' || isTeamPrompt(m.source)))?.content,
            attachments: {
                image: async (ref, signal) => {
                    const storage = scoped.get('attachments');
                    if (!storage)
                        throw new Error('The DSH attachment service is unavailable');
                    return storage.readImageRequest(ref, { width: Math.min(ref.width, 1568), height: Math.min(ref.height, 1568), maxBytes: 4 * 1024 * 1024 }, signal);
                },
                file: async function* (ref, signal) {
                    const storage = scoped.get('attachments');
                    if (!storage)
                        throw new Error('The DSH attachment service is unavailable');
                    yield* storage.readFileStream(ref, signal);
                },
            },
            image: async (id, path, signal) => {
                const file = await files.operate(id, { op: 'stat', path }, signal);
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
        const wake = (agent) => { void service.resumeConversation(agent.session.id).then(() => adapter.sync(agent) || adapter.catchUp(agent)).catch(() => { }); };
        scoped.on('agent/created', ({ agent }) => { wake(agent); return undefined; }, { global: true });
        for (const agent of host.agents.list?.() ?? [])
            wake(agent);
        // A conversation shows a turn another DSH runs in its CLI session as it goes, and one the CLI ran by itself once it
        // ends. The history changes many times during a turn: look at most once a second. A conversation without an agent,
        // as after DSH restarted, gets one when such a turn runs, which shows it through `wake`.
        const followed = new Map();
        const historyChanged = (taskId) => {
            const sessionId = service.store.task(t => t.id === taskId)?.chat?.sessionId;
            if (!sessionId || followed.has(taskId))
                return;
            const timer = setTimeout(() => {
                followed.delete(taskId);
                const agent = host.agents.get(sessionId);
                void (agent ? Promise.resolve().then(() => adapter.sync(agent) || adapter.catchUp(agent)) : service.summary(taskId).then(summary => { if (busy(summary) && !summary.archived)
                    return controller('sessionController').resolveAgent(sessionId); })).catch(() => { });
            }, 1000);
            timer.unref?.();
            followed.set(taskId, timer);
        };
        service.sharedHistoryListeners.add(historyChanged);
        scoped.effect(() => () => { service.sharedHistoryListeners.delete(historyChanged); for (const timer of followed.values())
            clearTimeout(timer); followed.clear(); });
        // Sessions other DSH instances started on shared hosts continue here as conversations in their remote workspaces.
        const controller = (name) => {
            const value = scoped.get(name);
            if (!value)
                throw new Error(`DSH ${name === 'sessionController' ? 'sessions are' : 'workspaces are'} not available yet`);
            return value;
        };
        const adoption = new SharedChatAdoption(projects, {
            anchor: async (hostId, cwd, signal) => (await workspaces.create(hostId, cwd, signal)).path,
            workspace: async (path) => String((await controller('workspaceController').create({ path })).workspace.workspaceId),
            sessions: async () => {
                const items = (await controller('sessionController').list({})).items ?? [];
                return new Map(items.map(item => [item.sessionId, { blank: item.blank === true }]));
            },
            create: async (workspaceId, sessionId) => String((await controller('sessionController').create({ workspaceId, sessionId })).sessionId),
            select: async (sessionId, selection) => {
                await controller('sessionController').selectModel({ sessionId, provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) });
                // The composer's permission decides the CLI mode of the next message: start from the mode the session has. DSH has
                // no read-only preset by default; a permission without one takes the closest stricter preset, else the strictest there is.
                const presets = scoped.get('permissionPresets'), session = scoped.sessions.get(sessionId);
                if (!selection.permission || !session || !presets?.set)
                    return;
                const levels = ['read-only', 'workspace-write', 'auto', 'danger-full-access'], at = levels.indexOf(selection.permission);
                for (const preset of [...levels.slice(0, at + 1).reverse(), ...levels.slice(at + 1)]) {
                    try {
                        presets.set(session, preset);
                        return;
                    }
                    catch { /* Not a preset of this DSH: try the next one. */ }
                }
            },
            rename: async (sessionId, title) => { await controller('sessionController').rename({ sessionId, title }); },
            wake: sessionId => { const agent = host.agents.get(sessionId); if (agent)
                adapter.sync(agent); },
            // DSH has no logger service by default: its output log keeps the reason a conversation could not be added.
            warn: message => { const logger = loggerOf(scoped); if (logger?.warn)
                logger.warn(message);
            else
                console.warn(`[dsh-remote-agents] ${message}`); },
        });
        adoption.start();
        scoped.effect(() => () => adoption.close());
    });
}
