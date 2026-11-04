import { type Provider } from '../core/domain.js';
import type { MemberSpec, TeamPreset } from './presets.js';
/** The CLIs one machine of the conversation's workspace offers, as the model picker lists them. */
export interface Catalog {
    projectId: string;
    hostLabel: string;
    providers: Provider[];
}
/** One `agent_teams_create` plan member: remote CLI members carry a DSH model route. */
export interface PlanMember {
    name: string;
    role?: string;
    provider?: string;
    model?: string;
    reasoning_effort?: string;
}
export interface PlanTask {
    id: string;
    subject: string;
    description?: string;
    assignee?: string;
    dependencies: string[];
}
export interface TeamPlan {
    arguments: {
        name: string;
        description: string;
        approval: 'automatic' | 'required';
        plan: {
            members: PlanMember[];
            tasks: PlanTask[];
        };
    };
    /** One line per member, for the command's result: `coder → Codex gpt-5 on build-box`. */
    summary: string[];
}
export declare const MAX_TEAM_NAME = 40;
/** A team name from the goal: its first line, at most {@link MAX_TEAM_NAME} characters, cut at a word when it can be. */
export declare function teamNameOf(goal: string): string;
/** Turn a preset, the line's member assignments and the goal into the arguments of `agent_teams_create`. */
export declare function buildTeamPlan(input: {
    preset: TeamPreset;
    overrides: ReadonlyMap<string, MemberSpec>;
    goal: string;
    name?: string;
    review: boolean;
    catalogs: readonly Catalog[];
}): TeamPlan;
