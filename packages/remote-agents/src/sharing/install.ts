import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { teamMemberOf } from '../chat/agent-teams.js';
import type { Sharing, SharingAttachments, SharingSkills, SharingTools } from './sharing.js';

/** Shared MCP calls run through DSH's tool pipeline with the owning conversation's agent; skills come from its registry. */
export function installSharingHost(ctx: Context, sharing: Sharing): void {
  ctx.inject(['tools'], scoped => {
    sharing.host.tools = scoped.get('tools') as unknown as SharingTools;
    // An MCP server connecting or dropping changes the tools its proxies list.
    scoped.on('tools/change', () => sharing.toolsChanged());
    scoped.effect(() => () => { delete sharing.host.tools; });
  });
  ctx.inject(['skills'], scoped => {
    sharing.host.skills = scoped.get('skills') as unknown as SharingSkills;
    scoped.effect(() => () => { delete sharing.host.skills; });
  });
  // Images in shared MCP results are sent as the attachments DSH's policies left.
  ctx.inject(['attachments'], scoped => {
    sharing.host.attachments = scoped.get('attachments') as unknown as SharingAttachments;
    scoped.effect(() => () => { delete sharing.host.attachments; });
  });
  ctx.inject(['agents'], scoped => {
    const agents = scoped.get('agents') as { get(id: string): unknown; withInitiator?<T>(agent: unknown, work: () => T): T };
    sharing.host.agent = id => agents.get(id);
    // DSH 0.2.2 attributes what a tool starts to the agent that initiated it; a CLI's call is its conversation's.
    if (typeof agents.withInitiator === 'function') sharing.host.initiated = (agent, work) => agents.withInitiator!(agent, work);
    scoped.effect(() => () => { delete sharing.host.agent; delete sharing.host.initiated; });
  });
  // A CLI working as an AgentTeams member reaches the team through the member tools.
  ctx.inject(['sessions'], scoped => {
    const sessions = scoped.get('sessions') as { get(id: string): Session | undefined };
    sharing.host.teamMember = id => !!teamMemberOf(sessions.get(id));
    scoped.effect(() => () => { delete sharing.host.teamMember; });
  });
}
