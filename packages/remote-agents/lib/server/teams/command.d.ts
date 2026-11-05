import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { WorkspacePlacement } from '../workspace/access.js';
import { type Catalog } from './plan.js';
import { type TeamPreset } from './presets.js';
/**
 * The `/team` command: one line starts an AgentTeams team (`@nanmicoder/dsh-agent-teams`) in this conversation,
 * with remote CLIs as the members' models, and runs it at once. The team is created by calling the plugin's
 * `agent_teams_create` tool for the conversation directly, so no captain model turn stands between the line and the
 * members' first task; the captain is woken by their reports as AgentTeams does for any team.
 */
export declare const TEAM_COMMAND = "team";
export declare const CREATE_TOOL = "agent_teams_create";
export declare const TEAM_PLUGIN = "@nanmicoder/dsh-agent-teams";
export declare const TEAM_HINT = "[preset] [member=cli/model@thinking] [--plan] <goal>";
export interface CommandAgent {
    id: string;
    session: Pick<Session, 'header'>;
}
export interface CommandInvocation {
    agent: CommandAgent;
    rawInput: string;
    signal: AbortSignal;
}
export type CommandResult = {
    kind: 'success';
    text?: string;
} | {
    kind: 'error';
    text: string;
};
/** The DSH tool registry: a tool runs for an agent as if its model had called it, through the same policies. */
export interface Tools {
    get?(name: string): unknown;
    execute(input: {
        callId: string;
        name: string;
        arguments: unknown;
        agent?: unknown;
        signal: AbortSignal;
    }): Promise<{
        isError: boolean;
        error?: {
            message: string;
            info?: {
                code?: string;
            };
        };
        value?: unknown;
    }>;
}
export interface TeamCommandDeps {
    presets(): TeamPreset[];
    /** The verified machine(s) of a conversation's workspace. */
    placement(cwd: string | undefined, signal: AbortSignal): Promise<WorkspacePlacement>;
    catalogs(hostIds: readonly string[]): Catalog[];
}
export declare function installTeamCommand(ctx: Context, deps: TeamCommandDeps): void;
/** The line's grammar and the presets to choose from. */
export declare const teamUsage: (saved: TeamPreset[]) => string;
/** Parse the line, resolve the members on the workspace's machine and create the team. Never throws. */
export declare function runTeamCommand(tools: Tools | undefined, deps: TeamCommandDeps, invocation: CommandInvocation): Promise<CommandResult>;
