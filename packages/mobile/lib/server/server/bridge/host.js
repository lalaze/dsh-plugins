const asDict = (value) => (typeof value === 'object' && value !== null ? value : {});
/** Adapt the running DSH host. Services are looked up on each call, so they may arrive after this plugin. */
export function dshHost(ctx) {
    const get = (name) => ctx.get(name);
    const sessions = () => {
        const service = get('sessionController');
        if (!service)
            throw new Error('DSH sessions are not available yet');
        return service;
    };
    return {
        ready: () => Boolean(get('sessionController') && get('workspaceController')),
        async listSessions(signal) {
            const value = await sessions().list({}, signal);
            return asDict(value).items ?? [];
        },
        async inspect(sessionId, signal) {
            const service = sessions();
            if (typeof service.inspect === 'function')
                return await service.inspect(sessionId, signal);
            // DSH 0.2.2 removed inspect. Its paged `events` refuses a subagent's session without the parent's address; this is
            // the read inspect itself made, and it covers every session.
            const query = get('sessionQuery');
            if (typeof query?.observeSession !== 'function')
                throw new Error('This DSH version cannot read sessions for the phone');
            const observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' });
            try {
                return { events: [...observation.events] };
            }
            finally {
                observation[Symbol.dispose]();
            }
        },
        follow(sessionId, signal) {
            return sessions().follow({ address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 1 }, signal);
        },
        async prompt(input, signal) {
            await sessions().prompt({ requestId: input.requestId, sessionId: input.sessionId, mode: input.mode, content: input.content }, signal);
        },
        cancel(sessionId) { sessions().cancel({ sessionId }); },
        async create(workspaceId, permission) {
            const created = await sessions().create({ workspaceId });
            const sessionId = created.sessionId;
            // A preset is the permission level here, not an agent preset; it applies to the live session.
            if (permission) {
                const presets = get('permissionPresets'), session = get('sessions')?.get?.(sessionId);
                if (presets && session)
                    presets.set(session, permission);
            }
            return sessionId;
        },
        async modelChoices() {
            const catalog = asDict(await sessions().modelCatalog());
            const presets = get('permissionPresets');
            const permissions = asDict(typeof presets?.catalog === 'function' ? presets.catalog() : undefined);
            const groups = (catalog.groups ?? []).map(group => ({
                id: String(group.id), name: String(group.name ?? group.id),
                models: (group.models ?? []).map(model => {
                    const reasoning = asDict(model.reasoning);
                    return {
                        id: String(model.id), name: String(model.name ?? model.id),
                        ...(typeof model.description === 'string' ? { description: model.description } : {}),
                        ...(Array.isArray(reasoning.efforts) && reasoning.efforts.length ? { efforts: reasoning.efforts.map(effort => ({ id: String(effort.id), name: String(effort.name ?? effort.id) })) } : {}),
                        ...(typeof reasoning.defaultEffort === 'string' ? { defaultEffort: reasoning.defaultEffort } : {}),
                    };
                }),
            })).filter(group => group.models.length > 0);
            // DSH's default may name a provider that is not signed in here; a new session needs one it can use.
            const fallback = asDict(catalog.default);
            const usable = groups.some(group => group.id === fallback.provider && group.models.some(model => model.id === fallback.model));
            const first = groups[0]?.models[0];
            const defaultModel = usable ? fallback : first ? { provider: groups[0].id, model: first.id } : undefined;
            return {
                ...(defaultModel ? { default: defaultModel } : {}),
                groups,
                permissions: (permissions.options ?? []).filter(option => option.value !== 'custom').map(option => ({
                    value: String(option.value), name: String(option.name ?? option.value), ...(typeof option.description === 'string' ? { description: option.description } : {})
                })),
                ...(typeof permissions.defaultPreset === 'string' ? { defaultPermission: permissions.defaultPreset } : {}),
            };
        },
        async selectModel(sessionId, model) {
            await sessions().selectModel({ sessionId, provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) });
        },
        async archive(sessionId, archived) {
            const controller = get('workspaceController');
            if (!controller)
                throw new Error('DSH workspaces are not available yet');
            if (archived)
                await controller.archiveSession({ sessionId, stopActivity: true });
            else
                await controller.unarchiveSession({ sessionId });
        },
        async rename(sessionId, title) { await sessions().rename({ sessionId, title }); },
        async answerQuestion(sessionId, callId, answers) {
            const service = get('userQuestions');
            if (typeof service?.answer !== 'function')
                throw new Error('This DSH version cannot answer questions from another machine');
            return await service.answer(sessionId, callId, { answers }) !== false;
        },
        async *questions(signal) {
            for await (const frame of sessions().control(signal)) {
                if (frame.type === 'baseline') {
                    for (const [sessionId, baseline] of Object.entries(asDict(asDict(frame.value).projections))) {
                        yield { sessionId, active: asDict(asDict(asDict(baseline).values).userQuestions).active };
                    }
                }
                else if (frame.type === 'projection') {
                    // DSH 0.2.1 sends one frame per key; 0.2.2 lists every key one event changed.
                    const changes = Array.isArray(frame.changes) ? frame.changes : [{ key: frame.key, val: frame.value }];
                    for (const change of changes) {
                        if (change.key === 'userQuestions')
                            yield { sessionId: String(frame.sessionId), active: asDict(change.val).active };
                    }
                }
            }
        },
        async *workspaces(signal) {
            const controller = get('workspaceController');
            if (!controller)
                throw new Error('DSH workspaces are not available yet');
            let state = { items: [], archivedSessionIds: [] };
            for await (const frame of controller.follow(signal)) {
                const items = new Map(state.items.map(item => [item.workspaceId, item]));
                switch (frame.type) {
                    case 'baseline':
                    case 'replace': {
                        const value = asDict(frame.value);
                        state = { items: value.items ?? [], archivedSessionIds: value.archivedSessionIds ?? [] };
                        break;
                    }
                    case 'upsert': {
                        const workspace = frame.workspace;
                        if (!items.has(workspace.workspaceId))
                            state = { ...state, items: [...state.items, workspace] };
                        else
                            state = { ...state, items: state.items.map(item => item.workspaceId === workspace.workspaceId ? workspace : item) };
                        break;
                    }
                    case 'remove':
                        state = { ...state, items: state.items.filter(item => item.workspaceId !== frame.workspaceId) };
                        break;
                    case 'order': {
                        const order = frame.workspaceIds;
                        state = { ...state, items: order.map(id => items.get(id)).filter((item) => Boolean(item)) };
                        break;
                    }
                    case 'archived':
                        state = { ...state, archivedSessionIds: frame.archivedSessionIds };
                        break;
                    default: continue;
                }
                yield state;
            }
        },
        async readImage(ref, signal) {
            const stored = asDict(await get('attachments').readImage(ref, signal));
            const data = stored.data instanceof Uint8Array ? stored.data : typeof stored.data === 'string' ? Buffer.from(stored.data, 'base64') : new Uint8Array();
            return { data, mediaType: String(stored.mediaType ?? ref.mediaType ?? 'application/octet-stream') };
        },
        readFile(ref, signal) { return get('attachments').readFileStream(ref, signal); },
        onSessionChange(listener) {
            const disposers = ['api-session/added', 'api-session/removed', 'api-session/status', 'api-session/activity'].map(event => ctx.on(event, ((value) => { listener(typeof value === 'string' ? value : String(asDict(value).sessionId)); })));
            return () => { for (const dispose of disposers)
                dispose(); };
        },
        bridgeApprovals(bridge) { return bridgeApprovalEvent(ctx, bridge); },
    };
}
/**
 * Take part in DSH's `approval/request` waterfall without taking it over.
 *
 * The waterfall passes one request object along the chain, so a listener cannot give the answerers after it a
 * different cancellation signal. To withdraw the question from open browsers when another machine answers first,
 * this listener runs the chain again itself with a copy of the request whose signal it controls, and marks the copy
 * so it passes straight through when it reaches this listener. Any failure falls back to the unchanged chain.
 */
export function bridgeApprovalEvent(ctx, bridge) {
    const copies = new WeakSet();
    const listener = async function (request, next) {
        if (copies.has(request))
            return next();
        const agent = asDict(request.agent), sessionId = typeof agent.id === 'string' ? agent.id : undefined;
        if (!sessionId || typeof request.toolName !== 'string')
            return next();
        const withdraw = new AbortController();
        const upstream = request.signal instanceof AbortSignal ? request.signal : undefined;
        const signal = upstream ? AbortSignal.any([upstream, withdraw.signal]) : withdraw.signal;
        let remote;
        try {
            remote = bridge({ sessionId, toolName: request.toolName, callId: typeof request.callId === 'string' ? request.callId : undefined,
                reason: typeof request.reason === 'string' ? request.reason : undefined }, signal);
        }
        catch {
            remote = undefined;
        }
        if (!remote)
            return next();
        const copy = { ...request, signal };
        copies.add(copy);
        const waterfall = ctx.waterfall;
        const local = Promise.resolve().then(() => waterfall.call(ctx, this, 'approval/request', copy, () => Promise.resolve('unavailable')))
            .catch(() => 'unavailable');
        try {
            const first = await Promise.race([local.then(outcome => ({ from: 'local', outcome })), remote.answer.then(outcome => ({ from: 'remote', outcome }))]);
            // No browser could answer here: wait for the other machine only when it is there to answer.
            if (first.from === 'local' && first.outcome === 'unavailable' && remote.wait && !signal.aborted) {
                return await Promise.race([remote.answer, new Promise(resolve => signal.addEventListener('abort', () => resolve('cancelled'), { once: true }))]);
            }
            return first.outcome;
        }
        finally {
            withdraw.abort();
        }
    };
    return ctx.on('approval/request', listener, true);
}
