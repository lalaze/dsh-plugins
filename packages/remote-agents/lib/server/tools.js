import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { busy, questionsOf, remotePath } from './domain.js';
const POLL_MS = 500, DEFAULT_WAIT = 1800, MAX_WAIT = 7200, MAX_REPLY = 20_000;
const string = (description) => ({ type: 'string', description });
const params = (properties, required) => ({ type: 'object', properties, required });
const timeoutParam = { type: 'integer', description: `Seconds to wait before returning while the agent keeps running (default ${DEFAULT_WAIT}, max ${MAX_WAIT}).` };
const waitParam = { type: 'boolean', description: 'Wait for the agent to finish its turn and return its reply (default true). Use false to fan out several agents, then call remote_agent_wait.' };
const unrestricted = (mode) => /bypass|full.?access|danger|yolo|^auto$/i.test(mode.id);
const text = (value) => [{ type: 'text', text: value }];
function input(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Arguments must be an object');
    return raw;
}
function required(value, name) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`\`${name}\` is required`);
    return value.trim();
}
function optional(value, name) {
    if (value === undefined || value === null || value === '')
        return;
    return required(value, name);
}
function seconds(value) {
    if (value === undefined)
        return DEFAULT_WAIT;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
        throw new Error('`timeoutSeconds` must be a positive integer');
    return Math.min(value, MAX_WAIT);
}
function pick(choices, ref, what) {
    if (!ref)
        return;
    const key = ref.toLowerCase();
    const found = choices.find(c => c.id === ref) ?? choices.find(c => c.id.toLowerCase() === key || c.label.toLowerCase() === key);
    if (!found)
        throw new Error(`Unknown ${what} "${ref}". Available: ${choices.map(c => c.id).join(', ') || 'none'}`);
    return found;
}
function renderReports(result) {
    const lines = [];
    if (result.timedOut)
        lines.push('Stopped waiting before every agent finished. They keep running; call remote_agent_wait to keep waiting.', '');
    for (const agent of result.agents) {
        lines.push(`Agent ${agent.id} — ${agent.title}`, `${agent.provider} · ${agent.model}${agent.mode ? ` · ${agent.mode}` : ''} on ${agent.host}:${agent.cwd} — ${agent.status}`);
        if (agent.waitingFor?.length)
            lines.push(`Waiting for user input (call remote_agent_wait to show pending prompts): ${agent.waitingFor.join('; ')}`);
        if (agent.error)
            lines.push(`Error: ${agent.error}`);
        if (agent.reply)
            lines.push('Reply:', agent.reply);
        lines.push('');
    }
    return lines.join('\n').trim();
}
export async function decidePermission(host, permission, exec, signal, subject) {
    const questions = questionsOf(permission.input);
    if (permission.kind === 'question' && !permission.actions?.length) {
        if (!questions.length)
            return;
        const result = await host.userQuestions.ask({ agent: exec.agent, signal, questions: questions.map(q => ({ id: q.header, header: q.header, question: q.question, options: q.options, multiSelect: q.multiple })) });
        const answers = Object.fromEntries(questions.map(q => {
            const answer = result.answers?.find(a => a.id === q.header);
            return [q.header, [...(answer?.selected ?? []), ...(answer?.custom?.trim() ? [answer.custom.trim()] : [])].join(', ')];
        }));
        return questions.some(q => !q.optional && !answers[q.header]) ? undefined : { behavior: 'allow', answers };
    }
    const detail = JSON.stringify(permission.detail ?? permission.input ?? {}, null, 2).slice(0, 4000);
    const outcome = await host.approval.request({ agent: exec.agent, toolName: permission.name, callId: exec.callId, signal,
        reason: [`Remote agent ${subject} asks: ${permission.title ?? permission.name}`, permission.description, detail,
            permission.actions?.some(a => a.behavior === 'allow' && (a.scope === 'session' || a.scope === 'project')) ? 'To remember a matching approval, open Settings → Remote agents → Open sessions.' : undefined].filter(Boolean).join('\n') });
    const deny = permission.actions?.find(a => a.behavior === 'deny');
    if (outcome === 'rejected')
        return { behavior: 'deny', message: 'The user denied this request', ...(deny ? { selectedActionId: deny.id } : {}) };
    if (outcome !== 'allowed-once')
        return;
    // A one-time DSH approval must never silently grant a session-wide CLI permission.
    const action = permission.actions?.find(a => a.behavior === 'allow' && (!a.scope || a.scope === 'once') && !/session|project|always|remember/i.test(`${a.id} ${a.label}`));
    if (permission.actions?.length && !action)
        return;
    return { behavior: 'allow', ...(action ? { selectedActionId: action.id } : {}) };
}
/**
 * Paseo-style delegation for the DSH agent: start remote CLI agents, message them and collect their
 * replies. Permission requests are forwarded to the user as native DSH prompts while a call waits;
 * unanswered requests remain pending and can be shown again by another wait.
 */
export function delegationTools(host, service) {
    /** Prompts currently shown for `${agentId}:${permissionId}`, shared so parallel waits never ask twice. */
    const asking = new Map();
    const hostLabel = (id) => service.hosts().find(h => h.id === id)?.label ?? id;
    function findHost(ref) {
        const hosts = service.hosts(), key = ref.toLowerCase().replace(/^ssh:\/\//, '');
        // Accept the saved name, `user@host[:port]`, or the bare host/alias a model is likely to use.
        const names = (connection) => { const target = connection.toLowerCase().replace(/^ssh:\/\//, ''); return [target, target.replace(/^[^@]*@/, '').replace(/:\d+$/, '')]; };
        const found = hosts.filter(h => h.id === ref || h.label.toLowerCase() === key || names(h.connection).includes(key));
        if (found.length === 1)
            return found[0];
        throw new Error(found.length ? `Host "${ref}" is ambiguous; use its ID` : `Unknown remote host "${ref}". Saved hosts: ${hosts.map(h => h.label).join(', ') || 'none (add one in Settings → Remote agents)'}`);
    }
    async function findAgent(ref) {
        const { agents } = await service.snapshot();
        const exact = agents.find(a => a.id === ref);
        if (exact)
            return exact;
        const found = ref.length >= 6 ? agents.filter(a => a.id.startsWith(ref)) : [];
        if (found.length === 1)
            return found[0];
        throw new Error(found.length ? `Agent ID prefix "${ref}" is ambiguous` : `Unknown remote agent "${ref}". Call remote_agent_list to see agent IDs.`);
    }
    const subject = (agent) => `"${agent.title}" (${agent.provider} on ${hostLabel(agent.hostId)}:${agent.cwd})`;
    async function report(states, deferred, timedOut) {
        return { timedOut, agents: await Promise.all(states.map(async ({ agent, permissions }) => {
                const finished = !busy(agent);
                let reply = finished ? (await service.reply(agent.id)).trim() : '';
                if (reply.length > MAX_REPLY)
                    reply = `[earlier output truncated]\n${reply.slice(-MAX_REPLY)}`;
                const waitingFor = permissions.filter(p => deferred.has(`${agent.id}:${p.id}`)).map(p => p.title ?? p.name);
                const mode = agent.modes.find(m => m.id === agent.modeId)?.label ?? agent.modeId;
                return { id: agent.id, title: agent.title, host: hostLabel(agent.hostId), cwd: agent.cwd, provider: agent.provider, model: agent.model, ...(mode ? { mode } : {}), status: agent.status, ...(agent.error ? { error: agent.error } : {}), ...(waitingFor.length ? { waitingFor } : {}), ...(reply ? { reply } : {}) };
            })) };
    }
    async function settle(ids, exec, timeout) {
        const deadline = Date.now() + timeout * 1000, mine = new Set(), deferred = new Set();
        try {
            while (true) {
                exec.signal.throwIfAborted();
                const states = await Promise.all(ids.map(id => service.state(id)));
                const pending = new Set(states.flatMap(s => s.permissions.map(p => `${s.agent.id}:${p.id}`)));
                for (const key of mine)
                    if (!pending.has(key))
                        asking.get(key)?.abort(); // Answered by another waiter.
                let waiting = false;
                for (const { agent, permissions } of states) {
                    if (agent.status === 'starting' || agent.status === 'running')
                        waiting = true;
                    for (const permission of permissions) {
                        const key = `${agent.id}:${permission.id}`;
                        if (deferred.has(key))
                            continue;
                        if (!exec.agent) {
                            deferred.add(key);
                            continue;
                        }
                        waiting = true;
                        if (asking.has(key))
                            continue;
                        const controller = new AbortController();
                        asking.set(key, controller);
                        mine.add(key);
                        void decidePermission(host, permission, exec, AbortSignal.any([exec.signal, controller.signal]), subject(agent))
                            .then(answer => answer ? service.respond(agent.id, permission.id, answer) : void deferred.add(key))
                            .catch(() => { deferred.add(key); })
                            .finally(() => { if (asking.get(key) === controller)
                            asking.delete(key); mine.delete(key); });
                    }
                }
                if (!waiting)
                    return report(states, deferred, false);
                if (Date.now() >= deadline)
                    return report(states, deferred, true);
                await pause(POLL_MS, undefined, { signal: exec.signal });
            }
        }
        finally {
            for (const key of mine)
                asking.get(key)?.abort();
        }
    }
    const reportOutput = { schema: {}, render: (_args, value) => text(renderReports(value)) };
    return [
        {
            name: 'remote_agent_list',
            description: 'List saved remote SSH hosts, recently used remote project directories, and remote coding agents (Claude Code, Codex, DSH, Grok, CodeBuddy or Antigravity CLIs running on those hosts) with their status. Use it to find a host name, project path or agent ID.',
            parameters: params({ includeArchived: { type: 'boolean', description: 'Include archived agents (default false).' } }, []),
            output: { schema: {}, render: (_args, value) => {
                    const v = value;
                    return text([
                        `Hosts: ${v.hosts.map(h => `${h.name} (${h.connection}, ${h.status})`).join('; ') || 'none. The user can add one in Settings → Remote agents.'}`,
                        `Recent projects: ${v.projects.map(p => `${p.host}:${p.cwd}`).join('; ') || 'none'}`,
                        'Agents:', ...v.agents.map(a => `- ${a.id} ${a.status.padEnd(9)} ${a.provider} · ${a.model} on ${a.host}:${a.cwd} — ${a.title}`),
                    ].join('\n'));
                } },
            isConcurrencySafe: () => true,
            async execute(raw) {
                const args = input(raw), { hosts, agents } = await service.snapshot();
                const visible = agents.filter(a => args.includeArchived === true || !a.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
                const projects = [...new Map(visible.map(a => [`${a.hostId}\0${a.cwd}`, { host: hostLabel(a.hostId), cwd: a.cwd }])).values()];
                return {
                    hosts: hosts.map(h => ({ name: h.label, connection: h.connection, status: h.status })), projects,
                    agents: visible.slice(0, 100).map(a => ({ id: a.id, title: a.title, host: hostLabel(a.hostId), cwd: a.cwd, provider: a.provider, model: a.model, status: a.archived ? 'archived' : a.status })),
                };
            },
        },
        {
            name: 'remote_agent_providers',
            description: 'Check which coding CLIs are installed and signed in on a remote host for a project directory, with their models, permission modes and thinking levels. Call this before remote_agent_create when unsure which provider or model to use.',
            parameters: params({ host: string('Saved host name, SSH alias or host ID.'), cwd: string('Absolute project directory on that host.'), refresh: { type: 'boolean', description: 'Ignore the 30-second discovery cache.' } }, ['host', 'cwd']),
            output: { schema: {}, render: (_args, value) => text(value.providers.map(p => p.status !== 'ready'
                    ? `${p.id} (${p.label}): ${p.status}${p.error ? ` — ${p.error}` : ''}`
                    : [`${p.id} (${p.label}): ready${p.notice ? ` — ${p.notice}` : ''}`, `  models: ${p.models.map(m => `${m.id}${m.thinking.length ? ` [thinking: ${m.thinking.join('/')}]` : ''}`).join(', ')}`, `  modes: ${p.modes.map(m => `${m.id}${m.id === p.defaultMode ? ' (default)' : ''}`).join(', ') || 'CLI settings'}`].join('\n')).join('\n')) },
            isConcurrencySafe: () => true,
            async execute(raw) {
                const args = input(raw), target = findHost(required(args.host, 'host'));
                const providers = await service.providers(target.id, remotePath(args.cwd), args.refresh === true);
                return { providers: providers.map(p => ({ id: p.id, label: p.label, status: p.status, ...(p.error ? { error: p.error } : {}), ...(p.notice ? { notice: p.notice } : {}),
                        models: p.models.map(m => ({ id: m.id, label: m.label, ...(m.isDefault ? { default: true } : {}), thinking: (m.thinkingOptions ?? []).map(o => o.id) })),
                        modes: p.modes.map(m => ({ id: m.id, label: m.label })), ...(p.defaultModeId ? { defaultMode: p.defaultModeId } : {}) })) };
            },
        },
        {
            name: 'remote_agent_create',
            description: 'Start a coding CLI agent on a remote SSH host, in an absolute project directory on that machine, with an initial task. The agent works with its own tools, credentials and configuration and cannot see this conversation, so `prompt` must be self-contained: the goal, relevant context and file paths, constraints, and exactly what to report back. By default this waits for the agent to finish its turn and returns its reply. Use remote_agent_list to inspect agents and remote_agent_send to steer them.',
            parameters: params({
                host: string('Saved host name, SSH alias or host ID.'), cwd: string('Absolute project directory on the remote host.'),
                provider: string('CLI provider ID: claude, codex, dsh, grok, codebuddy or antigravity.'), prompt: string('Complete, self-contained task for the agent.'),
                model: string('Model ID or name. Defaults to the CLI default model.'), mode: string('Permission mode ID. Defaults to the CLI default, which asks before risky actions.'),
                thinking: string('Thinking level ID, when the model supports it.'), title: string('Short title (at most 100 characters).'),
                wait: waitParam, timeoutSeconds: timeoutParam,
            }, ['host', 'cwd', 'provider', 'prompt']),
            output: reportOutput,
            isConcurrencySafe: () => true,
            async execute(raw, exec) {
                const args = input(raw), target = findHost(required(args.host, 'host')), cwd = remotePath(args.cwd), prompt = required(args.prompt, 'prompt'), timeout = seconds(args.timeoutSeconds);
                const providers = await service.providers(target.id, cwd);
                const provider = pick(providers, required(args.provider, 'provider'), 'provider');
                if (provider.status !== 'ready')
                    throw new Error(`${provider.label} is ${provider.status} on ${target.label}${provider.error ? `: ${provider.error}` : ''}`);
                const model = pick(provider.models, optional(args.model, 'model'), 'model') ?? provider.models.find(m => m.isDefault) ?? provider.models[0];
                const mode = pick(provider.modes, optional(args.mode, 'mode'), 'mode') ?? provider.modes.find(m => m.id === provider.defaultModeId);
                const thinking = pick(model.thinkingOptions ?? [], optional(args.thinking, 'thinking'), 'thinking level') ?? model.thinkingOptions?.find(o => o.id === model.defaultThinkingOptionId);
                if (mode && unrestricted(mode)) {
                    // The remote CLI would act without per-action approval; that needs the user's explicit consent.
                    const outcome = exec.agent ? await host.approval.request({ agent: exec.agent, toolName: 'remote_agent_create', callId: exec.callId, signal: exec.signal,
                        reason: `Start ${provider.label} on ${target.label}:${cwd} in "${mode.label}" mode. It will not ask before running commands or editing files.` }) : 'unavailable';
                    if (outcome !== 'allowed-once')
                        throw new Error(`Starting a remote agent in "${mode.label}" mode needs the user's approval (${outcome}). Use a mode that asks before acting.`);
                }
                const created = await service.create({ id: randomUUID(), hostId: target.id, cwd, provider: provider.id, model: model.id, prompt, ...(mode ? { modeId: mode.id } : {}), ...(thinking ? { thinkingOptionId: thinking.id } : {}) }, { origin: 'dsh', ...(optional(args.title, 'title') ? { title: optional(args.title, 'title').slice(0, 100) } : {}) });
                if (created.status === 'error')
                    throw new Error(`The remote agent did not start: ${created.error ?? 'unknown error'}. Agent ${created.id} is saved; use remote_agent_list to inspect its status.`);
                return args.wait === false ? report([await service.state(created.id)], new Set(), false) : settle([created.id], exec, timeout);
            },
        },
        {
            name: 'remote_agent_send',
            description: 'Send a follow-up message to an existing remote agent (full ID or a unique prefix of at least 6 characters). If the agent is still working this fails, unless interrupt=true stops its current turn first. Waits for the reply by default.',
            parameters: params({ agentId: string('Agent ID or unique prefix.'), prompt: string('Message for the agent.'), interrupt: { type: 'boolean', description: 'Stop a running turn before sending (default false).' }, wait: waitParam, timeoutSeconds: timeoutParam }, ['agentId', 'prompt']),
            output: reportOutput,
            isConcurrencySafe: () => true,
            async execute(raw, exec) {
                const args = input(raw), agent = await findAgent(required(args.agentId, 'agentId')), prompt = required(args.prompt, 'prompt'), timeout = seconds(args.timeoutSeconds);
                await service.send(agent.id, { id: randomUUID(), text: prompt }, { interrupt: args.interrupt === true });
                return args.wait === false ? report([await service.state(agent.id)], new Set(), false) : settle([agent.id], exec, timeout);
            },
        },
        {
            name: 'remote_agent_wait',
            description: 'Wait until one or more remote agents finish their current turns, then return their status and latest replies. Permission requests are shown to the user while waiting. A timeout returns the current status without stopping the agents.',
            parameters: params({ agentIds: { type: 'array', items: { type: 'string' }, description: 'Agent IDs or unique prefixes.' }, timeoutSeconds: timeoutParam }, ['agentIds']),
            output: reportOutput,
            isConcurrencySafe: () => true,
            async execute(raw, exec) {
                const args = input(raw);
                if (!Array.isArray(args.agentIds) || !args.agentIds.length || args.agentIds.length > 20)
                    throw new Error('`agentIds` must list 1 to 20 agents');
                const ids = [...new Set(await Promise.all(args.agentIds.map(async (ref) => (await findAgent(required(ref, 'agentIds[]'))).id)))];
                return settle(ids, exec, seconds(args.timeoutSeconds));
            },
        },
        {
            name: 'remote_agent_stop',
            description: 'Interrupt a remote agent’s current turn. The agent stays available for follow-up messages.',
            parameters: params({ agentId: string('Agent ID or unique prefix.') }, ['agentId']),
            output: reportOutput,
            isConcurrencySafe: () => true,
            async execute(raw) {
                const agent = await findAgent(required(input(raw).agentId, 'agentId'));
                await service.stop(agent.id);
                return report([await service.state(agent.id)], new Set(), false);
            },
        },
    ];
}
