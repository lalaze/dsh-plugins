import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RemoteError } from '../core/domain.js';
import { nativeDigest, validateNative, nativeSelection, NATIVE_CLOSED_PROVIDER } from './native-protocol.js';
import { NativePlacements, nativeLocalDirectory } from './native-placement.js';
import { NativeAutonomyJournal, validateNativeAutonomy, remapNativeStructure, remapNativeAutonomy, canonicalNativeStructure, nativeCheckpointEvents, nativeParkedQueues } from './native-autonomy.js';
const RELEASES = new Set(['release', 'archive', 'withdraw', 'delete']);
/** One durable journal for opt-in, closed originals, pending CAS operations and rejected input. */
export class NativeSharing {
    path;
    instance;
    rpc;
    host;
    state;
    queues = new Map();
    serialContext = new AsyncLocalStorage();
    stopping = false;
    restoring = new Set();
    activated = new Set();
    errors = {};
    placements;
    autonomy;
    constructor(path, instance, rpc, host) {
        this.path = path;
        this.instance = instance;
        this.rpc = rpc;
        this.host = host;
        this.placements = new NativePlacements(`${path}.placements.json`);
        this.autonomy = new NativeAutonomyJournal(`${path}.autonomy.json`);
        this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schema: 1, hosts: [], replicas: [] };
        if (this.state.schema !== 1 || !Array.isArray(this.state.hosts) || !Array.isArray(this.state.replicas))
            throw new Error('Unsupported native sharing journal; preserve it for recovery');
    }
    save() {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
        try {
            writeFileSync(fd, JSON.stringify(this.state));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(temporary, this.path);
        const dir = openSync(dirname(this.path), 'r');
        try {
            fsyncSync(dir);
        }
        finally {
            closeSync(dir);
        }
    }
    serial(operation, key = 'settings') {
        if (this.stopping)
            return Promise.reject(new RemoteError('Native sharing is shutting down', 503));
        const next = (this.queues.get(key) ?? Promise.resolve()).then(async () => {
            const lease = { key, active: true };
            try {
                return await this.serialContext.run(lease, operation);
            }
            finally {
                lease.active = false;
            }
        }), tail = next.catch(() => { });
        this.queues.set(key, tail);
        void tail.finally(() => { if (this.queues.get(key) === tail)
            this.queues.delete(key); });
        return next;
    }
    key(id) { const r = this.replica(id); return r ? `${r.hostId}/${r.sharedId}` : `session/${id}`; }
    replica(id) { return this.state.replicas.find(r => r.sessionId === id) ?? this.state.replicas.find(r => r.sessionId === this.autonomy.rootFor(id)); }
    enrollDescendant(parentId, childId) {
        const owner = this.replica(parentId);
        if (owner?.pendingFreeze)
            throw new RemoteError('Resolve the pending freeze before creating or waking another child', 409);
        if (owner)
            this.autonomy.linkDescendant(owner.sessionId, parentId, childId);
    }
    autonomyOwner(id) {
        const replica = this.replica(id);
        if (!replica)
            return undefined;
        const plan = this.autonomy.plan(replica.sessionId);
        return { rootSessionId: replica.sessionId, replica, ids: plan?.ids ?? {}, agentAliases: plan?.agentAliases ?? plan?.ids ?? {}, context: plan?.aliases };
    }
    status() { return { available: this.host.available(), enabled: this.state.hosts.length > 0, hosts: [...this.state.hosts], errors: { ...this.errors }, sourceRecoveries: this.autonomy.sourceRecoveries(), replicas: this.state.replicas.map(({ token, pending, rejected, ...r }) => ({ ...structuredClone(r), autonomy: this.autonomy.status(r.sessionId), live: this.activated.has(r.sessionId), pending: !!pending, rejected: rejected?.length ?? 0 })) }; }
    recoveryInput(id) { return structuredClone(this.replica(id)?.rejected ?? this.autonomy.retainedInput(id)); }
    failure(id, error) { const replica = this.replica(id); if (replica) {
        replica.error = error instanceof Error ? error.message : 'Native synchronization failed';
        this.save();
    } }
    async sync() {
        if (this.stopping)
            return;
        for (const replica of this.state.replicas.filter(r => r.phase === 'active' && this.activated.has(r.sessionId))) {
            try {
                await this.checkpoint(replica.sessionId);
            }
            catch (error) {
                this.failure(replica.sessionId, error);
            }
        }
        for (const hostId of [...this.state.hosts]) {
            try {
                const records = await this.list(hostId);
                for (const record of records) {
                    if (record.archived || record.deleted) {
                        for (const replica of this.state.replicas.filter(r => r.hostId === hostId && r.sharedId === record.id && r.phase === 'mirror'))
                            await this.host.archive?.(replica.sessionId);
                    }
                    else if (!this.state.replicas.some(r => r.hostId === hostId && r.sharedId === record.id && (r.phase === 'active' || r.phase === 'mirror'))) {
                        // One unmapped project must not hide the remaining shared catalog.
                        try {
                            await this.open(hostId, record.id, false);
                        }
                        catch (error) {
                            this.errors[`${hostId}/${record.id}`] = error instanceof Error ? error.message : 'Project mapping required';
                            continue;
                        }
                        delete this.errors[`${hostId}/${record.id}`];
                    }
                }
                delete this.errors[hostId];
            }
            catch (error) {
                this.errors[hostId] = error instanceof Error ? error.message : 'Native synchronization failed';
            }
        }
    }
    enabled(hostId) { if (this.stopping)
        throw new RemoteError('Native sharing is shutting down', 503); if (!this.state.hosts.includes(hostId))
        throw new RemoteError('Enable ordinary conversation sharing for this host first', 409); }
    async close() { this.stopping = true; await Promise.all(this.queues.values()); }
    call(hostId, request) { return this.rpc.call(hostId, { protocol: 'shared-native-v1', instance: this.instance, ...request }); }
    async mutate(replica, request) {
        replica.pending ??= { ...request, id: replica.sharedId, version: replica.version, digest: replica.digest, token: replica.token, op: randomUUID() };
        this.save();
        const record = await this.call(replica.hostId, replica.pending);
        const autonomy = replica.pending.action === 'create' ? replica.pending.snapshot?.autonomy : replica.pending.action === 'append' ? replica.pending.autonomy : undefined;
        if (autonomy) {
            const acknowledged = record.receipt?.autonomyDigest ?? record.autonomyDigest ?? (record.snapshot?.autonomy ? nativeDigest(record.snapshot.autonomy) : undefined);
            if (acknowledged !== nativeDigest(autonomy))
                throw new RemoteError('Authority must persist append.autonomy and acknowledge its digest before this subtree can be handed off', 409);
        }
        // A receipt acknowledges the ORIGINAL operation, even when another writer
        // has since claimed the record. Never follow an acknowledged release with
        // a second release using the retired token.
        if (RELEASES.has(String(replica.pending.action))) {
            replica.token = undefined;
            replica.phase = 'sealed';
            this.activated.delete(replica.sessionId);
        }
        replica.version = record.version;
        replica.digest = record.digest;
        replica.pending = undefined;
        replica.error = undefined;
        this.save();
        return record;
    }
    configure(hostId, enabled) {
        return this.serial(async () => {
            if (enabled && !this.host.available())
                throw new RemoteError('Native host integration is unavailable', 501);
            if (!enabled && this.state.replicas.some(r => r.hostId === hostId && (r.phase === 'active' || r.phase === 'importing' || r.pending || r.version === 0)))
                throw new RemoteError('Handoff or withdraw owned conversations before disabling this host', 409);
            this.state.hosts = [...new Set([...this.state.hosts.filter(id => id !== hostId), ...(enabled ? [hostId] : [])])];
            this.save();
            return this.status();
        }, `host/${hostId}`);
    }
    async list(hostId) { this.enabled(hostId); return this.call(hostId, { action: 'list' }); }
    mappings(hostId) { this.enabled(hostId); return this.placements.list(hostId); }
    async sourceProject(sessionId, hostId) {
        this.enabled(hostId);
        const cwd = await this.host.sourceDirectory?.(sessionId);
        if (!cwd)
            return { projectKey: await this.host.placement(sessionId, hostId) };
        const localDirectory = nativeLocalDirectory(cwd);
        const mapping = this.placements.list(hostId).find(m => m.localDirectory === localDirectory);
        return { projectKey: mapping?.projectKey ?? localDirectory, localDirectory, mappingRequired: !mapping };
    }
    inspectMapping(hostId, localDirectory) { this.enabled(hostId); return { localDirectory: nativeLocalDirectory(localDirectory) }; }
    setMapping(hostId, projectKey, localDirectory, confirmedDirectory) {
        return this.serial(async () => {
            this.enabled(hostId);
            const canonical = nativeLocalDirectory(localDirectory);
            if (this.state.replicas.some(r => r.hostId === hostId && r.placement?.project === projectKey && (r.placement.kind !== 'local' || r.placement.localDirectory !== canonical) && (r.phase === 'active' || r.phase === 'importing' || r.pending)))
                throw new RemoteError('Active project remap refused. Handoff or recover the bound copy before confirming a different directory.', 409);
            return this.placements.set(hostId, projectKey, localDirectory, confirmedDirectory);
        }, 'placements');
    }
    async diagnoseLock(hostId, sharedId) { this.enabled(hostId); return this.call(hostId, { action: 'diagnose-lock', id: sharedId }); }
    restore(hostId, sharedId) {
        return this.serial(async () => {
            this.enabled(hostId);
            const record = await this.call(hostId, { action: 'get', id: sharedId });
            await this.call(hostId, { action: 'restore', id: sharedId, version: record.version, digest: record.digest, op: randomUUID() });
        }, `${hostId}/${sharedId}`);
    }
    /** No permanent ownership transfer until the local original is durably closed. */
    share(sessionId, hostId) {
        return this.serial(async () => {
            this.enabled(hostId);
            if (!this.host.available())
                throw new RemoteError('Native host integration is unavailable', 501);
            if (this.replica(sessionId))
                throw new RemoteError('This conversation is already linked; use its handoff controls', 409);
            const project = await this.host.placement(sessionId, hostId);
            const sourceDirectory = await this.host.sourceDirectory?.(sessionId);
            if (sourceDirectory && this.placements.source(hostId, sourceDirectory) !== project)
                throw new RemoteError('Source project mapping changed; original remains writable', 409);
            return this.host.idle(sessionId, async () => {
                let snapshot = await this.host.snapshot(sessionId, project);
                const bundle = await this.host.autonomy?.capture(sessionId, project);
                if (bundle) {
                    validateNativeAutonomy(snapshot, bundle);
                    snapshot.autonomy = bundle;
                }
                validateNative(snapshot);
                await this.host.validate(snapshot);
                if (sourceDirectory)
                    snapshot.projectKind = 'local';
                this.enabled(hostId);
                const selected = nativeSelection(snapshot.events);
                const sharedId = randomUUID(), replica = { sessionId, sharedId, hostId, phase: 'sealed', version: 0, digest: '', originalSelection: selected, ...(bundle ? { autonomySource: true } : {}) };
                if (bundle) {
                    const canonical = remapNativeAutonomy(bundle, { [bundle.rootId]: sharedId });
                    this.autonomy.stage(sessionId, canonical, Object.fromEntries([sharedId, ...bundle.children.map(c => c.header.id)].map(id => [id, id === sharedId ? sessionId : id])));
                }
                this.state.replicas.push(replica);
                this.save();
                snapshot.header = { ...snapshot.header, id: sharedId, cwd: project };
                // Recheck the immutable cut after closing admission. Side effects already in flight cause refusal.
                const recheck = await this.host.snapshot(sessionId, project);
                if (nativeDigest(snapshot.events) !== nativeDigest(recheck.events))
                    throw new RemoteError('Session changed while sealing; original retained, retry publication explicitly', 409);
                if (bundle) {
                    this.autonomy.rememberSource(`freeze/${sharedId}`, recheck, bundle);
                    const frozen = await this.host.autonomy.freeze(sessionId, bundle, `freeze/${sharedId}`);
                    this.autonomy.rememberFrozen(`freeze/${sharedId}`, frozen);
                    validateNativeAutonomy(frozen.snapshot, frozen.bundle);
                    snapshot = { ...canonicalNativeStructure(frozen.snapshot, this.autonomy.plan(sessionId)), ...(sourceDirectory ? { projectKind: 'local' } : {}), autonomy: this.autonomy.exportBundle(sessionId, frozen.bundle) };
                    snapshot.header = { ...snapshot.header, id: sharedId, cwd: project };
                    validateNativeAutonomy(snapshot, snapshot.autonomy);
                    validateNative(snapshot);
                }
                await this.host.seal(sessionId);
                await this.mutate(replica, { action: 'create', snapshot });
                return structuredClone(replica);
            });
        }, `session/${sessionId}`);
    }
    /** Import a read-only view or acquire the single writer and create a new linked native continuation. */
    open(hostId, sharedId, writing) {
        return this.serial(async () => {
            this.enabled(hostId);
            const record = await this.call(hostId, { action: 'get', id: sharedId });
            if (!record.snapshot || record.deleted || record.archived)
                throw new RemoteError('Shared conversation is missing, archived or deleted', 409);
            validateNative(record.snapshot);
            await this.host.validate(record.snapshot);
            const bundle = record.snapshot.autonomy;
            if (bundle) {
                validateNativeAutonomy(record.snapshot, bundle);
                if (!this.host.autonomy)
                    throw new RemoteError('Native autonomy host adapter is required for this subtree', 409);
            }
            const projectKind = record.snapshot.projectKind;
            if (projectKind !== undefined && projectKind !== 'local' && projectKind !== 'remote')
                throw new RemoteError('Unsupported source project kind', 409);
            const placement = projectKind === 'local' || this.placements.get(hostId, record.snapshot.project)
                ? this.placements.receiver(hostId, record.snapshot.project)
                : await this.host.resolvePlacement?.(hostId, record.snapshot.project);
            if (placement && placement.project !== record.snapshot.project)
                throw new RemoteError('Receiver project mapping changed', 409);
            if (placement?.kind === 'local' && nativeLocalDirectory(placement.localDirectory) !== placement.localDirectory)
                throw new RemoteError('Receiver directory must be canonical', 409);
            this.enabled(hostId);
            if (writing && record.owner)
                throw new RemoteError('Request handoff on the owning DSH before continuing here', 409);
            const known = this.state.replicas.find(r => r.sharedId === sharedId && r.hostId === hostId && r.phase === 'mirror' && r.digest === record.digest);
            if (!writing && known) {
                delete this.errors[`${hostId}/${sharedId}`];
                return { sessionId: known.sessionId };
            }
            const replica = { sessionId: randomUUID(), hostId, sharedId, version: record.version, digest: record.digest,
                phase: 'importing', placement, ...(writing ? { token: randomUUID() } : {}) };
            const plan = bundle ? this.autonomy.stage(replica.sessionId, bundle, undefined, placement) : undefined;
            if (plan)
                await this.autonomy.preflight(replica.sessionId, this.host.autonomy);
            this.state.replicas.push(replica);
            this.save();
            if (writing)
                await this.mutate(replica, { action: 'claim', token: replica.token });
            const imported = plan ? remapNativeStructure(record.snapshot, plan.ids) : record.snapshot;
            if (plan && bundle)
                imported.autonomy = remapNativeAutonomy(bundle, plan.ids);
            await this.host.import(replica.sessionId, hostId, imported, !writing, placement);
            if (plan)
                await this.autonomy.importParked(replica.sessionId, this.host.autonomy);
            replica.phase = writing ? 'active' : 'mirror';
            this.save();
            this.restoring.add(replica.sessionId);
            try {
                if (writing) {
                    await this.host.activate(replica.sessionId);
                    this.activated.add(replica.sessionId);
                }
            }
            catch (error) {
                replica.phase = writing ? 'importing' : 'mirror';
                replica.error = 'Activation failed; handoff or recover this claim from its owner';
                this.save();
                throw error;
            }
            finally {
                this.restoring.delete(replica.sessionId);
            }
            if (!writing)
                for (const old of this.state.replicas.filter(r => r.hostId === hostId && r.sharedId === sharedId && r.phase === 'mirror' && r !== replica))
                    await this.host.archive?.(old.sessionId);
            delete this.errors[`${hostId}/${sharedId}`];
            return { sessionId: replica.sessionId };
        }, `${hostId}/${sharedId}`);
    }
    /** Every model attempt, including retry, and every tool dispatch checks remote ownership/version. */
    async guard(sessionId) {
        const replica = this.replica(sessionId);
        if (!replica)
            return;
        if (replica.pendingFreeze)
            throw new RemoteError('Freeze recovery pending: retry the same handoff or explicitly roll it back. Input is retained; writing is blocked.', 409);
        if (replica.phase !== 'active' || !this.activated.has(replica.sessionId))
            throw new RemoteError('This native copy is closed for writing. Use Continue here on the shared conversation. Rejected input is retained locally.', 409);
        if (replica.placement?.kind === 'local' && nativeLocalDirectory(replica.placement.localDirectory) !== replica.placement.localDirectory)
            throw new RemoteError('Bound local directory changed; handoff before remapping', 409);
        this.enabled(replica.hostId);
        const check = async () => {
            if (replica.pending)
                await this.mutate(replica, {});
            await this.call(replica.hostId, { action: 'check', id: replica.sharedId, version: replica.version, digest: replica.digest, token: replica.token, op: randomUUID() });
        };
        const lease = this.serialContext.getStore();
        if (lease?.active && lease.key === this.key(sessionId))
            await check();
        else
            await this.serial(check, this.key(sessionId));
    }
    resumeAutonomy(sessionId, options) {
        return this.serial(async () => {
            const replica = this.replica(sessionId);
            if (replica?.pendingFreeze)
                throw new RemoteError('Resolve the pending freeze before resuming parked work', 409);
            if (!replica || replica.sessionId !== sessionId || replica.phase !== 'active' || !this.activated.has(sessionId))
                throw new RemoteError('Continue the owning root conversation before resuming parked work', 409);
            this.enabled(replica.hostId);
            if (!this.host.autonomy)
                throw new RemoteError('Native autonomy host adapter is unavailable', 501);
            await this.call(replica.hostId, { action: 'check', id: replica.sharedId, version: replica.version, digest: replica.digest, token: replica.token, op: randomUUID() });
            await this.autonomy.resume(sessionId, this.host.autonomy, options);
        }, this.key(sessionId));
    }
    /** Hook rejection happens after inbox claim: retain the exact messages synchronously before returning. */
    rejected(sessionId, messages) {
        const replica = this.replica(sessionId);
        if (!replica || !messages.length)
            return;
        replica.rejected ??= [];
        for (const message of messages)
            if (!replica.rejected.some(saved => nativeDigest(saved) === nativeDigest(message)))
                replica.rejected.push(structuredClone(message));
        this.save();
    }
    checkpoint(sessionId) { return this.serial(() => this.checkpointInside(sessionId), this.key(sessionId)); }
    async checkpointInside(sessionId, prepared, alreadyIdle = false, fromFreeze = false) {
        const replica = this.replica(sessionId);
        if (!replica || replica.phase !== 'active')
            throw new RemoteError('Only a live active continuation can publish a checkpoint', 409);
        if (replica.pendingFreeze && !fromFreeze)
            throw new RemoteError('Resolve the pending freeze before checkpointing or accepting another turn', 409);
        if (!this.activated.has(sessionId) && !(fromFreeze && replica.pendingFreeze))
            throw new RemoteError('Restarted continuation has an unreviewed local tail. Only explicit recovery of the last shared checkpoint is available; ordinary checkpoint/handoff is refused.', 409);
        this.enabled(replica.hostId);
        if (replica.pending)
            await this.mutate(replica, {});
        const publish = async () => {
            const remote = await this.call(replica.hostId, { action: 'get', id: replica.sharedId });
            if (remote.owner !== this.instance || remote.token !== replica.token || remote.version !== replica.version || remote.digest !== replica.digest)
                throw new RemoteError('Native checkpoint ownership/version conflict; local history retained', 409);
            let snapshot = prepared ?? await this.host.snapshot(sessionId, remote.snapshot.project);
            const captured = prepared?.autonomy ?? await this.host.autonomy?.capture(sessionId, remote.snapshot.project);
            if (captured) {
                const plan = this.autonomy.prepareExport(sessionId, remote.snapshot.header.id, captured);
                snapshot = canonicalNativeStructure(snapshot, plan);
                snapshot.autonomy = this.autonomy.exportBundle(sessionId, captured);
            }
            else if (this.autonomy.plan(sessionId))
                throw new RemoteError('Capture the current imported subtree before checkpointing; parked state remains retained', 409);
            snapshot.header = { ...snapshot.header, id: remote.snapshot.header.id };
            if (snapshot.autonomy)
                validateNativeAutonomy(snapshot, snapshot.autonomy);
            validateNative(snapshot);
            const events = nativeCheckpointEvents(snapshot, remote.snapshot);
            if (events.some(event => event.type === 'model/selection' && event.data.provider === NATIVE_CLOSED_PROVIDER && !replica.retiredClosures?.includes(event.seq)))
                throw new RemoteError('Native local closed-route markers cannot enter a managed checkpoint; explicitly recover the last shared checkpoint', 409);
            if (!events.length && snapshot.title === remote.snapshot.title && nativeDigest(snapshot.autonomy ?? null) === nativeDigest(remote.snapshot.autonomy ?? null))
                return;
            await this.mutate(replica, { action: 'append', events, offset: remote.snapshot.events.length, files: snapshot.files.filter(f => !remote.snapshot.files.some(old => nativeDigest(old.ref) === nativeDigest(f.ref))), title: snapshot.title, ...(snapshot.autonomy ? { autonomy: snapshot.autonomy } : {}) });
        };
        if (alreadyIdle)
            await publish();
        else
            await this.host.idle(sessionId, publish);
    }
    handoff(sessionId, action = 'release') {
        return this.serial(async () => {
            const replica = this.replica(sessionId);
            if (!replica || replica.sessionId !== sessionId)
                throw new RemoteError('Handoff requires the owning root conversation', 409);
            if (replica.pendingFreeze && replica.pendingFreeze.action !== action)
                throw new RemoteError('Retry the saved handoff operation or explicitly roll back its freeze first', 409);
            if (replica.pendingFreeze && !replica.token && replica.phase === 'sealed' && !replica.pending) {
                replica.pendingFreeze = undefined;
                this.save();
                return;
            }
            if (!replica.token)
                throw new RemoteError('This DSH does not own the shared conversation', 409);
            if (!replica.pendingFreeze) {
                if (replica.phase !== 'active' || !this.activated.has(sessionId))
                    throw new RemoteError('Ordinary handoff cannot omit an unreviewed local tail. Explicitly recover the last shared checkpoint instead.', 409);
                await this.checkpointInside(sessionId);
            }
            await this.host.idle(sessionId, async () => {
                if (!replica.pendingFreeze) {
                    const project = replica.placement?.project ?? (await this.call(replica.hostId, { action: 'get', id: replica.sharedId })).snapshot.project;
                    const bundle = await this.host.autonomy?.capture(sessionId, project);
                    if (bundle) {
                        const snapshot = await this.host.snapshot(sessionId, project), operationId = `handoff/${replica.sharedId}/${randomUUID()}`;
                        this.autonomy.rememberSource(operationId, snapshot, bundle);
                        replica.pendingFreeze = { operationId, action, stage: 'freezing', selection: nativeSelection(snapshot.events) };
                        this.save();
                    }
                }
                const pending = replica.pendingFreeze;
                if (pending && pending.stage !== 'published') {
                    let cut = this.autonomy.sourcePacket(pending.operationId);
                    if (!cut)
                        throw new RemoteError('Pending freeze backup is missing; keep the source closed for recovery', 409);
                    if (!cut.complete) {
                        const frozen = await this.host.autonomy.freeze(sessionId, cut.bundle, pending.operationId);
                        this.autonomy.rememberFrozen(pending.operationId, frozen);
                        cut = this.autonomy.sourcePacket(pending.operationId);
                    }
                    pending.stage = 'frozen';
                    this.save();
                    await this.checkpointInside(sessionId, { ...cut.snapshot, autonomy: cut.bundle }, true, true);
                    pending.stage = 'published';
                    this.save();
                }
                replica.phase = 'sealed';
                this.activated.delete(sessionId);
                this.save();
                await this.host.seal(sessionId);
                if (replica.pending) {
                    const retiring = RELEASES.has(String(replica.pending.action));
                    await this.mutate(replica, {});
                    if (retiring) {
                        replica.pendingFreeze = undefined;
                        this.save();
                        return;
                    }
                }
                await this.mutate(replica, { action });
                replica.token = undefined;
                this.save();
                replica.pendingFreeze = undefined;
                this.save();
            });
        }, this.key(sessionId));
    }
    rollbackFreeze(sessionId) {
        return this.serial(async () => {
            const replica = this.replica(sessionId), pending = replica?.pendingFreeze;
            if (!replica || replica.sessionId !== sessionId || !pending || !this.host.autonomy?.restoreSource || !this.host.unseal || !pending.selection)
                throw new RemoteError('An owned frozen copy and source restore adapter are required for rollback', 409);
            if (replica.pending)
                await this.mutate(replica, {});
            const remote = await this.call(replica.hostId, { action: 'get', id: replica.sharedId });
            if (!replica.token || remote.owner !== this.instance || remote.token !== replica.token || remote.version !== replica.version || remote.digest !== replica.digest)
                throw new RemoteError('Rollback requires the unchanged remote writer; frozen backup retained', 409);
            const cut = this.autonomy.sourcePacket(pending.operationId);
            if (!cut)
                throw new RemoteError('Frozen backup missing; source remains gated', 409);
            await this.host.autonomy.restoreSource(sessionId, pending.operationId, cut);
            await this.host.idle(sessionId, () => this.host.unseal(sessionId, pending.selection));
            const current = await this.host.autonomy.capture(sessionId, cut.snapshot.project);
            if (!current)
                throw new RemoteError('Capture the restored source before reopening its writer', 409);
            const snapshot = await this.host.snapshot(sessionId, cut.snapshot.project);
            if ([snapshot, ...current.children].some(s => nativeParkedQueues(s).length))
                throw new RemoteError('Rollback must keep frozen input in its recovery journal until explicit resume', 409);
            this.autonomy.mergeFrozenWork(sessionId, pending.operationId, current);
            replica.retiredClosures = [...new Set([...(replica.retiredClosures ?? []), ...snapshot.events.filter(e => e.seq >= cut.snapshot.events.length && e.type === 'model/selection' && e.data.provider === NATIVE_CLOSED_PROVIDER).map(e => e.seq)])];
            this.restoring.add(sessionId);
            try {
                await this.host.activate(sessionId);
            }
            finally {
                this.restoring.delete(sessionId);
            }
            replica.phase = 'active';
            this.activated.add(sessionId);
            replica.pendingFreeze = undefined;
            replica.error = undefined;
            this.save();
        }, this.key(sessionId));
    }
    async workHost(sessionId, writing) {
        const replica = this.replica(sessionId);
        if (replica) {
            if (replica.sessionId !== sessionId || !replica.token || writing && (!this.activated.has(sessionId) || !!replica.pendingFreeze))
                throw new RemoteError('Work recovery requires the owning root writer with no pending freeze', 409);
            const remote = await this.call(replica.hostId, { action: 'get', id: replica.sharedId });
            if (remote.owner !== this.instance || remote.token !== replica.token)
                throw new RemoteError('Work recovery remote ownership changed', 409);
        }
        else if (this.autonomy.sourceRecovery(sessionId)?.phase !== 'parked')
            throw new RemoteError('Restore the fenced source before work recovery', 409);
        if (!this.host.autonomy)
            throw new RemoteError('Native autonomy host adapter unavailable', 501);
        return this.host.autonomy;
    }
    inspectWork(sessionId, key) { return this.serial(async () => this.autonomy.inspectWork(sessionId, key, await this.workHost(sessionId, false)), this.key(sessionId)); }
    reconcileWork(sessionId, key, decision) { return this.serial(async () => this.autonomy.reconcileWork(sessionId, key, await this.workHost(sessionId, false), decision), this.key(sessionId)); }
    retryWork(sessionId, key) { return this.serial(async () => this.autonomy.retryWork(sessionId, key, await this.workHost(sessionId, true)), this.key(sessionId)); }
    /** Resume a failed publication/claim/release with its saved operation ID, never force claim. */
    recover(sessionId) {
        const freeze = this.replica(sessionId)?.pendingFreeze;
        if (freeze?.stage === 'published')
            return this.handoff(sessionId, freeze.action);
        return this.serial(async () => {
            const replica = this.replica(sessionId);
            if (!replica)
                throw new RemoteError('Native replica not found', 404);
            if (replica.pendingFreeze)
                throw new RemoteError('Retry the pending handoff or explicitly roll back its freeze; recovery cannot omit its retained work', 409);
            if (this.activated.has(sessionId))
                throw new RemoteError('Use handoff for a live native continuation', 409);
            if (replica.version === 0)
                throw new RemoteError('Use Cancel failed enrollment to reconcile the remote authority before reopening the original', 409);
            if (replica.pending) {
                try {
                    await this.mutate(replica, {});
                }
                catch (error) {
                    const remote = await this.call(replica.hostId, { action: 'get', id: replica.sharedId });
                    const released = RELEASES.has(String(replica.pending.action)) && remote.owner !== undefined && (remote.owner !== this.instance || remote.token !== replica.token);
                    if (!released && replica.pending.action !== 'claim' && (remote.owner !== this.instance || remote.token !== replica.token))
                        throw error;
                    replica.version = remote.version;
                    replica.digest = remote.digest;
                    replica.pending = undefined;
                    if (remote.owner !== this.instance || remote.token !== replica.token)
                        replica.token = undefined;
                    replica.error = 'Conflicting local history retained; only the last shared checkpoint can be continued';
                    this.save();
                }
            }
            // A crash may have left local unpushed work. Keep that log closed and transfer
            // only the last acknowledged remote checkpoint; the UI explicitly labels this action.
            replica.phase = 'sealed';
            this.activated.delete(sessionId);
            this.save();
            // An incomplete import may have no local native artifact at all. Its durable
            // journal still blocks activation. Existing artifacts must be closed first.
            if (replica.token)
                await this.host.seal(sessionId);
            if (replica.token) {
                await this.mutate(replica, { action: 'release' });
                replica.token = undefined;
                this.save();
            }
        }, this.key(sessionId));
    }
    /** Atomically fence a never-published/never-claimed enrollment before restoring its original local route. */
    cancelEnrollment(sessionId) {
        return this.serial(async () => {
            const replica = this.replica(sessionId);
            if (!replica || replica.version !== 0 || !replica.originalSelection || !this.host.unseal)
                throw new RemoteError('Only a failed, unclaimed enrollment can be cancelled', 409);
            this.autonomy.retainInput(replica.sessionId, replica.rejected ?? []);
            if (!replica.enrollmentCancelled) {
                replica.cancelOp ??= randomUUID();
                this.save();
                const result = await this.call(replica.hostId, { action: 'cancel-create', id: replica.sharedId, op: replica.cancelOp, createOp: replica.pending?.op });
                if (result.cancelled !== true)
                    throw new RemoteError('Remote cancellation was not confirmed; original remains closed', 409);
                replica.enrollmentCancelled = true;
                this.save();
            }
            const cut = this.autonomy.sourcePacket(`freeze/${replica.sharedId}`);
            if (replica.autonomySource && cut) {
                const hasWork = !!replica.rejected?.length || cut.bundle.queues.some(q => q.messages.length) || cut.bundle.schedules.some(s => s.status !== 'ended') || (cut.bundle.goals ?? []).some(g => g.state?.phase !== 'complete');
                if (!hasWork && this.host.autonomy?.restoreSource)
                    await this.host.autonomy.restoreSource(sessionId, `freeze/${replica.sharedId}`, cut);
                else {
                    this.autonomy.fenceSourceRecovery(sessionId, replica.hostId, `freeze/${replica.sharedId}`);
                    return; // Separate explicit restore, then separate explicit work resume.
                }
            }
            await this.host.idle(sessionId, () => this.host.unseal(sessionId, replica.originalSelection));
            this.state.replicas = this.state.replicas.filter(r => r !== replica);
            this.save();
            if (replica.autonomySource)
                this.autonomy.detach(sessionId);
        }, this.key(sessionId));
    }
    restoreCancelledSource(sessionId) {
        return this.serial(async () => {
            const replica = this.replica(sessionId), recovery = this.autonomy.sourceRecovery(sessionId);
            if (!replica?.enrollmentCancelled || !replica.originalSelection || !this.host.unseal || !recovery)
                throw new RemoteError('Confirm cancellation of this frozen source enrollment before restoring it', 409);
            const autonomy = this.host.autonomy;
            if (!autonomy?.restoreSource)
                throw new RemoteError('Source restore adapter is unavailable; frozen backup and queued work are retained', 409);
            this.autonomy.restoringSource(sessionId);
            const cut = this.autonomy.sourcePacket(recovery.operationId);
            await autonomy.restoreSource(sessionId, recovery.operationId, { snapshot: cut.snapshot, bundle: cut.bundle });
            const current = await autonomy.capture(sessionId, cut.snapshot.project);
            if (!current)
                throw new RemoteError('Capture the restored source state before reopening it; frozen backup retained', 409);
            const restored = await this.host.snapshot(sessionId, cut.snapshot.project);
            if ([restored, ...current.children].some(snapshot => nativeParkedQueues(snapshot).length))
                throw new RemoteError('Keep restored input exclusively parked in the recovery journal until explicit resume', 409);
            validateNativeAutonomy(restored, current);
            this.autonomy.parkSourceRecovery(sessionId, current);
            this.autonomy.retainInput(sessionId, replica.rejected ?? []);
            await this.host.idle(sessionId, () => this.host.unseal(sessionId, replica.originalSelection));
            this.state.replicas = this.state.replicas.filter(r => r !== replica);
            this.save();
        }, this.key(sessionId));
    }
    resumeSourceWork(sessionId, options) {
        return this.serial(async () => {
            if (this.replica(sessionId) || this.autonomy.sourceRecovery(sessionId)?.phase !== 'parked')
                throw new RemoteError('Restore the fenced source before explicitly resuming its parked work', 409);
            if (!this.host.autonomy)
                throw new RemoteError('Native autonomy host adapter is unavailable', 501);
            await this.autonomy.resume(sessionId, this.host.autonomy, options);
        }, `source-recovery/${sessionId}`);
    }
    reconcileEnrollment(sessionId) {
        return this.serial(async () => {
            const replica = this.replica(sessionId);
            if (!replica || replica.version !== 0 || !replica.originalSelection)
                throw new RemoteError('This is not an unresolved enrollment', 409);
            const record = await this.call(replica.hostId, { action: 'get', id: replica.sharedId });
            if (record.missing || record.creator !== this.instance || record.cancelledBy)
                throw new RemoteError('No matching publication was confirmed; use cancellation, and keep the original closed while unreachable', 409);
            replica.version = record.version;
            replica.digest = record.digest;
            replica.pending = undefined;
            replica.phase = 'sealed';
            replica.error = 'Publication reconciled. The original remains closed; use the shared conversation continuation controls.';
            this.save();
        }, this.key(sessionId));
    }
}
