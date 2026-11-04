import { chatModelId, chatProviderId } from '../chat/native-chat.js';
import { PROVIDER_LABELS, RemoteError } from '../core/domain.js';
export const MAX_TEAM_NAME = 40;
const same = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
function pickModel(cli, provider, wanted) {
    const label = PROVIDER_LABELS[cli];
    if (!provider.models.length)
        throw new RemoteError(`${label} lists no models on this machine`);
    if (wanted === undefined)
        return provider.models.find(model => model.isDefault) ?? provider.models[0];
    const exact = provider.models.find(model => model.id === wanted) ?? provider.models.find(model => same(model.id, wanted) || same(model.label, wanted));
    if (exact)
        return exact;
    const lower = wanted.toLowerCase(), partial = provider.models.filter(model => model.id.toLowerCase().includes(lower) || model.label.toLowerCase().includes(lower));
    if (partial.length === 1)
        return partial[0];
    if (partial.length > 1)
        throw new RemoteError(`Several ${label} models match "${wanted}": ${partial.map(model => model.id).join(', ')}`);
    throw new RemoteError(`${label} has no model "${wanted}" on this machine; models: ${provider.models.map(model => model.id).join(', ')}`);
}
function pickEffort(model, wanted) {
    if (wanted === undefined)
        return undefined;
    const options = model.thinkingOptions ?? [];
    const option = options.find(choice => same(choice.id, wanted) || same(choice.label, wanted));
    if (option)
        return option.id;
    throw new RemoteError(options.length ? `${model.label} has no thinking level "${wanted}"; levels: ${options.map(choice => choice.id).join(', ')}` : `${model.label} has no thinking levels`);
}
const BRACKETS = { '(': ')', '[': ']', '{': '}', '（': '）', '【': '】', '「': '」' };
/** Without the fragment after a bracket that the cut left open. */
function balanced(text) {
    for (let index = text.length - 1; index >= 0; index--) {
        const close = BRACKETS[text[index]];
        if (close !== undefined && !text.includes(close, index))
            return balanced(text.slice(0, index));
    }
    return text;
}
/** A team name from the goal: its first line, at most {@link MAX_TEAM_NAME} characters, cut at a word when it can be. */
export function teamNameOf(goal) {
    const line = goal.split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? '';
    const points = [...line.replace(/\s+/g, ' ')];
    if (points.length <= MAX_TEAM_NAME)
        return line || 'team';
    const cut = points.slice(0, MAX_TEAM_NAME).join(''), space = cut.lastIndexOf(' ');
    // A cut leaves no opened bracket or trailing separator behind.
    return balanced(space > MAX_TEAM_NAME / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:、，；：]+$/u, '') || cut.trim();
}
/** Turn a preset, the line's member assignments and the goal into the arguments of `agent_teams_create`. */
export function buildTeamPlan(input) {
    const { preset, goal } = input, members = [], summary = [];
    for (const member of preset.members) {
        const spec = input.overrides.get(member.name) ?? (member.cli ? { cli: member.cli, model: member.model, effort: member.effort } : {});
        const base = { name: member.name, ...(member.role ? { role: member.role } : {}) };
        if (!spec.cli) {
            members.push(base);
            summary.push(`${member.name} → the captain's model`);
            continue;
        }
        const cli = spec.cli, label = PROVIDER_LABELS[cli];
        const found = input.catalogs.flatMap(catalog => catalog.providers.filter(provider => provider.id === cli && provider.status === 'ready').map(provider => ({ catalog, provider }))).find(Boolean);
        if (!found) {
            throw new RemoteError(input.catalogs.length ? `${label} is not available on ${input.catalogs.map(catalog => catalog.hostLabel).join(', ')}; enable it in Settings → Remote agents and refresh models`
                : `This conversation is not in a remote workspace, so ${member.name} cannot use ${label}`);
        }
        const model = pickModel(cli, found.provider, spec.model), effort = pickEffort(model, spec.effort);
        members.push({ ...base, provider: chatProviderId(cli), model: chatModelId(found.catalog.projectId, cli, model.id), ...(effort ? { reasoning_effort: effort } : {}) });
        summary.push(`${member.name} → ${label} ${model.label}${effort ? ` (${effort})` : ''} on ${found.catalog.hostLabel}`);
    }
    const fill = (text) => text.replaceAll('{goal}', goal);
    const tasks = preset.tasks.map(task => ({ id: task.id, subject: fill(task.subject), ...(task.description ? { description: fill(task.description) } : {}), ...(task.assignee ? { assignee: task.assignee } : {}), dependencies: task.dependencies ?? [] }));
    if (!tasks.length)
        throw new RemoteError(`Preset ${preset.id} has no tasks; add one so the members have work`);
    const name = (input.name ?? teamNameOf(goal)).trim();
    if (!name)
        throw new RemoteError('The team needs a name');
    return { arguments: { name, description: goal, approval: input.review ? 'required' : 'automatic', plan: { members, tasks } }, summary };
}
