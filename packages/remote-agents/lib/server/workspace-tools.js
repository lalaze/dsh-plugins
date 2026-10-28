import { RemoteError } from './domain.js';
import { fileOperation } from './workspace-service.js';
const READS = ['list', 'read', 'stat', 'search', 'manifest'];
/**
 * Actions that run without a prompt under the conversation's DSH permission, as DSH's own tools do. File changes stay
 * inside the verified workspace, so Workspace write allows them; a remote command is not sandboxed and still asks.
 * Auto review has already reviewed the call before it runs.
 */
const UNPROMPTED = {
    'read-only': [],
    'workspace-write': ['write', 'mkdir', 'move', 'remove'],
    'danger-full-access': ['write', 'mkdir', 'move', 'remove', 'command'],
    auto: ['write', 'mkdir', 'move', 'remove', 'command'],
};
/** `permission` reads the calling agent's DSH permission; undefined (a custom permission) asks before every change. */
export function workspaceTools(workspaces, host, permission = () => undefined) {
    return [{
            name: 'remote_workspace',
            description: 'Work in this conversation’s verified remote workspace over SSH. Use list, read, search and manifest to inspect remote files; write creates a file with revision=null or edits using the revision returned by read. mkdir creates a directory. move/remove require a file revision. command runs a shell command in a workspace directory with bounded output and timeout. Paths are relative to the workspace. Do not use local filesystem tools on the empty local anchor. Mutations and commands follow the conversation’s permission: Full access runs them directly, Workspace write asks only before commands, and other permissions ask before each change.',
            parameters: { type: 'object', properties: {
                    op: { type: 'string', enum: ['list', 'read', 'stat', 'search', 'manifest', 'write', 'mkdir', 'move', 'remove', 'command'] },
                    path: { type: 'string', description: 'Workspace-relative file or directory; . lists the workspace root.' },
                    content: { type: 'string' }, revision: { type: ['string', 'null'] }, destination: { type: 'string' }, query: { type: 'string' }, command: { type: 'string' },
                }, required: ['op', 'path'] },
            output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            isConcurrencySafe: raw => READS.includes(String(raw?.op)),
            async execute(raw, exec) {
                const operation = fileOperation(raw), sessionId = exec.agent?.session?.id;
                if (!sessionId)
                    throw new RemoteError('This tool requires a DSH conversation workspace');
                const target = await workspaces.target(sessionId, exec.signal);
                const mode = permission(exec.agent);
                if (!READS.includes(operation.op) && !(mode && UNPROMPTED[mode].includes(operation.op))) {
                    const answer = await host.approval.request({ agent: exec.agent, toolName: 'remote_workspace', callId: exec.callId, signal: exec.signal,
                        reason: `${operation.op} on ${target.label}:${target.cwd}\n${JSON.stringify(operation)}` });
                    if (answer !== 'allowed-once')
                        throw new RemoteError(`Remote workspace ${operation.op} was not approved (${answer})`, 403);
                }
                return workspaces.operate(sessionId, operation, exec.signal, target);
            },
        }];
}
