import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RemoteAgentsService } from './agents/service.js';
import { delegationTools } from './agents/tools.js';
import { remoteUsageRecords } from './core/usage.js';
import { adoptModel } from './chat/adopt-model.js';
import { installChat } from './chat/install.js';
import { ClaudeGoalBridge } from './chat/claude-goal.js';
import { ChatProjects } from './chat/projects.js';
import { installNativeSharing } from './chat/native-install.js';
import { accessOf, loggerOf } from './core/dsh-host.js';
import { Store } from './core/store.js';
import { createHandler } from './http.js';
import { installSharingHost } from './sharing/install.js';
import { Sharing } from './sharing/sharing.js';
import { installWorkspaces } from './workspace/install.js';
export const name = 'dsh-remote-agents';
export const inject = ['connection'];
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export const Config = Schema.object({
    stateDir: Schema.string().default(stateDir()),
    claudeGoalSessions: Schema.array(Schema.string()).default([]).description('Explicit DSH session IDs opting into the Claude goal bridge. Each new turn in a listed session restarts the Claude process (resuming the same conversation) and terminates in-process background tasks. Unlisted sessions keep their persistent process.'),
});
export async function apply(ctx, config = {}) {
    const store = new Store(join(config.stateDir ?? stateDir(), 'state.json'));
    await store.open();
    const service = new RemoteAgentsService(store);
    const projects = new ChatProjects(service);
    const workspace = await installWorkspaces(ctx, store, service);
    const native = await installNativeSharing(ctx, service, workspace);
    const sharing = new Sharing(store, undefined, message => loggerOf(ctx)?.warn?.(message));
    const goalSessions = new Set(config.claudeGoalSessions ?? []);
    const claudeGoals = new ClaudeGoalBridge(name => ctx.get(name), id => store.task(t => t.id === id && t.provider === 'claude')?.chat?.sessionId, id => goalSessions.has(id));
    sharing.goals = claudeGoals;
    service.sharing = sharing;
    // Close the store last: a reloaded plugin's new instance owns the state from then on.
    ctx.effect(() => async () => { await sharing.close(); await service.close(); await store.close(); });
    // Every finished turn is announced for usage statistics. Main chat does not report usage to DSH: a CLI turn's total
    // spans many model calls and would misstate the conversation's context size.
    store.usageListeners.add((taskId, usage, turn) => {
        const task = store.task(t => t.id === taskId);
        if (task)
            for (const record of remoteUsageRecords(task, store.hosts(), usage, turn))
                ctx.emit('remote-agents/usage', record);
    });
    ctx.connection.fetch.register({ path: '/api/remote-agents', methods: ['GET', 'POST'], requestBody: 'buffered',
        fetch: createHandler(service, projects, workspace.placement, workspace.workspaces, workspace.features, sharing, adoptModel(name => ctx.get(name)), native) });
    installChat(ctx, service, projects, { access: workspace.access, files: workspace.features.files, workspaces: workspace.workspaces }, claudeGoals);
    installSharingHost(ctx, sharing);
    // Native conversation routes and settings also work without the delegation tool registry.
    ctx.inject(['tools', 'approval', 'userQuestions'], scoped => {
        const host = scoped;
        for (const tool of delegationTools(host, service, agent => accessOf(scoped, agent?.session)))
            host.tools.register(tool);
    });
}
