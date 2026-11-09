import { createHash } from 'node:crypto';
import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError } from '../core/domain.js';
import { validateNativeAutonomy, assertNativeAutonomyIdle, nativeParkedQueues } from './native-autonomy.js';
import { nativeImageProjection } from './native-image-projection.js';
export const NATIVE_LIMIT = 12 * 1024 * 1024;
export const FILE_LIMIT = 2 * 1024 * 1024;
export const IMAGE_LIMIT = 4 * 1024 * 1024;
export const ATTACHMENTS_LIMIT = 6 * 1024 * 1024;
export const NATIVE_CLOSED_PROVIDER = 'shared-native-closed';
export const isNativeImage = (ref) => ref.mediaType !== undefined;
export const nativeAttachmentLimit = (ref) => isNativeImage(ref) ? IMAGE_LIMIT : FILE_LIMIT;
export const nativeDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Same pending/last-used fold as the native AgentModel: an unrelated logged
 * request must not retire a newer model selection made while it was running. */
export function nativeSelection(events) {
    let pending, last;
    for (const event of events) {
        if (event.type === 'model/selection')
            pending = event.data ?? undefined;
        else if (event.type === 'request/header') {
            const { config, adapterDefaults } = event.data.header;
            last = { provider: config.provider, model: config.model, ...(config.reasoningEffort === undefined || adapterDefaults?.reasoningEffort ? {} : { reasoningEffort: config.reasoningEffort }) };
            if (pending?.provider === last.provider && pending?.model === last.model && pending?.reasoningEffort === last.reasoningEffort)
                pending = undefined;
        }
    }
    return pending ?? last;
}
const fail = (message) => { throw new RemoteError(`Native sharing: ${message}`, 409); };
/** Deliberately conservative first version: no restored autonomous work or path-backed external artifacts. */
export function validateNative(snapshot, options = {}) {
    if (!snapshot || snapshot.protocol !== 'shared-native-v1' || snapshot.header?.version !== SESSION_FORMAT_VERSION || SESSION_FORMAT_VERSION !== 4)
        fail('unsupported session format or sharing protocol');
    if (Buffer.byteLength(JSON.stringify(snapshot)) > NATIVE_LIMIT)
        fail('snapshot exceeds 12 MiB');
    if (!snapshot.project?.startsWith('/') || snapshot.project.includes('\0') || snapshot.project.includes('\n'))
        fail('invalid remote project');
    if (!Array.isArray(snapshot.events) || !Array.isArray(snapshot.files) || snapshot.files.length > 32)
        fail('invalid snapshot');
    let turn = false, step = false, compact = false;
    const calls = new Set(), nested = new Set(), approvals = new Set(), commands = new Set();
    for (const event of snapshot.events) {
        if (!KNOWN_SESSION_EVENT_TYPES.has(event.type)) {
            if (!event.ignorable)
                fail(`unknown required event ${event.type}`);
            // Ignorable plugin data is not a declared portable capability in v1.
            fail(`plugin record ${event.type} requires a compatible importer`);
        }
        const d = event.data;
        if (/^(team\/|tool-workflow\/|deliverables\/)/.test(event.type))
            fail(`unsupported autonomous state or external artifact: ${event.type}`);
        if (event.type === 'goal/change' && (d?.kind !== 'goal/change' || d.version !== 1))
            fail('unsupported goal event');
        if (event.type === 'subagent/descriptor' && d?.version !== 3)
            fail('unsupported subagent descriptor');
        if (event.type === 'turn/start')
            turn = true;
        if (event.type === 'turn/end')
            turn = false;
        if (event.type === 'step/start')
            step = true;
        if (event.type === 'step/end')
            step = false;
        if (event.type === 'compaction/start')
            compact = true;
        if (event.type === 'compaction/end')
            compact = false;
        if (event.type === 'tool/call')
            calls.add(d.callId);
        if (event.type === 'tool/result')
            calls.delete(d.message?.toolCallId);
        if (event.type === 'tool/ptc-dispatch-start')
            nested.add(`${d.rootCallId}:${d.subCallId}`);
        if (event.type === 'tool/ptc-dispatch')
            nested.delete(`${d.rootCallId}:${d.subCallId}`);
        if (event.type === 'approval/asked')
            approvals.add(d.id ?? d.requestId ?? d.callId);
        if (event.type === 'approval/decided')
            approvals.delete(d.id ?? d.requestId ?? d.callId);
        if (event.type === 'command/run')
            commands.add(d.commandId ?? d.id);
        if (event.type === 'command/done')
            commands.delete(d.commandId ?? d.id);
    }
    // Closure is local historical state. Explicit cancellation/private-fork model
    // selection can supersede it; an effective closed route is still forbidden.
    if (!options.allowClosed && nativeSelection(snapshot.events)?.provider === NATIVE_CLOSED_PROVIDER)
        fail('local closed-route markers cannot be published while effective; explicitly recover the last shared checkpoint');
    if (turn || step || compact || calls.size || nested.size || approvals.size || commands.size)
        fail('session has unfinished work, tools, approvals, compaction or commands');
    assertNativeAutonomyIdle(snapshot);
    if (snapshot.header.origin === 'subagent' && (!options.treeChild || !snapshot.header.parentSession))
        fail('subagent sessions require their complete owning tree');
    if (!options.treeChild && !snapshot.autonomy && snapshot.events.some(e => e.type === 'subagent/catalog' && e.data.mode !== 'external'))
        fail('a complete subtree packet is required for this catalog');
    // Host parser checks event continuity, surface replacements, compaction and branch metadata.
    const replay = Session.create(SessionId(snapshot.header.id), snapshot.events, snapshot.header, snapshot.inheritedEventCount, [nativeImageProjection]);
    // Restored inbox projections are not a portable queue; refuse even parked work.
    const queues = new Map();
    for (const event of snapshot.events)
        if (event.type === 'agent/inbox/spliced') {
            const d = event.data, queue = queues.get(d.target) ?? [];
            queue.splice(d.start, d.removedCount ?? 0, ...d.inserted);
            queues.set(d.target, queue);
        }
    if (!options.allowParked && !snapshot.autonomy && [...queues.values()].some(q => q.length))
        fail('queued or steering messages must be settled first');
    if (!options.treeChild && !replay.deriveMessages().some(message => message.role === 'user'))
        fail('empty conversation');
    const refs = fileRefs(snapshot.events);
    const provided = new Map();
    let bytes = 0;
    for (const file of snapshot.files) {
        const { ref, data } = file;
        if (!ref || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId))
            fail('unsafe attachment reference');
        validateAttachmentRef(ref);
        if (!isNativeImage(ref) && (typeof ref.name !== 'string' || !ref.name || ref.name === '.' || ref.name === '..' || /[\\/\0\r\n]/.test(ref.name)))
            fail('unsafe attachment reference');
        if (typeof data !== 'string' || data.length > Math.ceil(nativeAttachmentLimit(ref) / 3) * 4)
            fail('attachment exceeds transfer limit');
        const decoded = Buffer.from(data, 'base64');
        if (decoded.toString('base64') !== data || decoded.length !== ref.bytes || decoded.length > nativeAttachmentLimit(ref) || `sha256:${createHash('sha256').update(decoded).digest('hex')}` !== ref.attachmentId)
            fail('attachment integrity mismatch');
        bytes += decoded.length;
        if (bytes > ATTACHMENTS_LIMIT)
            fail('attachments exceed 6 MiB total');
        const key = JSON.stringify(canonicalRef(ref));
        if (provided.has(key))
            fail('duplicate attachment');
        provided.set(key, file);
    }
    if (refs.length !== provided.size || refs.some(ref => !provided.has(JSON.stringify(canonicalRef(ref)))))
        fail('missing or unreferenced attachment');
    if (snapshot.autonomy) {
        validateNativeAutonomy(snapshot, snapshot.autonomy);
        const all = [snapshot, ...snapshot.autonomy.children];
        if (all.reduce((n, s) => n + s.files.reduce((sum, f) => sum + f.ref.bytes, 0), 0) > ATTACHMENTS_LIMIT)
            fail('tree attachments exceed 6 MiB total');
        for (const child of snapshot.autonomy.children) {
            if (child.autonomy)
                fail('nested autonomy packets are forbidden; use the flat tree');
            validateNative(child, { treeChild: true, allowParked: true });
        }
        // A pre-freeze source can still own a parked queue, but every such input
        // must be present verbatim in the durable packet before any clearing.
        for (const queue of all.flatMap(nativeParkedQueues)) {
            const stored = snapshot.autonomy.queues.find(q => q.sessionId === queue.sessionId && q.target === queue.target);
            if (!stored || nativeDigest(stored.messages) !== nativeDigest(queue.messages))
                fail('parked input differs from the autonomy backup');
        }
    }
}
/** Apply the same attachment admission to new messages before model/tool execution. */
export function validateNativeInput(messages) {
    const refs = fileRefs(messages);
    if (refs.length > 32 || refs.some(ref => !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > nativeAttachmentLimit(ref))
        || refs.reduce((n, ref) => n + ref.bytes, 0) > ATTACHMENTS_LIMIT)
        fail('new input exceeds native file attachment limits');
}
/**
 * Inbox insertion precedes pre-step admission. Unsupported, rejected uploads
 * therefore exist in audit-only splice records even though they never reached
 * the model surface. Preserve their envelope/identity and text, replacing only
 * these proven rejected attachment payloads with an explicit local-recovery note.
 * Accepted user/assistant/tool/compaction events are never rewritten.
 */
export function portableInboxAudit(events, rejected) {
    const originals = new Set(rejected.map(nativeDigest));
    return events.map(event => {
        if (event.type !== 'agent/inbox/spliced')
            return event;
        const inserted = event.data.inserted.map((message) => {
            if (!originals.has(nativeDigest(message)))
                return message;
            let attachment = false;
            try {
                attachment = fileRefs(message).length > 0;
            }
            catch {
                attachment = true;
            }
            if (!attachment)
                return message;
            return { ...message, content: [...message.content.filter((part) => part.type === 'text'),
                    { type: 'text', text: `[Input ${message.id} was rejected before model admission. Its attachments remain on the sending DSH under retained rejected input.]` }] };
        });
        return { ...event, data: { ...event.data, inserted } };
    });
}
/** References are discovered throughout raw history, including shadowed compacted nodes and streams. */
export function fileRefs(value) {
    const refs = new Map();
    const blocks = (parts) => {
        if (!Array.isArray(parts))
            fail('invalid native content blocks');
        for (const block of parts) {
            if (!block || typeof block !== 'object')
                fail('invalid native content block');
            if (block.type === 'image' || block.type === 'file') {
                if (!block.attachment?.attachmentId)
                    fail('path-backed files/images require a registered portable attachment');
                const ref = canonicalRef(block.attachment);
                validateAttachmentRef(ref);
                if (block.type === 'image' !== isNativeImage(ref))
                    fail('attachment kind mismatch');
                refs.set(JSON.stringify(ref), ref);
            }
            else if (!['text', 'reasoning', 'tool-call', 'tool-addition', 'tool-removal'].includes(block.type))
                fail(`unsupported native content block ${String(block.type)}; a portable artifact adapter is required`);
            // Tool arguments, tool schemas and meta are opaque, even when they have
            // keys named type/resource/spillPath/attachmentId/content.
        }
    };
    const message = (m) => { if (m && Array.isArray(m.content))
        blocks(m.content); };
    const stream = (chunks) => {
        if (Array.isArray(chunks))
            for (const item of chunks) {
                const chunk = item.chunk ?? item;
                if (chunk.type === 'block-end' && chunk.block)
                    blocks([chunk.block]);
                if (Array.isArray(chunk.content))
                    blocks(chunk.content);
            }
    };
    const visit = (node) => {
        if (!node || typeof node !== 'object')
            return;
        if (Array.isArray(node)) {
            for (const entry of node)
                visit(entry);
            return;
        }
        if (['system', 'developer', 'user', 'assistant', 'tool'].includes(node.role) && Array.isArray(node.content)) {
            message(node);
            return;
        }
        if (node.id && node.source && Array.isArray(node.content)) {
            message(node);
            return;
        }
        if (['text', 'reasoning', 'image', 'file', 'tool-call', 'tool-addition', 'tool-removal', 'image_url', 'resource', 'file-reference'].includes(node.type)) {
            blocks([node]);
            return;
        }
        const d = node.data;
        if (!d)
            return;
        if (node.type === 'user/message')
            message(d);
        else if (['system/message', 'developer/message', 'assistant/message', 'tool/result'].includes(node.type)) {
            message(d.message);
            if (node.type === 'assistant/message')
                stream(d.stream);
        }
        else if (node.type === 'assistant/attempt')
            stream(d.stream);
        else if (node.type === 'agent/inbox/spliced')
            for (const m of d.inserted ?? [])
                message(m);
        else if (node.type === 'session/title-llm-request')
            for (const m of d.messages ?? [])
                message(m);
        else if (node.type === 'compaction/summary') {
            if (Array.isArray(d.summary))
                blocks(d.summary);
            if (Array.isArray(d.rawOutput))
                blocks(d.rawOutput);
        }
    };
    visit(value);
    return [...refs.values()];
}
/** Stable ordering keeps version/delta attachment dedup independent of object key order. */
export function canonicalRef(ref) {
    return { attachmentId: ref.attachmentId, ...(ref.name === undefined ? {} : { name: ref.name }), bytes: ref.bytes,
        ...(ref.mediaType === undefined ? {} : { mediaType: ref.mediaType, width: ref.width, height: ref.height }),
        ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height } }) };
}
function validateAttachmentRef(ref) {
    if (!/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0)
        fail('unsafe attachment reference');
    if (ref.name !== undefined && (typeof ref.name !== 'string' || !ref.name || ref.name === '.' || ref.name === '..' || /[\\/\0\r\n]/.test(ref.name)))
        fail('unsafe attachment name');
    if (!isNativeImage(ref)) {
        if (typeof ref.name !== 'string')
            fail('file name is required');
        return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType))
        fail('unsupported image encoding');
    const dimension = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 65535;
    if (!dimension(ref.width) || !dimension(ref.height) || ref.width * ref.height > 64000000)
        fail('invalid image dimensions');
    if (ref.originalDimensions && (!dimension(ref.originalDimensions.width) || !dimension(ref.originalDimensions.height)))
        fail('invalid original image dimensions');
}
