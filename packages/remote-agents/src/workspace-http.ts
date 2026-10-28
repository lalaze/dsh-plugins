import { field, identifier, RemoteError } from './domain.js';
import { FILE_LIMIT, type WorkspaceTarget } from './workspace-domain.js';
import type { WorkspaceMigration } from './workspace-migration.js';
import type { WorkspaceService } from './workspace-service.js';
import { revision, workspacePath } from './workspace-service.js';
import type { WorkspaceTunnels } from './workspace-tunnels.js';

export interface WorkspaceFeatures { files: WorkspaceService; tunnels: WorkspaceTunnels; migration: WorkspaceMigration }
export function expectedTarget(value: unknown): WorkspaceTarget | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object') throw new RemoteError('Invalid workspace target');
  const v = value as Record<string, unknown>;
  return { hostId: identifier(v.hostId), cwd: workspacePath(v.cwd, 'remote workspace'), label: '' };
}
export async function workspaceAction(features: WorkspaceFeatures, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (action === 'legacyMachines') return features.migration.list();
  if (action === 'importLegacyMachine') return features.migration.import(field(input.id, 'saved machine ID', 200));
  const sessionId = field(input.sessionId, 'session ID', 256), expected = expectedTarget(input.target);
  if (action === 'workspaceTarget') return features.files.target(sessionId, signal, expected);
  if (action === 'workspaceFiles') return features.files.operate(sessionId, input.operation, signal, expected);
  if (action === 'workspaceSync') {
    if (input.direction !== 'pull' && input.direction !== 'push') throw new RemoteError('Invalid sync direction');
    const plan = input.apply === true ? field(input.planId, 'sync preview', 64) : undefined;
    return features.files.sync(sessionId, input.direction, input.apply !== true, signal, expected, plan);
  }
  const target = await features.files.target(sessionId, signal, expected);
  if (action === 'workspaceTunnels') return features.tunnels.list(target.hostId);
  if (action === 'addWorkspaceTunnel') {
    const tunnel = input.tunnel && typeof input.tunnel === 'object' ? input.tunnel : {};
    return features.tunnels.add({ ...tunnel, hostId: target.hostId });
  }
  const id = identifier(input.id);
  if (action === 'startWorkspaceTunnel') {
    await features.files.agents.connect(target.hostId); await features.files.target(sessionId, signal, target);
    return features.tunnels.start(id, target.hostId);
  }
  if (action === 'stopWorkspaceTunnel') { features.tunnels.stop(id, target.hostId); return { ok: true }; }
  if (action === 'removeWorkspaceTunnel') { await features.tunnels.remove(id, target.hostId); return { ok: true }; }
  throw new RemoteError('Unknown workspace action');
}
export function workspaceTransferHandler(files: WorkspaceService) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.headers.get('X-DSH-Remote-Agents') !== '1') throw new RemoteError('Use the remote agents client to submit requests', 403);
      const q = new URL(request.url).searchParams;
      const sessionId = field(q.get('sessionId'), 'session ID', 256), path = workspacePath(q.get('path'), 'file path');
      const target = expectedTarget({ hostId: q.get('hostId'), cwd: q.get('cwd') });
      if (request.method === 'GET') {
        const rev = revision(q.get('revision')); if (!rev) throw new RemoteError('A file revision is required');
        const data = await files.download(sessionId, path, rev, request.signal, target);
        return new Response(new Uint8Array(data), { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': String(data.length), 'X-Content-Type-Options': 'nosniff' } });
      }
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const size = Number(request.headers.get('X-File-Size'));
      if (!request.headers.has('X-File-Size') || !Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT) throw new RemoteError('File exceeds the 50 MB transfer limit', 413);
      const rev = revision(request.headers.get('X-File-Revision') === 'new' ? null : request.headers.get('X-File-Revision'));
      async function* input() {
        const reader = request.body?.getReader(); if (!reader) return;
        let bytes = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > size) throw new RemoteError('Upload byte count mismatch', 413); yield value; } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (bytes !== size) throw new RemoteError('Upload byte count mismatch');
      }
      return Response.json(await files.upload(sessionId, path, rev, size, input(), request.signal, target), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'File transfer failed' }, { status: error instanceof RemoteError ? error.status : 502 }); }
  };
}
