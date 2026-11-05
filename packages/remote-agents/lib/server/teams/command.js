import { randomUUID } from 'node:crypto';
import { RemoteError } from '../core/domain.js';
import { buildTeamPlan } from './plan.js';
import { allPresets, choosePreset, parseTeamCommand } from './presets.js';
/**
 * The `/team` command: one line starts an AgentTeams team (`@nanmicoder/dsh-agent-teams`) in this conversation,
 * with remote CLIs as the members' models, and runs it at once. The team is created by calling the plugin's
 * `agent_teams_create` tool for the conversation directly, so no captain model turn stands between the line and the
 * members' first task; the captain is woken by their reports as AgentTeams does for any team.
 */
export const TEAM_COMMAND = 'team';
export const CREATE_TOOL = 'agent_teams_create';
export const TEAM_PLUGIN = '@nanmicoder/dsh-agent-teams';
export const TEAM_HINT = '[preset] [member=cli/model@thinking] [--plan] <goal>';
export function installTeamCommand(ctx, deps) {
    // Both registries are optional host services: a profile without slash commands keeps the rest of the plugin.
    ctx.inject(['commands', 'tools'], scoped => {
        const host = scoped;
        scoped.effect(() => host.commands.register({
            name: TEAM_COMMAND, description: 'start an AgentTeams team with remote CLI members and run it now', input: { hint: TEAM_HINT },
            handler: invocation => runTeamCommand(host.tools, deps, invocation),
        }));
    });
}
/** The line's grammar and the presets to choose from. */
export const teamUsage = (saved) => `${TEAM_HINT}. Presets: ${allPresets(saved).map(preset => `${preset.id} (${preset.members.map(member => member.name).join(', ')})`).join(', ')}. A member's cli is claude or codex.`;
/** Parse the line, resolve the members on the workspace's machine and create the team. Never throws. */
export async function runTeamCommand(tools, deps, invocation) {
    try {
        const presets = allPresets(deps.presets());
        const parsed = parseTeamCommand(invocation.rawInput, presets.map(preset => preset.id));
        if (!parsed.goal)
            throw new RemoteError(`Usage: /${TEAM_COMMAND} ${TEAM_HINT}. Presets: ${presets.map(preset => `${preset.id} (${preset.members.map(member => member.name).join(', ')})`).join('; ')}`);
        const preset = choosePreset(parsed, presets);
        if (!tools || (tools.get && !tools.get(CREATE_TOOL)))
            throw new RemoteError(`/${TEAM_COMMAND} needs the ${TEAM_PLUGIN} plugin; install and enable it, then restart DSH`);
        const placement = await deps.placement(invocation.agent.session.header.cwd, invocation.signal);
        const plan = buildTeamPlan({ preset, overrides: parsed.members, goal: parsed.goal, name: parsed.name, review: parsed.review, catalogs: deps.catalogs(placement.hostIds) });
        const result = await tools.execute({ callId: `team-${randomUUID()}`, name: CREATE_TOOL, arguments: plan.arguments, agent: invocation.agent, signal: invocation.signal });
        if (result.isError) {
            if (result.error?.info?.code === 'UNKNOWN_TOOL')
                throw new RemoteError(`/${TEAM_COMMAND} needs the ${TEAM_PLUGIN} plugin; install and enable it, then restart DSH`);
            throw new RemoteError(result.error?.message || 'AgentTeams could not create the team');
        }
        const roster = plan.summary.join('; '), counts = `${plan.arguments.plan.members.length} member${plan.arguments.plan.members.length === 1 ? '' : 's'}, ${plan.arguments.plan.tasks.length} task${plan.arguments.plan.tasks.length === 1 ? '' : 's'}`;
        return { kind: 'success', text: parsed.review
                ? `Team "${plan.arguments.name}" is staged for review (${counts}): ${roster}. Open the team panel from the chat title to adjust and approve it.`
                : `Team "${plan.arguments.name}" started (${counts}): ${roster}. Members report to this conversation; open the team panel from the chat title.` };
    }
    catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
}
