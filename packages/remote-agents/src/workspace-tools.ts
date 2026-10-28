import { RemoteError } from './domain.js';
import type { ToolDefinition, ToolHost } from './tools.js';
import { fileOperation, type WorkspaceService } from './workspace-service.js';

export function workspaceTools(workspaces: WorkspaceService, host: ToolHost): ToolDefinition[] {
  return [{
    name: 'remote_workspace',
    description: 'Work in this conversation’s verified remote workspace over SSH. Use list, read, search and manifest to inspect remote files; write creates a file with revision=null or edits using the revision returned by read. mkdir creates a directory. move/remove require a file revision. command runs a shell command in a workspace directory with bounded output and timeout. Paths are relative to the workspace. Do not use local filesystem tools on the empty local anchor. Mutations and commands request user approval.',
    parameters: { type: 'object', properties: {
      op: { type: 'string', enum: ['list', 'read', 'stat', 'search', 'manifest', 'write', 'mkdir', 'move', 'remove', 'command'] },
      path: { type: 'string', description: 'Workspace-relative file or directory; . lists the workspace root.' },
      content: { type: 'string' }, revision: { type: ['string', 'null'] }, destination: { type: 'string' }, query: { type: 'string' }, command: { type: 'string' },
    }, required: ['op', 'path'] },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: raw => ['list', 'read', 'stat', 'search', 'manifest'].includes(String((raw as { op?: unknown })?.op)),
    async execute(raw, exec) {
      const operation = fileOperation(raw), sessionId = (exec.agent as { session?: { id?: string } } | undefined)?.session?.id;
      if (!sessionId) throw new RemoteError('This tool requires a DSH conversation workspace');
      const target = await workspaces.target(sessionId, exec.signal);
      if (!['list', 'read', 'stat', 'search', 'manifest'].includes(operation.op)) {
        const answer = await host.approval.request({ agent: exec.agent, toolName: 'remote_workspace', callId: exec.callId, signal: exec.signal,
          reason: `${operation.op} on ${target.label}:${target.cwd}\n${JSON.stringify(operation)}` });
        if (answer !== 'allowed-once') throw new RemoteError('Remote workspace action was not approved', 403);
      }
      return workspaces.operate(sessionId, operation, exec.signal, target);
    },
  }];
}
