import { PROVIDER_LABELS, record, RemoteError } from '../core/domain.js';
export const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MEMBER_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u;
export const MAX_PRESETS = 32, MAX_MEMBERS = 8, MAX_TASKS = 32;
export const CAPTAIN_SPEC = 'captain';
const CLIS = Object.keys(PROVIDER_LABELS);
const WORK = 'Do the work the team goal describes in this workspace. Run the relevant checks or tests. Report what you changed and how you verified it.';
const REVIEW = 'Review the result of the previous task (its report and the changed files) against the team goal. Fix clear defects directly, run the checks again, and report your findings and what you changed.';
/** Presets every installation has; a saved preset with the same id replaces it. */
export const BUILTIN_PRESETS = [
    { id: 'solo', members: [{ name: 'coder', role: 'implement' }], tasks: [{ id: 'work', subject: '{goal}', description: WORK, assignee: 'coder' }] },
    { id: 'pair', members: [{ name: 'coder', role: 'implement' }, { name: 'reviewer', role: 'review' }], tasks: [
            { id: 'work', subject: '{goal}', description: WORK, assignee: 'coder' },
            { id: 'review', subject: 'Review: {goal}', description: REVIEW, assignee: 'reviewer', dependencies: ['work'] },
        ] },
];
/** Names of models and thinking levels match whatever their case. */
export const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
/** The models a name can mean: the one it names exactly, else every model whose id or label contains it. */
export function modelsNamed(models, wanted) {
    const exact = models.find(model => model.id === wanted) ?? models.find(model => sameName(model.id, wanted) || sameName(model.label, wanted));
    if (exact)
        return [exact];
    const lower = wanted.toLowerCase();
    return models.filter(model => model.id.toLowerCase().includes(lower) || model.label.toLowerCase().includes(lower));
}
/**
 * The order a preset's tasks run in, as AgentTeams' scheduler gives work out: a task waits for its dependencies, and a
 * member does one task at a time, in list order. Tasks in one step can run together. `stuck` tasks wait on each other.
 */
export function taskOrder(tasks) {
    const stepOf = new Map(), lastOf = new Map(), steps = [];
    const known = new Set(tasks.map(task => task.id));
    let waiting = [...tasks];
    for (let placed = true; placed && waiting.length;) {
        placed = false;
        for (const task of [...waiting]) {
            const dependencies = (task.dependencies ?? []).filter(id => known.has(id));
            if (!dependencies.every(id => stepOf.has(id)))
                continue;
            const step = Math.max(0, ...dependencies.map(id => stepOf.get(id) + 1), task.assignee ? lastOf.get(task.assignee) ?? 0 : 0);
            stepOf.set(task.id, step);
            if (task.assignee)
                lastOf.set(task.assignee, step + 1);
            (steps[step] ??= []).push(task);
            waiting = waiting.filter(other => other !== task);
            placed = true;
        }
    }
    return { steps: steps.filter(Boolean), stuck: waiting };
}
/** Members the scheduler never starts: nothing is assigned to them and no task is open to any member. */
export function membersWithoutWork(preset) {
    if (preset.tasks.some(task => !task.assignee))
        return [];
    return preset.members.filter(member => member.name && !preset.tasks.some(task => task.assignee === member.name));
}
/** Saved presets first, then the built-ins they do not replace. */
export function allPresets(saved) {
    return [...saved, ...BUILTIN_PRESETS.filter(preset => !saved.some(own => own.id === preset.id))];
}
const optional = (value, label, max) => {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value))
        throw new RemoteError(`Invalid ${label}`);
    return value.trim() || undefined;
};
/** The CLI id for a user-typed name: `Codex`, `codex` and `claude` all resolve. */
export function cliOf(value) {
    const lower = value.trim().toLowerCase();
    return CLIS.find(id => id === lower || PROVIDER_LABELS[id].toLowerCase() === lower);
}
function memberInput(raw, index) {
    const value = record(raw), name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!MEMBER_NAME.test(name))
        throw new RemoteError(`Invalid member name in member ${index + 1}`);
    if (name.toLowerCase() === CAPTAIN_SPEC)
        throw new RemoteError('A member cannot be named captain');
    const cliName = optional(value.cli, 'member CLI', 40), cli = cliName === undefined ? undefined : cliOf(cliName);
    if (cliName !== undefined && !cli)
        throw new RemoteError(`Unknown CLI "${cliName}" for member ${name}`);
    const model = optional(value.model, 'member model', 200), effort = optional(value.effort, 'member thinking level', 50);
    if (!cli && (model || effort))
        throw new RemoteError(`Member ${name} names a model without a CLI`);
    return { name, ...(optional(value.role, 'member role', 100) ? { role: optional(value.role, 'member role', 100) } : {}), ...(cli ? { cli } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
function taskInput(raw, index, members) {
    const value = record(raw), id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id))
        throw new RemoteError(`Invalid task id in task ${index + 1}`);
    const subject = optional(value.subject, `subject of task ${id}`, 500);
    if (!subject)
        throw new RemoteError(`Task ${id} needs a subject`);
    const description = optional(value.description, `description of task ${id}`, 4000), assignee = optional(value.assignee, `assignee of task ${id}`, 40);
    if (assignee && !members.some(member => member.name === assignee))
        throw new RemoteError(`Task ${id} is assigned to "${assignee}", who is not a member`);
    const raws = value.dependencies === undefined || value.dependencies === null ? [] : value.dependencies;
    if (!Array.isArray(raws) || raws.length > MAX_TASKS || !raws.every(item => typeof item === 'string'))
        throw new RemoteError(`Invalid dependencies of task ${id}`);
    const dependencies = [...new Set(raws.map(item => item.trim()).filter(Boolean))];
    if (dependencies.includes(id))
        throw new RemoteError(`Task ${id} depends on itself`);
    return { id, subject, ...(description ? { description } : {}), ...(assignee ? { assignee } : {}), ...(dependencies.length ? { dependencies } : {}) };
}
/** Validate one preset as saved or sent by the settings page. */
export function teamPresetInput(raw) {
    const value = record(raw), id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : '';
    if (!PRESET_ID.test(id))
        throw new RemoteError('A preset id uses 1-32 lowercase letters, digits or dashes');
    const label = optional(value.label, 'preset name', 100);
    if (!Array.isArray(value.members) || !value.members.length)
        throw new RemoteError('A preset needs at least one member');
    if (value.members.length > MAX_MEMBERS)
        throw new RemoteError(`A preset has up to ${MAX_MEMBERS} members`);
    const members = value.members.map(memberInput);
    const names = members.map(member => member.name.toLowerCase());
    if (new Set(names).size !== names.length)
        throw new RemoteError('Member names must be different');
    const taskList = value.tasks === undefined || value.tasks === null ? [] : value.tasks;
    if (!Array.isArray(taskList) || taskList.length > MAX_TASKS)
        throw new RemoteError(`A preset has up to ${MAX_TASKS} tasks`);
    const tasks = taskList.map((task, index) => taskInput(task, index, members));
    if (new Set(tasks.map(task => task.id)).size !== tasks.length)
        throw new RemoteError('Task ids must be different');
    for (const task of tasks)
        for (const dependency of task.dependencies ?? [])
            if (!tasks.some(other => other.id === dependency))
                throw new RemoteError(`Task ${task.id} depends on unknown task "${dependency}"`);
    // A cycle would be rejected by AgentTeams only after the command ran: find it here.
    const visiting = new Set(), done = new Set();
    const visit = (id) => {
        if (done.has(id))
            return;
        if (visiting.has(id))
            throw new RemoteError(`Tasks depend on each other in a cycle through ${id}`);
        visiting.add(id);
        for (const dependency of tasks.find(task => task.id === id)?.dependencies ?? [])
            visit(dependency);
        visiting.delete(id);
        done.add(id);
    };
    for (const task of tasks)
        visit(task.id);
    return { id, ...(label ? { label } : {}), members, tasks };
}
/** `codex`, `codex/gpt-5`, `claude/opus@high` or `captain`. */
export function parseMemberSpec(spec) {
    const text = spec.trim();
    if (!text)
        throw new RemoteError('A member needs a CLI after "=", for example coder=codex');
    if (text.toLowerCase() === CAPTAIN_SPEC)
        return { captain: true };
    const at = text.lastIndexOf('@'), route = at === -1 ? text : text.slice(0, at), effort = at === -1 ? undefined : text.slice(at + 1).trim();
    if (at !== -1 && !effort)
        throw new RemoteError(`"${text}" names no thinking level after @`);
    const slash = route.indexOf('/'), cliName = slash === -1 ? route : route.slice(0, slash), model = slash === -1 ? undefined : route.slice(slash + 1).trim();
    const cli = cliOf(cliName);
    if (!cli)
        throw new RemoteError(`Unknown CLI "${cliName}": use ${CLIS.join(', ')} or ${CAPTAIN_SPEC}`);
    if (slash !== -1 && !model)
        throw new RemoteError(`"${text}" names no model after /`);
    return { cli, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
/**
 * `/team [preset] [member=cli[/model][@effort] …] [--plan] [--name <team>] <goal>`. Options and member
 * assignments lead; the goal is the rest of the line as typed. A leading word that names a preset selects it.
 */
export function parseTeamCommand(rawInput, presetIds) {
    const members = new Map();
    let preset, review = false, name, goal = '';
    const tokens = [...rawInput.matchAll(/\S+/g)];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index][0], next = tokens[index + 1];
        if (token === '--plan') {
            review = true;
            continue;
        }
        if (token === '--name' || token.startsWith('--name=')) {
            const value = token === '--name' ? next?.[0] : token.slice('--name='.length);
            if (!value)
                throw new RemoteError('--name needs a team name');
            name = value;
            if (token === '--name')
                index++;
            continue;
        }
        if (token.startsWith('--'))
            throw new RemoteError(`Unknown option ${token}`);
        const equals = token.indexOf('=');
        if (equals > 0 && MEMBER_NAME.test(token.slice(0, equals))) {
            const member = token.slice(0, equals);
            if (member.toLowerCase() === CAPTAIN_SPEC)
                throw new RemoteError('The captain is this conversation; assign CLIs to members');
            members.set(member, parseMemberSpec(token.slice(equals + 1)));
            continue;
        }
        if (preset === undefined && presetIds.includes(token.toLowerCase())) {
            preset = token.toLowerCase();
            continue;
        }
        goal = rawInput.slice(tokens[index].index).trim();
        break;
    }
    return { ...(preset === undefined ? {} : { preset }), members, goal, review, ...(name === undefined ? {} : { name }) };
}
/** The preset a line selects: the named one, else the first whose members cover every assignment. */
export function choosePreset(invocation, presets) {
    if (invocation.preset !== undefined) {
        const preset = presets.find(candidate => candidate.id === invocation.preset);
        if (!preset)
            throw new RemoteError(`Unknown team preset "${invocation.preset}"`);
        return preset;
    }
    const names = [...invocation.members.keys()];
    const preset = presets.find(candidate => names.every(name => candidate.members.some(member => member.name === name)));
    if (!preset)
        throw new RemoteError(`No team preset has members named ${names.join(', ')}; presets: ${presets.map(p => `${p.id} (${p.members.map(m => m.name).join(', ')})`).join('; ')}`);
    return preset;
}
