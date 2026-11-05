/**
 * Remote CLIs as members of an AgentTeams team (`@nanmicoder/dsh-agent-teams`).
 *
 * A member is a DSH subagent whose descriptor label is `agent-teams:<team>:<member>`. When its model is a remote CLI,
 * this plugin passes the member's prompts to the CLI, gives the CLI the member coordination tools through the MCP
 * bridge, and tells it once how they replace DSH tools it does not have. AgentTeams itself is not changed.
 */
import type { Session } from '@deepseek-ai/dsh-session';

/** The bridge server of the member tools: outside DSH's MCP server names, so no shared server can claim it. */
export const TEAM_SERVER = '.agent-teams';
/** The MCP server name the CLI sees. */
export const TEAM_MCP_NAME = 'dsh-agent-teams';
/** The tools AgentTeams lets a member call; captain tools are never passed. */
export const TEAM_MEMBER_TOOLS: readonly string[] = ['agent_teams_claim_task', 'agent_teams_update_task', 'agent_teams_send_message', 'agent_teams_status'];
const PLUGIN = '@nanmicoder/dsh-agent-teams';

export interface TeamMember { team: string; member: string }

/** AgentTeams delivers assignments and coordination as user messages with its own source; older hosts wrap it as a plugin source. */
export function isTeamPrompt(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false;
  const { kind, plugin } = source as { kind?: unknown; plugin?: unknown };
  return kind === 'agent-teams' || kind === 'plugin' && plugin === PLUGIN;
}

/** The team and member name of an AgentTeams member session, read from its subagent descriptor. */
export function teamMemberOf(session: Pick<Session, 'header' | 'eventAt'> | undefined): TeamMember | undefined {
  if (!session?.header.parentSession) return;
  // The descriptor is the first event of a subagent session; look a little further in case a host adds one before it.
  for (let seq = 0; seq < 4; seq++) {
    let event: unknown;
    try { event = session.eventAt(seq as Parameters<Session['eventAt']>[0]); } catch { return; }
    if (!event || typeof event !== 'object') continue;
    const { type, data } = event as { type?: unknown; data?: { label?: unknown } };
    if (type !== 'subagent/descriptor') continue;
    const match = typeof data?.label === 'string' ? /^agent-teams:([^:]+):(.+)$/.exec(data.label) : null;
    return match ? { team: match[1], member: match[2] } : undefined;
  }
}

/** Prepended to the first prompt of a member's CLI session: the CLI sees no DSH system prompt or DSH tools. */
export function teamMemberNote(member: TeamMember, unattended: boolean): string {
  return [
    `You are member "${member.member}" of the DSH AgentTeams team "${member.team}", working through this CLI.`,
    `The team's coordination tools are on the MCP server "${TEAM_MCP_NAME}": ${TEAM_MEMBER_TOOLS.join(', ')}. Use them exactly as the task assignment says: claim the task, mark it in_progress, then completed or failed with its attempt_id, and send one short report to the captain with agent_teams_send_message.`,
    'The captain is your parent agent. You do not have DSH\'s native send_message tool, and the report to the captain also answers any instruction to send your result to the parent agent: do not send it a second time. If the team tools are missing, end with a message stating the task id, the outcome and the checks you ran; the captain receives your final message.',
    ...unattended ? ['Nobody can answer approval prompts or questions in this session. Stay within your workspace permissions; when something needs more access, report it to the captain as a blocker instead of waiting.'] : [],
  ].join('\n');
}
