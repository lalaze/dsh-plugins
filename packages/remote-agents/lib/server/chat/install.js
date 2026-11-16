import { busy } from '../core/domain.js';
import { accessOf, loggerOf } from '../core/dsh-host.js';
import { isTeamPrompt, teamMemberOf } from './agent-teams.js';
import { CHAT_IMAGE_LIMIT } from './images.js';
import { CHAT_PROVIDERS, RemoteCliAdapter } from './native-chat.js';
/** Remote CLI models in DSH's model picker and main conversation. */
export function installChat(ctx, service, projects, workspace, claudeGoals) {
    const { access, files } = workspace;
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
        const adapter = new RemoteCliAdapter(projects, { claudeGoals, approval: host.approval, userQuestions: host.userQuestions,
            agent: id => host.agents.get(id), step: id => steps.get(id), cwd: id => sessionOf(id)?.header.cwd,
            permission: id => accessOf(scoped, sessionOf(id)).permission,
            unattended: id => accessOf(scoped, sessionOf(id)).unattended,
            subagent: id => !!sessionOf(id)?.header.parentSession,
            teamMember: id => teamMemberOf(sessionOf(id)),
            // dsh-remote-terminals knows; without it there are no TUI conversations.
            tui: id => scoped.get('remoteTerminals')?.isTui?.(id) === true,
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
        // Turns its CLI session ran meanwhile without a message from the conversation are shown then too.
        const wake = (agent) => { void service.resumeConversation(agent.session.id).then(() => adapter.sync(agent) || adapter.catchUp(agent)).catch(() => { }); };
        scoped.on('agent/created', ({ agent }) => { wake(agent); return undefined; }, { global: true });
        // A subagent's agent goes away when its work is done. Its CLI on the host would stay running, one per subagent, up to
        // the account's relay limit, and then no CLI could start. A later message to the subagent resumes the CLI.
        scoped.on('agent/disposed', (({ agent }) => {
            if (!agent.session?.header.parentSession)
                return;
            const task = service.store.task(t => t.chat?.sessionId === agent.id);
            if (task)
                void service.release(task.id).catch(error => loggerOf(scoped)?.warn?.(`remote-agents: could not release ${task.id}: ${String(error)}`));
        }), { global: true });
        for (const agent of host.agents.list?.() ?? [])
            wake(agent);
        // A conversation shows a turn its CLI runs by itself as it goes. A conversation without an agent, as after DSH
        // restarted, gets one when such a turn runs, which shows it through `wake`.
        const sessionController = () => {
            const value = scoped.get('sessionController');
            if (!value)
                throw new Error('DSH sessions are not available yet');
            return value;
        };
        const followed = new Map();
        const ownTurn = (taskId) => {
            const sessionId = service.store.task(t => t.id === taskId)?.chat?.sessionId;
            if (!sessionId || followed.has(taskId))
                return;
            const timer = setTimeout(() => {
                followed.delete(taskId);
                const agent = host.agents.get(sessionId);
                void (agent ? Promise.resolve().then(() => adapter.sync(agent) || adapter.catchUp(agent)) : service.summary(taskId).then(summary => { if (busy(summary) && !summary.archived)
                    return sessionController().resolveAgent(sessionId); })).catch(() => { });
            }, 1000);
            timer.unref?.();
            followed.set(taskId, timer);
        };
        service.ownTurnListeners.add(ownTurn);
        scoped.effect(() => () => { service.ownTurnListeners.delete(ownTurn); for (const timer of followed.values())
            clearTimeout(timer); followed.clear(); });
    });
}
