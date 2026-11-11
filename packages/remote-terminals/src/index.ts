import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { browsePath, field, identifier, record, RemoteError } from '@dsh-plugins/remote-core/domain.js';
import type { RemoteAgentsMachines } from '@dsh-plugins/remote-core/machines.js';
import type { RemoteUsageRecord } from '@dsh-plugins/remote-core/usage.js';
import { installTerminals, tuiAction, worktreeAction, type Terminals } from './install.js';
import { TerminalsState } from './state.js';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A finished turn of a TUI conversation, once per model it used, as Remote Agents announces its own turns. */
    'remote-agents/usage'(record: RemoteUsageRecord): void;
  }
}

/** What Remote Agents asks this plugin, as the service `remoteTerminals`. */
export interface RemoteTerminals {
  readonly version: 1;
  /** Whether a DSH conversation's view is a CLI in a terminal, which then answers its turns itself. */
  isTui(sessionId: string): boolean;
}

export const name = 'dsh-remote-terminals';
export const inject = ['connection'];
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export const Config: Schema<{ stateDir?: string }, { stateDir: string }> = Schema.object({ stateDir: Schema.string().default(stateDir()) });

const TUI = new Set(['tuiSessions', 'tuiScroll', 'tuiStart', 'tuiTitle', 'tuiEnd']);
const WORKTREES = new Set(['worktreeProjects', 'worktreeInspect', 'createWorktree', 'worktreeJob', 'worktreeJobAction', 'worktreeArchiveCheck', 'archiveWorktree']);

/** The plugin's requests. Until Remote Agents provides its machines there is nothing to work on, and they say so. */
export function createHandler(live: () => { terminals: Terminals; machines: RemoteAgentsMachines } | undefined) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    try {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
      if (request.headers.get('X-DSH-Remote-Agents') !== '1' || !request.headers.get('content-type')?.startsWith('application/json')) throw new RemoteError('Use the remote terminals client to submit requests', 403);
      if (Number(request.headers.get('content-length')) > 2_000_000) throw new RemoteError('Request is too large', 413);
      const text = await request.text();
      if (Buffer.byteLength(text) > 2_000_000) throw new RemoteError('Request is too large', 413);
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new RemoteError('Request must be valid JSON'); }
      const input = record(raw), action = field(input.action, 'action', 50), now = live();
      // A page without Remote Agents has no TUI conversations, and asks before it shows anything.
      if (!now && action === 'tuiSessions') return Response.json({ sessions: [], codex: [], localScroll: true, unavailable: true }, { headers });
      if (!now) throw new RemoteError('Install or update Remote Agents: remote terminals work on the machines saved there.', 501);
      const { terminals, machines } = now;
      let result: unknown;
      if (TUI.has(action)) result = await tuiAction(terminals.tui, action, input, request.signal);
      else if (WORKTREES.has(action)) result = await worktreeAction(terminals.worktrees, action, input, request.signal);
      // The Remote workspace launcher, while the conversation is in a remote workspace; see the client's terminal-preference.ts.
      else if (action === 'terminalShell') {
        const remote = await machines.target(field(input.sessionId, 'session ID', 256), request.signal).then(() => true, error => { if (error instanceof RemoteError && error.status === 409) return false; throw error; });
        result = remote && terminals.terminal.shell ? { shell: terminals.terminal.shell } : {};
      }
      // A worktree on a saved machine becomes a DSH workspace before it can be opened.
      else if (action === 'openWorktree') result = await machines.createWorkspace(identifier(input.hostId), browsePath(input.path), request.signal);
      else throw new RemoteError('Unknown action');
      return Response.json(result, { headers });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Remote terminals request failed' }, { status: error instanceof RemoteError ? error.status : 502, headers });
    }
  };
}

export async function apply(ctx: Context, config: { stateDir?: string } = {}): Promise<void> {
  const store = new TerminalsState(join(config.stateDir ?? stateDir(), 'state.json'));
  await store.open();
  ctx.effect(() => () => store.close());
  let live: { terminals: Terminals; machines: RemoteAgentsMachines } | undefined;
  ctx.connection.fetch.register({ path: '/api/remote-terminals', methods: ['POST'], requestBody: 'buffered', fetch: createHandler(() => live) });
  ctx.provide('remoteTerminals', { version: 1, isTui: id => store.snapshot().tuiSessions?.includes(id) === true } satisfies RemoteTerminals);
  const warn = (message: string) => (ctx.get('logger') as { warn?(text: string): void } | undefined)?.warn?.(message);
  // The machines, their connections and which conversation is on which are Remote Agents'.
  ctx.inject(['remoteAgentsMachines'], scoped => {
    const machines = scoped.get('remoteAgentsMachines') as RemoteAgentsMachines;
    if (machines.version !== 1) { warn(`Remote terminals need Remote Agents' machines service version 1, found ${String(machines.version)}; update both plugins.`); return; }
    let stopped = false;
    scoped.effect(() => () => { stopped = true; live = undefined; });
    void store.adopt(machines.stateFile).catch(error => warn(`Could not take over the TUI conversations Remote Agents kept: ${String(error)}`))
      .then(() => { if (!stopped) live = { terminals: installTerminals(scoped, machines, store, store.file), machines }; })
      .catch(error => warn(`Remote terminals unavailable: ${String(error)}`));
  });
}
