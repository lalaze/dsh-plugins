import { teamMemberOf } from '../chat/agent-teams.js';
/** Shared MCP calls run through DSH's tool pipeline with the owning conversation's agent; skills come from its registry. */
export function installSharingHost(ctx, sharing) {
    ctx.inject(['tools'], scoped => {
        sharing.host.tools = scoped.get('tools');
        // An MCP server connecting or dropping changes the tools its proxies list.
        scoped.on('tools/change', () => sharing.toolsChanged());
        scoped.effect(() => () => { delete sharing.host.tools; });
    });
    ctx.inject(['skills'], scoped => {
        sharing.host.skills = scoped.get('skills');
        scoped.effect(() => () => { delete sharing.host.skills; });
    });
    // Images in shared MCP results are sent as the attachments DSH's policies left.
    ctx.inject(['attachments'], scoped => {
        sharing.host.attachments = scoped.get('attachments');
        scoped.effect(() => () => { delete sharing.host.attachments; });
    });
    ctx.inject(['agents'], scoped => {
        const agents = scoped.get('agents');
        sharing.host.agent = id => agents.get(id);
        scoped.effect(() => () => { delete sharing.host.agent; });
    });
    // A CLI working as an AgentTeams member reaches the team through the member tools.
    ctx.inject(['sessions'], scoped => {
        const sessions = scoped.get('sessions');
        sharing.host.teamMember = id => !!teamMemberOf(sessions.get(id));
        scoped.effect(() => () => { delete sharing.host.teamMember; });
    });
}
