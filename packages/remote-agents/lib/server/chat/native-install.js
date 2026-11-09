import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { join } from 'node:path';
import { RemoteError } from '../core/domain.js';
import { validateNative, validateNativeInput, portableInboxAudit, nativeSelection, NATIVE_CLOSED_PROVIDER } from './native-protocol.js';
import { exportNativeAttachments, importNativeAttachments } from './native-attachments.js';
import { installNativeAgentAliases } from './native-agent-aliases.js';
import { nativeHostAdapter } from './native-host-adapter.js';
import { nativeRuntimeAutonomy } from './native-runtime-autonomy.js';
import { nativeLocalDirectory } from './native-placement.js';
import { NativeSharing } from './native-service.js';
const CLOSED = { provider: NATIVE_CLOSED_PROVIDER, model: 'Use Continue here in Remote agents settings' };
const selectionOf = (snapshot) => {
    const selection = nativeSelection(snapshot.events);
    if (!selection?.provider || !selection?.model || selection.provider === 'remote-cli' || selection.provider.startsWith('remote-cli-') || selection.provider === CLOSED.provider)
        throw new RemoteError('Select an available ordinary model before sharing; remote CLI fallback is not supported', 409);
    return selection;
};
/** All type-erased accesses below are to the audited 0.2.2-rc.1 host seams, not the older SDK type facade. */
export async function installNativeSharing(ctx, service, workspace) {
    const get = (name) => ctx.get(name);
    const inflight = new Map(), handles = new Map(), admissions = new Map();
    const adapter = nativeHostAdapter(ctx);
    const quiescing = new Set();
    const countedRoots = new Map();
    const replicaOf = (id, session) => {
        const seen = new Set();
        for (let current = id; current && !seen.has(current);) {
            seen.add(current);
            const replica = sharing.replica(current);
            if (replica)
                return replica;
            const subject = current === id && session ? session : get('sessions')?.get(SessionId(current));
            // An ordinary fork's parentSession is provenance, not live authority.
            current = subject?.header.origin === 'subagent' ? subject.header.parentSession : undefined;
        }
    };
    const rootOf = (id) => replicaOf(id)?.sessionId ?? countedRoots.get(id)?.root ?? id;
    const count = (id) => inflight.get(rootOf(id)) ?? 0;
    const enter = (id) => {
        const entry = countedRoots.get(id) ?? { root: rootOf(id), depth: 0 };
        entry.depth++;
        countedRoots.set(id, entry);
        inflight.set(entry.root, (inflight.get(entry.root) ?? 0) + 1);
    };
    const leave = (id) => {
        const entry = countedRoots.get(id);
        if (!entry)
            return;
        const n = (inflight.get(entry.root) ?? 1) - 1;
        if (n)
            inflight.set(entry.root, n);
        else
            inflight.delete(entry.root);
        if (!--entry.depth)
            countedRoots.delete(id);
    };
    const ready = () => ['sessionQuery', 'sessionPersistence', 'sessions', 'agents', 'sandboxPolicy', 'approval', 'permissionPresets', 'commands', 'workspaceRegistry', 'llm', 'tools', 'loader'].every(n => !!get(n)) && typeof get('sessionQuery')?.observeSession === 'function' && typeof get('tools')?.guard === 'function' && (!get('sessionTitle') || typeof get('sessionTitle').runProvider === 'function');
    const requireReady = () => { if (!ready())
        throw new RemoteError('Native sharing needs the audited DSH session query, persistence, permissions and tool guard services', 501); };
    const safePreset = () => {
        const presets = get('permissionPresets');
        let preset = 'workspace-write';
        try {
            if (presets.resolve('read-only').sandbox === 'read-only')
                preset = 'read-only';
        }
        catch { /* Standard DSH has only workspace-write and full access. */ }
        const spec = presets.resolve(preset);
        if (spec.sandbox === 'danger-full-access' || spec.approval !== 'ask')
            throw new Error('No safe receiver permission preset is configured');
        return preset;
    };
    const safePermissions = (session) => {
        get('permissionPresets').set(session, safePreset());
        session.append('sandbox/mode', { mode: 'read-only' });
        session.append('approval/policy', { policy: 'ask' });
    };
    const idle = async (id, operation) => {
        const agent = get('agents')?.get(id);
        if (get('agents')?.list().some((a) => rootOf(a.id) === id && (a.status === 'running' || (!host.autonomy && (a.inbox?.nextTurn?.length || a.inbox?.nextStep?.length)))))
            throw new RemoteError('Native conversation is busy or queued', 409);
        const run = async () => {
            quiescing.add(id);
            try {
                // Native title providers commit after their stream iterator settles.
                // Keep their stream admission counted through that microtask chain.
                await new Promise(resolve => setImmediate(resolve));
                if (count(id) > 0)
                    throw new RemoteError('Background model call is still active', 409);
                return await operation();
            }
            finally {
                quiescing.delete(id);
            }
        };
        if (agent) {
            if (typeof agent.runMaintenance !== 'function')
                throw new RemoteError('DSH native maintenance hook is unavailable', 501);
            return agent.runMaintenance(run);
        }
        return run();
    };
    const host = {
        available: ready,
        async placement(id, hostId) {
            requireReady();
            const local = await host.sourceDirectory(id);
            if (local)
                return sharing.placements.source(hostId, local);
            const result = await workspace.placement(id, AbortSignal.timeout(10_000));
            if (!result.hostIds.includes(hostId) || !result.cwd)
                throw new RemoteError('Remote workspace must be verified on the selected sharing host', 409);
            return result.cwd;
        },
        async sourceDirectory(id) {
            requireReady();
            let cwd = get('sessions').get(SessionId(id))?.header.cwd;
            if (!cwd) {
                const observed = await get('sessionQuery').observeSession(id, { projectionMode: 'none' });
                try {
                    cwd = observed.header.cwd;
                }
                finally {
                    observed[Symbol.dispose]();
                }
            }
            if (!cwd)
                throw new RemoteError('Select a project directory before sharing this conversation', 409);
            const result = await workspace.access.resolve(cwd, AbortSignal.timeout(10_000));
            return result.cwd && result.hostIds.length ? undefined : nativeLocalDirectory(cwd);
        },
        async resolvePlacement(_hostId, project) { return { kind: 'remote', project }; },
        idle,
        async snapshot(id, project) {
            requireReady();
            if (count(id) > 0)
                throw new RemoteError('Background model call is still active', 409);
            const agent = get('agents').get(id);
            if (!host.autonomy && (agent?.inbox.nextTurn.length || agent?.inbox.nextStep.length))
                throw new RemoteError('Settle queued messages before handoff', 409);
            if (get('jobs')?.list(id)?.some((j) => !['completed', 'killed', 'failed'].includes(j.status)))
                throw new RemoteError('Finish or stop physical jobs before native handoff', 409);
            if (agent)
                await get('sessions').flush(agent.session);
            const observed = await get('sessionQuery').observeSession(id, { projectionMode: 'none' });
            try {
                const events = portableInboxAudit(structuredClone(observed.events), sharing.recoveryInput(rootOf(id)));
                if (observed.cursor !== events.length - 1)
                    throw new RemoteError('Native session observation cursor is inconsistent', 409);
                const files = await exportNativeAttachments(get('attachments'), events);
                const title = [...events].reverse().find((e) => e.type === 'session/title')?.data?.title ?? 'Shared native conversation';
                return { protocol: 'shared-native-v1', header: structuredClone(observed.header), inheritedEventCount: observed.inheritedEventCount, events, files, project, title };
            }
            finally {
                observed[Symbol.dispose]();
            }
        },
        async validate(snapshot) {
            requireReady();
            validateNative(snapshot, { treeChild: snapshot.header.origin === 'subagent', allowParked: !!snapshot.autonomy });
            if (snapshot.events.some(e => e.type === 'goal/change')) {
                if (!get('goals'))
                    throw new RemoteError('Receiver native goals service is unavailable', 501);
                (await adapter.load('@deepseek-ai/dsh-goal')).foldGoal(snapshot.events);
            }
            if (snapshot.events.some(e => e.type === 'image/offload') && !get('sessions').messageProjections?.some((p) => p.type === 'image/offload'))
                throw new RemoteError('Receiver needs its native compaction-image-offload projection to restore this history', 501);
            if (snapshot.events.some(e => e.type === 'working-directory/change') && !get('workingDirectory'))
                throw new RemoteError('Receiver needs the native working-directory service to rebuild this runtime state', 501);
            const selection = selectionOf(snapshot), models = await get('llm').listModels(selection.provider);
            if (!models.some((model) => model.id === selection.model))
                throw new RemoteError(`Ordinary model unavailable: ${selection.provider}/${selection.model}. Install/configure it on the receiver; no fallback is selected.`, 409);
            await get('llm').resolveCallConfig(selection);
            safePreset();
            if (!get('sandboxPolicy') || !get('approval'))
                throw new RemoteError('Receiver sandbox/approval enforcement is unavailable', 501);
        },
        async import(id, hostId, snapshot, mirror, binding) {
            requireReady();
            await host.validate(snapshot);
            if (binding && binding.project !== snapshot.project)
                throw new RemoteError('Fixed receiver project binding is inconsistent', 409);
            let path;
            if (binding?.kind === 'local') {
                path = nativeLocalDirectory(binding.localDirectory);
                if (path !== binding.localDirectory)
                    throw new RemoteError('Fixed local project directory changed; preserve the claim and reconcile its mapping', 409);
            }
            else {
                path = (await workspace.workspaces.create(hostId, snapshot.project, AbortSignal.timeout(20_000))).path;
                const placement = await workspace.access.resolve(path, AbortSignal.timeout(10_000));
                if (!placement.hostIds.includes(hostId) || placement.cwd !== snapshot.project)
                    throw new RemoteError('Receiver workspace mapping changed', 409);
            }
            const persistence = get('sessionPersistence');
            // create is exclusive; never open a pre-existing native identity for writing.
            const preset = await get('agentPresets')?.resolve(undefined);
            const header = { ...snapshot.header, id: SessionId(id), cwd: path, ...(preset ? { agentPreset: preset.id } : {}) };
            const handle = await persistence.create(header, { inheritedEventCount: snapshot.inheritedEventCount });
            try {
                await importNativeAttachments(get('attachments'), snapshot.files, adapter.load);
                const detached = Session.create(SessionId(id), snapshot.events, header, snapshot.inheritedEventCount, get('sessions').messageProjections);
                // A source directory is not a receiver capability. Keep its raw audit
                // records but reinitialize the effective cwd to the fixed local project.
                // This metadata event is legal outside a turn and queues no notice/work.
                if (snapshot.events.some(e => e.type === 'working-directory/change'))
                    detached.append('working-directory/change', { cwd: path });
                if (snapshot.header.origin === 'subagent' && !mirror)
                    safePermissions(detached);
                if (mirror) {
                    if (preset)
                        detached.append('agent-preset/selected', { agentPreset: preset.id });
                    safePermissions(detached);
                    detached.append('model/selection', CLOSED);
                }
                await handle.append(detached.snapshotEvents());
                await handle.flush();
            }
            finally {
                await handle.close();
            }
            const target = await get('workspaceRegistry').create(path);
            await target.attachSession(SessionId(id));
        },
        async activate(id) {
            if (get('agents').get(id))
                return;
            // Own the continuation's handle. Compose the RECEIVER preset, never a
            // source machine preset restored by the GUI controller's generic route.
            const handle = await get('agents').resume({ resumeSessionId: SessionId(id), setup: adapter.setup });
            try {
                await get('sessions').flush(handle.agent.session);
                handles.set(id, handle);
            }
            catch (error) {
                await handle.dispose();
                throw error;
            }
        },
        async seal(id) {
            const agent = get('agents')?.get(id);
            if (agent) {
                agent.model.select(CLOSED);
                await get('sessions').flush(agent.session);
                return;
            }
            // A newly imported cold mirror has no GUI writer; append its durable closed route through the native handle.
            let handle;
            try {
                handle = await get('sessionPersistence').open(SessionId(id), 'write');
            }
            catch (error) {
                if (error.name === 'SessionPersistenceNotFoundError')
                    return;
                throw error;
            }
            try {
                const { events } = await handle.read();
                const session = Session.create(SessionId(id), events, handle.header, handle.inheritedEventCount, get('sessions').messageProjections);
                session.append('model/selection', CLOSED);
                await handle.append(session.snapshotEvents(events.length));
                await handle.flush();
            }
            finally {
                await handle.close();
            }
        },
        async unseal(id, selection) {
            await get('llm').resolveCallConfig(selection);
            const snapshot = await host.snapshot(id, '/cancelled-enrollment');
            validateNative(snapshot, { allowClosed: true });
            const agent = get('agents')?.get(id);
            if (agent) {
                agent.model.select(selection);
                await get('sessions').flush(agent.session);
                return;
            }
            const handle = await get('sessionPersistence').open(SessionId(id), 'write');
            try {
                const { events } = await handle.read();
                const detached = Session.create(SessionId(id), events, handle.header, handle.inheritedEventCount, get('sessions').messageProjections);
                detached.append('model/selection', selection);
                await handle.append(detached.snapshotEvents(events.length));
                await handle.flush();
            }
            finally {
                await handle.close();
            }
        },
        async archive(id) {
            const owned = handles.get(id);
            if (owned) {
                await owned.dispose();
                handles.delete(id);
            }
            await get('workspaceRegistry')?.archiveSession(SessionId(id));
        },
    };
    const sharing = new NativeSharing(join(service.store.directory, 'native-sharing.json'), (await service.store.instance()).id, {
        call: (hostId, request) => service.withWorkspace(hostId, async () => { }, files => files.nativeSharing(request)),
    }, host);
    host.autonomy = nativeRuntimeAutonomy(get, adapter.load, host, sharing);
    adapter.fenceLifecycle({
        enter, leave,
        async admit(id) {
            if (quiescing.has(rootOf(id)))
                throw new RemoteError('Native session is checkpointing or handing off; retry when idle', 409);
            if (replicaOf(id))
                await sharing.guard(rootOf(id));
        },
        rejected(id, line, submittedAttachments) { if (replicaOf(id))
            sharing.rejected(rootOf(id), [{ kind: 'command', line, submittedAttachments }]); },
    });
    const on = (event, callback) => ctx.on(event, callback, { global: true, prepend: true });
    on('session/created', (session) => {
        if (session.header.origin === 'subagent' && session.header.parentSession) {
            const parent = replicaOf(session.header.parentSession);
            if (parent) {
                // Legacy plain-v1 roots may not yet have an autonomy packet. Establish
                // their durable self map BEFORE publishing the first new child.
                if (!sharing.autonomy.plan(parent.sessionId))
                    sharing.autonomy.stage(parent.sessionId, { schema: 1, rootId: parent.sessionId, children: [], queues: [], schedules: [] }, { [parent.sessionId]: parent.sessionId }, parent.placement);
                sharing.enrollDescendant(session.header.parentSession, session.id);
            }
        }
        const replica = replicaOf(session.id, session);
        if (replica && replica.phase !== 'mirror' && !sharing.restoring.has(replica.sessionId) && !(session.id !== replica.sessionId && replica.phase === 'active' && sharing.activated.has(replica.sessionId)))
            throw new Error('Shared native original is closed. Recover or continue a linked copy from Remote agents settings.');
    });
    on('agent/created', ({ agent }) => {
        if (!replicaOf(agent.id))
            return;
        safePermissions(agent.session);
        const replica = replicaOf(agent.id);
        const aliases = sharing.autonomyOwner(agent.id)?.agentAliases;
        if (aliases)
            installNativeAgentAliases(agent, aliases, id => sharing.guard(rootOf(id)));
    });
    on('agent/pre-step', async ({ agent, messages }, next) => {
        if (!replicaOf(agent.id))
            return next();
        admissions.set(agent.id, messages);
        try {
            validateNativeInput([...portableInboxAudit(agent.session.snapshotEvents(), sharing.recoveryInput(rootOf(agent.id))), ...messages]);
            await sharing.guard(rootOf(agent.id));
            const decision = await next();
            if (decision.kind === 'reject')
                sharing.rejected(rootOf(agent.id), messages);
            return decision;
        }
        catch (error) {
            sharing.rejected(rootOf(agent.id), messages);
            throw error;
        }
    });
    on('agent/request', async ({ agent }, next) => {
        if (replicaOf(agent.id))
            try {
                await sharing.guard(rootOf(agent.id));
            }
            catch (error) {
                sharing.rejected(rootOf(agent.id), admissions.get(agent.id) ?? []);
                throw error;
            }
        return next();
    });
    on('llm/stream', async function* (options, next) {
        const id = options.sessionId;
        if (id && quiescing.has(rootOf(id)))
            throw new RemoteError('Native session is checkpointing or handing off; retry this auxiliary call when idle', 409);
        if (id)
            enter(id);
        try {
            if (id && replicaOf(id)) {
                if (options.provider === 'remote-cli' || options.provider.startsWith('remote-cli-'))
                    throw new RemoteError('Shared native conversations require an ordinary model', 409);
                // Includes prepared-call streams used by native titles, and the direct
                // stream used by native compaction. Never infer ownership from purpose.
                await sharing.guard(rootOf(id));
            }
            yield* next();
        }
        finally {
            if (id)
                setImmediate(() => leave(id));
        }
    });
    const compaction = get('compaction');
    if (compaction?.summarize) {
        const original = compaction.summarize;
        const summarize = async function (input, agent, signal) {
            if (replicaOf(agent.id)) {
                await sharing.guard(rootOf(agent.id));
                input = await adapter.compactionInput(input, agent, signal);
            }
            return original.call(this, input, agent, signal);
        };
        compaction.summarize = summarize;
        ctx.effect(() => () => { if (compaction.summarize === summarize)
            compaction.summarize = original; });
    }
    ctx.inject(['tools'], scoped => {
        const tools = scoped.get('tools');
        if (tools.guard)
            tools.guard((exec) => {
                const replica = replicaOf(exec.agent?.id);
                if (replica && (replica.phase !== 'active' || !sharing.activated.has(replica.sessionId)))
                    return 'Shared native copy is closed';
                if (replica && quiescing.has(rootOf(exec.agent.id)))
                    return 'Native conversation is checkpointing or handing off';
            });
    });
    on('tools/pre-execute', async (exec, next) => {
        if (replicaOf(exec.agent?.id)) {
            await sharing.guard(rootOf(exec.agent.id));
        }
        return next();
    });
    // No restoration wake, tool execution or model request is used to show imported history.
    const timers = new Map();
    on('session/event', (session, event) => {
        if (event.type === 'user/message') {
            const pending = admissions.get(session.id)?.filter((m) => m.id !== event.data.id);
            if (pending?.length)
                admissions.set(session.id, pending);
            else
                admissions.delete(session.id);
        }
        if (event.type === 'step/end' || event.type === 'turn/end')
            admissions.delete(session.id);
        if (event.type !== 'turn/end' || replicaOf(session.id)?.phase !== 'active')
            return;
        const root = rootOf(session.id);
        clearTimeout(timers.get(root));
        const timer = setTimeout(() => { timers.delete(root); void sharing.checkpoint(root).catch(error => sharing.failure(root, error)); }, 1000);
        timer.unref?.();
        timers.set(root, timer);
    });
    let syncing;
    const poll = setInterval(() => {
        if (syncing)
            return;
        syncing = sharing.sync().finally(() => { syncing = undefined; });
    }, 30_000);
    poll.unref?.();
    ctx.effect(() => async () => {
        clearInterval(poll);
        for (const timer of timers.values())
            clearTimeout(timer);
        await sharing.close();
        await syncing;
        for (const [id, handle] of handles) {
            await host.seal(id).catch(() => { });
            await handle.dispose();
        }
    });
    return sharing;
}
