/**
 * Remote CLIs as members of an AgentTeams team (`@nanmicoder/dsh-agent-teams`).
 *
 * A member is a DSH subagent whose descriptor label is `agent-teams:<team>:<member>`. When its model is a remote CLI,
 * this plugin passes the member's prompts to the CLI, gives the CLI the member coordination tools through the MCP
 * bridge, and tells it once how they replace DSH tools it does not have. AgentTeams itself is not changed.
 */
import type { Session } from '@deepseek-ai/dsh-session';
/** The bridge server of the member tools: outside DSH's MCP server names, so no shared server can claim it. */
export declare const TEAM_SERVER = ".agent-teams";
/** The MCP server name the CLI sees. */
export declare const TEAM_MCP_NAME = "dsh-agent-teams";
/** The tools AgentTeams lets a member call; captain tools are never passed. */
export declare const TEAM_MEMBER_TOOLS: readonly string[];
export interface TeamMember {
    team: string;
    member: string;
}
/** AgentTeams delivers assignments and coordination as user messages with its own source; older hosts wrap it as a plugin source. */
export declare function isTeamPrompt(source: unknown): boolean;
/** The team and member name of an AgentTeams member session, read from its subagent descriptor. */
export declare function teamMemberOf(session: Pick<Session, 'header' | 'eventAt'> | undefined): TeamMember | undefined;
/** Prepended to the first prompt of a member's CLI session: the CLI sees no DSH system prompt or DSH tools. */
export declare function teamMemberNote(member: TeamMember, unattended: boolean): string;
