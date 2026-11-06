import { randomUUID } from 'node:crypto';
import type { AccountUsage, Agent, Attachment, Choice, Cursor, DirectoryListing, HostConfig, MessageTimeline, Model, NativeProtocol, PermissionAnswer, Provider, RelayUnavailable, SharedTag, SharedWorkspace, Task, TimelinePage } from '../core/domain.js';
import { enabledProvidersOf, list, permissionModes, PROVIDER_LABELS, RELAY_UNAVAILABLE, remotePath, RemoteError, sharesSessions } from '../core/domain.js';
import { connectionInput, JsonlPeer, OpenSshTransport, quote, type SshTransport } from '../core/ssh.js';
import { MACHINE_IDENTITY, serverIdOf } from '../core/remote-host.js';
import { CliSession, initializeAcp, initializeCodex } from './runtime.js';
import { TaskHistory } from './history.js';
import type { Store } from '../core/store.js';
import { discoverAcpCatalog } from './acp.js';
import { antigravityArguments, ANTIGRAVITY_NOTICE, ANTIGRAVITY_RUNNER, decodeAntigravityModels } from './antigravity.js';
import { attachmentPrompt, transferAttachments } from './attachments.js';
import { RelayClient, RelayLink } from './relay.js';
import { readAccountUsage } from './usage.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceFiles } from '../workspace/files.js';
import { acpServers, sharedArguments, type LaunchSharing } from '../sharing/sharing.js';
import { SharedSessions } from './shared-sessions.js';
export { connectionInput } from '../core/ssh.js';

/** Agent state, replies and timelines are local reads; only process control needs the SSH host. */
export interface Backend {
  workspaceFiles?: WorkspaceFiles;
  connect(): Promise<string>;
  close(): Promise<void>;
  homeDirectory(): Promise<string>;
  /** Canonicalize a directory (`~` expands to the remote home) and optionally list its subdirectories. */
  listDirectory?(path: string | undefined, options?: { entries?: boolean }): Promise<DirectoryListing>;
  providers(cwd: string, refresh: boolean): Promise<Provider[]>;
  /** Probe just the one CLI a session targets, to validate its model, mode and speed without launching the others. */
  target(cwd: string, providerId: string): Promise<Provider>;
  create(task: Task, signal?: AbortSignal): Promise<Agent>;
  recover(task: Task, signal?: AbortSignal): Promise<Agent>;
  agent(id: string): Promise<Agent | null>;
  timeline(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage>;
  messageTimeline(id: string, messageId: string, cursor?: Cursor): Promise<MessageTimeline>;
  reply(id: string): Promise<string>;
  /** Interrupts a running turn first and reattaches a detached session. */
  send(id: string, text: string, messageId: string, attachments?: Attachment[], signal?: AbortSignal): Promise<void>;
  stop(id: string): Promise<void>;
  respond(id: string, requestId: string, answer: PermissionAnswer, input?: Record<string, unknown>): Promise<void>;
  /** Stop and release the CLI process; output and the native session ID are kept. */
  detach(task: Task): Promise<void>;
  /** Detach and delete saved output. */
  forget(task: Task): Promise<void>;
  /** Plan limits of the account a CLI is signed in with; null when the CLI does not report them. */
  account(provider: string, cwd: string | undefined, refresh: boolean): Promise<AccountUsage | null>;
  /** Reattach to a CLI still running under a relay, without waiting for SSH. */
  restore?(task: Task): Promise<Agent | null>;
  /** Stop and delete relays queued for removal on this host. */
  cleanup?(): Promise<void>;
  /** Start sharing sessions with other DSH instances connected to the same SSH account. */
  startSharing?(): void;
  /** Why sharing does not work right now, while it is switched on. */
  sharingError?(): string | undefined;
  /** The other DSH driving a shared session, by name. */
  controller?(taskId: string): string | undefined;
  /** Forget a session here only: a shared one stays on the host for other DSH instances, and its CLI keeps running. */
  forgetLocal?(task: Task): Promise<void>;
  sharedWorkspaces?(timeout?: number): Promise<SharedWorkspace[]>;
  /** Called when the host reports its shared workspaces changed; returns the unsubscribe function. */
  onSharedWorkspaces?(listener: () => void): () => void;
  /**
   * Called with a task whose history grew without a message from this DSH: one another DSH drives, after it was brought
   * up to date here, or one whose CLI ran a turn by itself; returns the unsubscribe function.
   */
  onSharedHistory?(listener: (taskId: string) => void): () => void;
  /** How far a shared session has been read and how far its history goes; nothing when it is not shared. */
  readPosition?(taskId: string): { read: number; head: number } | undefined;
  /** The user read a shared session as far as this DSH has it. */
  markRead?(taskId: string): Promise<void>;
  /** Called with a task whose read position changed, here or on another DSH; returns the unsubscribe function. */
  onSharedRead?(listener: (taskId: string) => void): () => void;
  /** Who sent a message a shared history records with its sender: this DSH, or another one by name. */
  sender?(instance: string, label: string): { self: true } | { name: string };
  shareWorkspace?(path: string): Promise<void>;
  setWorkspaceTags?(path: string, tags: SharedTag[]): Promise<SharedWorkspace>;
  /** Stop sharing the given sessions started here; other DSH instances forget them. */
  withdrawSharing?(taskIds: string[]): Promise<void>;
  /** Whether deletions reach the other DSH instances now; true without sharing. */
  sharingReachable?(timeout: number): Promise<boolean>;
}
export type BackendFactory = (host: HostConfig) => Backend;
export const CLI_PROVIDERS = [
  { id: 'claude', label: PROVIDER_LABELS.claude, command: 'claude', protocol: 'claude' as const, args: [] },
  { id: 'codex', label: PROVIDER_LABELS.codex, command: 'codex', protocol: 'codex' as const, args: ['app-server'] },
  { id: 'dsh', label: PROVIDER_LABELS.dsh, command: 'dsh', protocol: 'acp' as const, args: ['--profile', 'acp'] },
  { id: 'antigravity', label: PROVIDER_LABELS.antigravity, command: 'agy', protocol: 'antigravity' as const, args: [] },
  { id: 'grok', label: PROVIDER_LABELS.grok, command: 'grok', protocol: 'acp' as const, args: ['agent', '--no-leader', 'stdio'] },
  { id: 'codebuddy', label: PROVIDER_LABELS.codebuddy, command: 'codebuddy', protocol: 'acp' as const, args: ['--acp'] },
];
const SESSION_LIMIT = 8;
const DIRECTORY_LIMIT = 2000;
const ACCOUNT_TTL = 300_000;
type Profile = { protocol: NativeProtocol; argv: string[]; cwd: string; provider: Provider };
/** Claude's `list_models` control response: `supportedEffortLevels` holds per-model reasoning choices. */
export function claudeModels(result: unknown): Model[] {
  return list((result as Record<string, unknown> | undefined)?.models).filter(m => typeof m?.value === 'string').map(m => ({
    id: m.value, label: typeof m.displayName === 'string' ? m.displayName : m.value,
    inputModalities: ['text', 'image'],
    thinkingOptions: list(m.supportedEffortLevels ?? m.efforts).filter((e): e is string => typeof e === 'string').map(id => ({ id, label: id })),
  }));
}
/** Codex speed tiers. `serviceTiers` carries request IDs such as `priority`; older CLIs only list `additionalSpeedTiers` names. */
export function codexServiceTiers(model: Record<string, unknown>): Choice[] | undefined {
  const tiers: Choice[] = Array.isArray(model.serviceTiers)
    ? model.serviceTiers.filter(t => typeof t?.id === 'string' && t.id).map(t => ({ id: t.id, label: typeof t.name === 'string' && t.name ? t.name : t.id }))
    : list(model.additionalSpeedTiers).filter((id): id is string => typeof id === 'string' && !!id).map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
  return tiers.length ? tiers : undefined;
}
/**
 * Nobody approves an unattended Claude task's commands. With workspace write it runs them in Claude Code's own sandbox,
 * which confines writes to the workspace like DSH's sandbox; without a sandbox on the host they are asked and denied.
 */
export const unattendedClaude = (task: Pick<Task, 'unattended' | 'modeId'>): string[] =>
  task.unattended && task.modeId === 'acceptEdits' ? ['--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } })] : [];
/**
 * Claude Code refuses to skip permissions as root unless IS_SANDBOX says the machine is meant for it. Whoever connects as
 * root and picks Full access, or made it that account's default, has decided that, so these launches say so. The host is
 * asked because any account name can have uid 0. It is set around the launch rather than by a wrapper command: the relay
 * recognizes its CLI by the command it started.
 */
export const CLAUDE_ROOT_ENV = 'if [ "$(id -u)" = 0 ]; then export IS_SANDBOX=1; fi; ';
/** Full access, or inheriting the host's settings, which can ask for it. Other modes keep Claude Code's check. */
const maySkipPermissions = (modeId: string | undefined) => !modeId || modeId === 'inherit' || modeId === 'bypassPermissions';
/** A short-lived CLI that only answers questions; it reads the same settings as a session. */
const claudeProbe = (path: string) => [path, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];

export class SshBackend implements Backend {
  readonly workspaceFiles: WorkspaceFiles;
  private readonly transport: SshTransport;
  private closed = false;
  private readonly probes = new Set<JsonlPeer>();
  private identity?: { id: string; at: number };
  private catalogs = new Map<string, { at: number; selection: string; providers: Provider[] }>();
  /** One CLI's probe for the start path, keyed by `cwd\0provider`, so `create` and `open` do not probe twice. */
  private targets = new Map<string, { at: number; provider: Provider; profile?: Profile }>();
  private sessions = new Map<string, CliSession>();
  /** Admitted starts/restores, including work not yet registered in sessions. */
  private readonly reservations = new Set<string>();
  private histories = new Map<string, Promise<TaskHistory>>();
  /** When each loaded history was last used, so idle ones (no live session) are freed from memory. */
  private readonly historyUsed = new Map<string, number>();
  private historySweep?: ReturnType<typeof setInterval>;
  /** How long a history with no live session is kept in memory after its last read, before it is reloaded on demand. */
  readonly historyTtl = 300_000;
  private starting = new Map<string, Promise<Agent>>();
  private accounts = new Map<string, { at: number; value: Promise<AccountUsage> }>();
  /** The plan each CLI's account last showed, for answers that cannot tell it. */
  private plans = new Map<string, string>();
  /** Tasks with an operation in flight; their sessions are never evicted. */
  private leases = new Map<string, number>();
  private relayClient?: { at: number; value: Promise<RelayClient | undefined> };
  /** Why the last relay check failed; CLIs are not started until it succeeds. */
  private relayUnavailable?: RelayUnavailable;
  private ending = new Map<string, Promise<void>>();
  private restoring = new Map<string, Promise<Agent | null>>();
  private cleaning?: Promise<void>;
  /** Sessions shared with other DSH instances on the same SSH account; needs relays. */
  private readonly shared?: SharedSessions;
  private readonly historyListeners = new Set<(taskId: string) => void>();
  private readonly readListeners = new Set<(taskId: string) => void>();
  constructor(private readonly host: HostConfig, private readonly store: Store, transport?: SshTransport, private readonly sharing: () => LaunchSharing | undefined = () => undefined) {
    // Commands to the host share one SSH connection; its sockets live in this plugin's private state directory.
    this.transport = transport ?? new OpenSshTransport(connectionInput(host.connection), 'ssh', { controlDirectory: join(store.directory, 'ssh') });
    this.workspaceFiles = new WorkspaceFiles(this.transport);
    if (this.transport.relays && sharesSessions(host)) this.shared = new SharedSessions(this.transport, store, {
      hostId: host.id,
      history: id => this.history(id),
      live: id => { const session = this.sessions.get(id); return session && !session.detached ? session.agent : undefined; },
      yield: id => { const session = this.sessions.get(id); if (session && !session.detached) session.release(); },
      removed: id => this.removeLocal(id),
      adopt: id => { const task = this.store.task(t => t.id === id); if (task && !this.closed) void this.restore(task).catch(() => {}); },
      loaded: id => this.histories.has(id),
      unload: id => { if (!this.sessions.has(id) && !this.restoring.has(id) && !this.starting.has(id)) this.histories.delete(id); },
      followed: id => { for (const listener of this.historyListeners) { try { listener(id); } catch { /* A listener must not stop the registry. */ } } },
      read: id => { for (const listener of this.readListeners) { try { listener(id); } catch { /* A listener must not stop the registry. */ } } },
    });
  }
  startSharing(): void { if (!this.closed) this.shared?.start(); }
  sharingError(): string | undefined { return this.shared?.status(); }
  controller(taskId: string): string | undefined { return this.shared?.controller(taskId); }
  onSharedHistory(listener: (taskId: string) => void): () => void {
    this.historyListeners.add(listener);
    return () => { this.historyListeners.delete(listener); };
  }
  readPosition(taskId: string): { read: number; head: number } | undefined { return this.shared?.readPosition(taskId); }
  async markRead(taskId: string): Promise<void> { await this.shared?.markRead(taskId); }
  onSharedRead(listener: (taskId: string) => void): () => void {
    this.readListeners.add(listener);
    return () => { this.readListeners.delete(listener); };
  }
  sender(instance: string, label: string): { self: true } | { name: string } { return this.shared?.sender(instance, label) ?? { name: label }; }
  async sharedWorkspaces(timeout?: number): Promise<SharedWorkspace[]> { if (!this.shared) return []; return this.shared.listWorkspaces(timeout); }
  onSharedWorkspaces(listener: () => void): () => void {
    const shared = this.shared;
    if (!shared) return () => {};
    shared.workspaceListeners.add(listener);
    return () => { shared.workspaceListeners.delete(listener); };
  }
  async setWorkspaceTags(path: string, tags: SharedTag[]): Promise<SharedWorkspace> {
    if (!this.shared) throw new Error('Sessions are not shared on this host');
    return this.shared.setWorkspaceTags(path, tags);
  }
  async shareWorkspace(path: string): Promise<void> { await this.shared?.addWorkspace(path); }
  async sharingReachable(timeout: number): Promise<boolean> { return !this.shared || this.shared.reachable(timeout); }
  async withdrawSharing(taskIds: string[]): Promise<void> {
    try { await this.shared?.withdraw(taskIds); } catch (error) { throw new RemoteError(error instanceof Error ? error.message : String(error), 409); }
  }
  /**
   * Drive a shared session from this DSH before acting on its CLI, taking it over from another DSH.
   * Without a reachable registry the action goes ahead as before.
   */
  private async control(task: Task, timeout?: number): Promise<void> {
    if (!this.shared) return;
    const result = await this.shared.acquire(task.id, true, timeout);
    if (result.status === 'deleted') throw new RemoteError('This session was deleted in another DSH', 404);
  }
  private assertOpen(): void { if (this.closed) throw new Error('SSH agent backend has stopped'); }
  async homeDirectory(): Promise<string> {
    this.assertOpen();
    // $HOME is set by the system, so this never needs the remote login shell, which costs ~0.5s to load.
    const path = await this.transport.exec('printf \'%s\' "$HOME"', 20_000, { login: false });
    this.assertOpen(); return remotePath(path);
  }
  async listDirectory(path: string | undefined, options: { entries?: boolean } = {}): Promise<DirectoryListing> {
    this.assertOpen();
    // NUL-separated: directory names may contain any byte except '/' and NUL. `+` marks a truncated listing.
    const output = await this.transport.exec(`dsh_target=${quote(path ?? '~')}
case "$dsh_target" in '~') dsh_target="$HOME" ;; '~/'*) dsh_target="$HOME/\${dsh_target#??}" ;; esac
cd -- "$dsh_target" 2>/dev/null || { printf '%s\\n' 'Not a readable directory' >&2; exit 3; }
printf '%s\\0%s\\0' "$(pwd -P)" "$(cd -- "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")"
${options.entries === false ? '' : `dsh_count=0
for dsh_entry in * .[!.]* ..?*; do
  [ -d "$dsh_entry" ] || continue
  dsh_count=$((dsh_count + 1))
  [ "$dsh_count" -le ${DIRECTORY_LIMIT} ] || { printf '+\\0'; break; }
  printf 'd%s\\0' "$dsh_entry"
done`}`, 15_000, { login: false });
    this.assertOpen();
    const [cwd, home, ...rest] = output.split('\0'), canonical = remotePath(cwd);
    const entries = rest.filter(item => item.startsWith('d') && item.length > 1 && !item.includes('\n')).map(item => item.slice(1))
      .sort((a, b) => a.localeCompare(b)).map(name => ({ name, path: canonical === '/' ? `/${name}` : `${canonical}/${name}` }));
    return { path: canonical, home: remotePath(home), entries, truncated: rest.includes('+') };
  }
  async connect(): Promise<string> {
    this.assertOpen();
    if (this.identity && Date.now() - this.identity.at < 15_000) return this.identity.id;
    // The identity is cat/uname/id only; skip the login shell, which `use()` would otherwise pay on every recheck.
    const [machine, user, unique] = (await this.transport.exec(MACHINE_IDENTITY, 20_000, { login: false })).split('\0');
    if (!machine || !user || !unique) throw new Error('SSH did not report a valid machine identity');
    const id = serverIdOf(machine, user, unique);
    this.identity = { id, at: Date.now() }; return id;
  }
  private async history(id: string): Promise<TaskHistory> {
    this.historyUsed.set(id, Date.now());
    let promise = this.histories.get(id);
    if (!promise) {
      const history = new TaskHistory(this.store.directory, id);
      history.onAppend = () => this.shared?.appended(id);
      promise = history.open().then(() => history); this.histories.set(id, promise);
      // Reload-on-demand means a history nothing reads need not stay in memory; a hub opens many over its lifetime.
      if (!this.historySweep && !this.closed) { this.historySweep = setInterval(() => this.sweepHistories(), 60_000); this.historySweep.unref?.(); }
    }
    return promise;
  }
  /**
   * Drop histories no live session uses and nothing has read for a while; a later read reopens them from disk.
   * A history an attached, restoring or starting session holds is kept: a second instance of the same file would
   * append or read out of step with the one that session holds.
   */
  private sweepHistories(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const id of [...this.histories.keys()]) {
      if (this.sessions.has(id) || this.restoring.has(id) || this.starting.has(id)) continue;
      if (now - (this.historyUsed.get(id) ?? 0) < this.historyTtl) continue;
      this.histories.delete(id); this.historyUsed.delete(id);
    }
    for (const id of [...this.historyUsed.keys()]) if (!this.histories.has(id)) this.historyUsed.delete(id);
  }
  /** Canonical cwd and the installed path of each probed CLI, in one SSH round trip. */
  private async canonicalize(cwd: string, definitions: typeof CLI_PROVIDERS): Promise<{ canonical: string; installed: Map<string, string> }> {
    const output = await this.transport.exec(`cd ${quote(cwd)} && printf '%s\\0' "$(pwd -P)" && ${definitions.map(p => `printf '%s\\0%s\\0' ${quote(p.id)} "$(command -v ${quote(p.command)} 2>/dev/null || true)"`).join(' && ')}`);
    const [canonical, ...parts] = output.split('\0');
    this.assertOpen();
    if (!canonical?.startsWith('/')) throw new Error('Remote project does not exist or is not accessible');
    const installed = new Map<string, string>(); for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i + 1]) installed.set(parts[i], parts[i + 1]);
    return { canonical, installed };
  }
  /** Probe one CLI in its canonical cwd: its models and modes, and the launch profile when it is ready. */
  private async probeDefinition(definition: typeof CLI_PROVIDERS[number], canonical: string, path: string | undefined): Promise<{ provider: Provider; profile?: Profile }> {
    const unavailable: Provider = { id: definition.id, label: definition.label, status: 'unavailable', models: [], modes: [], ...(definition.id === 'antigravity' ? { notice: ANTIGRAVITY_NOTICE } : {}) };
    if (!path) return { provider: unavailable };
    let peer: JsonlPeer | undefined;
    try {
      const argv = [path, ...definition.args];
      if (definition.protocol === 'antigravity') {
        const version = await this.transport.exec('node --version');
        if (Number(version.trim().match(/^v(\d+)/)?.[1] ?? 0) < 22) throw new Error('Antigravity remote control requires Node.js 22 or newer on the SSH host');
        const models = decodeAntigravityModels(await this.transport.exec(`cd ${quote(canonical)} && ${quote(path)} models`, 40_000));
        if (!models.length) throw new Error('Antigravity returned no models. Sign in with agy and check agy models on the remote host.');
        const provider: Provider = { ...unavailable, status: 'ready', models, defaultModeId: 'default', modes: [{ id: 'default', label: 'CLI permission settings' }, { id: 'plan', label: 'Plan' }, { id: 'accept-edits', label: 'Accept edits' }, { id: 'auto', label: 'Auto' }] };
        return { provider, profile: { argv, protocol: definition.protocol, cwd: canonical, provider } };
      }
      const launch = definition.protocol === 'claude' ? claudeProbe(path) : argv;
      this.assertOpen();
      peer = new JsonlPeer(this.transport.start(canonical, launch, definition.protocol === 'claude' ? { prefix: CLAUDE_ROOT_ENV } : undefined)); this.probes.add(peer);
      peer.onMessage(message => { if (message.method && message.id !== undefined) peer?.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Discovery does not execute tools' } }); });
      let models: Model[] = [], modes: Provider['modes'] = [], defaultModeId: string | undefined;
      if (definition.protocol === 'codex') {
        await initializeCodex(peer);
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const result = await peer.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
          models.push(...list(result?.data).filter(m => !m.hidden).map(m => ({ id: String(m.model ?? m.id), label: String(m.displayName ?? m.model ?? m.id), inputModalities: (Array.isArray(m.inputModalities) && !m.inputModalities.includes('image') ? ['text'] : ['text', 'image']) as Model['inputModalities'], isDefault: m.isDefault === true, defaultThinkingOptionId: m.defaultReasoningEffort, thinkingOptions: list(m.supportedReasoningEfforts).map(e => ({ id: String(e.reasoningEffort), label: String(e.reasoningEffort) })), serviceTiers: codexServiceTiers(m) })));
          cursor = result?.nextCursor; if (!cursor) break;
        }
        modes = permissionModes('codex', [{ id: 'workspace-write', label: 'Workspace write · ask on request' }, { id: 'auto-review', label: 'Workspace write · auto review' }, { id: 'read-only', label: 'Read only' }, { id: 'full-access', label: 'Full access' }]); defaultModeId = 'inherit';
      } else if (definition.protocol === 'claude') {
        await peer.control({ subtype: 'initialize' });
        models = claudeModels(await peer.control({ subtype: 'list_models' }));
        modes = permissionModes('claude', [{ id: 'default', label: 'Ask before tools' }, { id: 'plan', label: 'Plan' }, { id: 'acceptEdits', label: 'Accept edits' }, { id: 'bypassPermissions', label: 'Full access' }]); defaultModeId = 'inherit';
      } else {
        const capabilities = await initializeAcp(peer);
        const session = await peer.request('session/new', { cwd: canonical, mcpServers: [] });
        ({ models, modes, defaultModeId } = await discoverAcpCatalog(peer, session));
        for (const model of models) model.inputModalities = capabilities.agentCapabilities?.promptCapabilities?.image === true ? ['text', 'image'] : ['text'];
        if (capabilities.agentCapabilities?.sessionCapabilities?.close) await peer.request('session/close', { sessionId: session.sessionId });
      }
      models = [...new Map(models.filter(m => m.id && m.id !== 'undefined').map(m => [m.id, m])).values()];
      if (!models.length) throw new Error('The remote CLI returned no models. Check its login and version.');
      const provider: Provider = { ...unavailable, status: 'ready', models, modes, defaultModeId };
      return { provider, profile: { argv, protocol: definition.protocol, cwd: canonical, provider } };
    } catch (error) { return { provider: { ...unavailable, status: 'error' as const, error: error instanceof Error ? error.message : String(error) } }; }
    finally { if (peer) { this.probes.delete(peer); peer.close(); } }
  }
  async providers(cwd: string, refresh: boolean): Promise<Provider[]> {
    this.assertOpen();
    const enabled = enabledProvidersOf(this.store.hosts().find(h => h.id === this.host.id) ?? this.host);
    const selection = [...enabled].sort().join(','), definitions = CLI_PROVIDERS.filter(p => enabled.includes(p.id));
    if (!definitions.length) return [];
    const cached = this.catalogs.get(cwd);
    if (!refresh && cached?.selection === selection && Date.now() - cached.at < 30_000) return structuredClone(cached.providers);
    const { canonical, installed } = await this.canonicalize(cwd, definitions);
    const probed = await Promise.all(definitions.map(definition => this.probeDefinition(definition, canonical, installed.get(definition.id))));
    const providers = probed.map(({ provider }) => provider);
    this.assertOpen();
    this.catalogs.set(cwd, { at: Date.now(), selection, providers }); return structuredClone(providers);
  }
  /**
   * Probe only the one CLI a session needs, rather than launching every enabled CLI to list its models.
   * Cached briefly so a session's validation (`create`) and its launch (`open`) share a single probe.
   */
  private async resolveTarget(cwd: string, providerId: string, refresh = false): Promise<{ provider: Provider; profile?: Profile }> {
    this.assertOpen();
    const key = `${cwd}\0${providerId}`, cached = this.targets.get(key);
    if (!refresh && cached && Date.now() - cached.at < 30_000) return { provider: cached.provider, ...(cached.profile ? { profile: cached.profile } : {}) };
    const enabled = enabledProvidersOf(this.store.hosts().find(h => h.id === this.host.id) ?? this.host);
    const definition = CLI_PROVIDERS.find(p => p.id === providerId);
    if (!definition || !enabled.includes(providerId)) return { provider: { id: providerId, label: PROVIDER_LABELS[providerId] ?? providerId, status: 'unavailable', models: [], modes: [] } };
    const { canonical, installed } = await this.canonicalize(cwd, [definition]);
    const result = await this.probeDefinition(definition, canonical, installed.get(providerId));
    this.assertOpen();
    this.targets.set(key, { at: Date.now(), provider: result.provider, profile: result.profile });
    return result;
  }
  /** The one CLI a session targets, probed in its own cwd, for `create` to validate the model, mode and speed. */
  async target(cwd: string, providerId: string): Promise<Provider> { return structuredClone((await this.resolveTarget(cwd, providerId)).provider); }
  private task(id: string): Task {
    const task = this.store.task(t => t.agentId === id && t.hostId === this.host.id);
    if (!task) throw new RemoteError('Remote agent not found', 404); return task;
  }
  /** Hosts with Node.js 18+ run CLIs under a relay; transports without relay support keep a direct SSH pipe. */
  private relays(reinstall = false): Promise<RelayClient | undefined> {
    if (!this.transport.relays) return Promise.resolve(undefined);
    const cached = this.relayClient;
    if (cached && !reinstall && Date.now() - cached.at < 60_000) return cached.value;
    const value = RelayClient.open(this.transport).then(result => {
      this.relayUnavailable = typeof result === 'string' ? result : undefined;
      return typeof result === 'string' ? undefined : result;
    });
    this.relayClient = { at: Date.now(), value };
    // A missing relay is checked again on the next start, so installing Node.js takes effect on retry.
    value.then(client => { if (this.relayClient?.value === value) { if (client) this.relayClient.at = Infinity; else this.relayClient = undefined; } }, () => { if (this.relayClient?.value === value) this.relayClient = undefined; });
    return value;
  }
  /** Forget a relay locally and remove it remotely now, or once the host is reachable. */
  private relayEnded(taskId: string, relayId: string): Promise<void> {
    const ending = (async () => {
      await (await this.histories.get(taskId)?.catch(() => undefined))?.flush().catch(() => {});
      await this.store.update(state => {
        const saved = state.tasks.find(t => t.id === taskId);
        if (saved?.relay?.id === relayId) delete saved.relay;
        state.relayCleanups = [...(state.relayCleanups ?? []).filter(c => c.relayId !== relayId), { hostId: this.host.id, relayId }];
      });
      void this.cleanup();
    })().finally(() => { if (this.ending.get(taskId) === ending) this.ending.delete(taskId); });
    this.ending.set(taskId, ending);
    return ending;
  }
  /** Stop and delete relays queued for this host. Never blocks local deletion or archiving. */
  cleanup(): Promise<void> {
    if (this.cleaning || this.closed || !this.store.relayCleanups(this.host.id).length) return this.cleaning ?? Promise.resolve();
    const cleaning = (async () => {
      const ids = this.store.relayCleanups(this.host.id).map(c => c.relayId);
      const relay = await this.relays();
      if (!relay || this.closed) return;
      // A relay whose CLI could not be confirmed stopped stays queued for the next attempt.
      const removed = await relay.remove(ids);
      // After a shutdown the next instance owns the state; it retries the queued removal, which is idempotent.
      if (this.closed) return;
      await this.store.update(state => {
        state.relayCleanups = state.relayCleanups?.filter(c => c.hostId !== this.host.id || !removed.includes(c.relayId));
        if (!state.relayCleanups?.length) delete state.relayCleanups;
      });
    })().catch(() => {}).finally(() => { this.cleaning = undefined; });
    this.cleaning = cleaning;
    return cleaning;
  }
  /** A link to a relay, installing the current relay script on the host before attaching. */
  private link(id: string, offset: number, onState: (state: { connected: boolean }) => void, taskId: string): RelayLink {
    const shared = this.shared;
    return new RelayLink(this.transport, id, offset, async reinstall => {
      this.assertOpen();
      if (!await this.relays(reinstall)) throw new Error('Node.js 18 or newer is no longer available on this SSH host');
    }, onState, shared && (() => shared.mayAttach(taskId)));
  }
  private session(task: Task, peer: JsonlPeer, history: TaskHistory, relay?: RelayLink): CliSession {
    // A turn the CLI runs by itself grows the history without a message from here: told like one another DSH runs.
    const historyChanged = () => { for (const listener of this.historyListeners) { try { listener(task.id); } catch { /* A listener must not stop the session. */ } } };
    return new CliSession(peer, task, history, this.store, { ownTurnStarted: historyChanged, turnEnded: ({ unprompted }) => {
        // A finished turn changed the account's usage; read it again when it is next shown.
        this.accounts.delete(task.provider);
        if (unprompted) historyChanged();
      },
      usage: (usage, turn) => { for (const listener of this.store.usageListeners) { try { listener(task.id, usage, turn); } catch { /* Statistics must not break a session. */ } } }, ...(relay ? { ended: () => void this.relayEnded(task.id, relay.id).catch(() => {}) } : {}) }, relay);
  }
  /**
   * Reattach to the relay still running this task's CLI. Needs no SSH connection: the link keeps
   * reconnecting, and the turn, tools and pending permissions are rebuilt from the saved history.
   */
  restore(task: Task): Promise<Agent | null> {
    if (this.closed) return Promise.reject(new Error('SSH agent backend has stopped'));
    const pending = this.restoring.get(task.id);
    if (pending) return pending;
    const restoring = this.reconnect(task).finally(() => { if (this.restoring.get(task.id) === restoring) this.restoring.delete(task.id); });
    this.restoring.set(task.id, restoring);
    return restoring;
  }
  private async reconnect(task: Task): Promise<Agent | null> {
    this.assertOpen();
    const existing = this.sessions.get(task.id);
    if (existing?.alive) return structuredClone(existing.agent);
    if (this.shared) {
      // Another DSH driving it keeps it; one that went away leaves it to this one. Without the registry yet,
      // the relay's attachment check decides once it can reach the host.
      const result = await this.shared.acquire(task.id, false, 1500);
      this.assertOpen();
      if (result.status === 'held' || result.status === 'deleted') return null;
      const current = this.sessions.get(task.id);
      if (current?.alive) return structuredClone(current.agent);
      task = this.store.task(t => t.id === task.id) ?? task;
    }
    if (!task.relay || !task.native) return null;
    const release = this.reserve(task.id);
    let session: CliSession | undefined;
    try {
      const history = await this.history(task.id);
      const at = (await history.checkpoint(task.relay.id))?.at ?? 0;
      this.assertOpen();
      const link = this.link(task.relay.id, at, state => { if (session) session.agent.reconnecting = !state.connected; }, task.id);
      session = this.session({ ...task, executionCwd: task.executionCwd ?? task.cwd }, new JsonlPeer(link), history, link);
      await session.restore();
      // close() may have released all registered sessions while history was still loading.
      this.assertOpen();
      session.agent.reconnecting = true;
      this.sessions.set(task.id, session);
      link.open();
      // Its MCP proxies reach DSH again once the reverse forward is back.
      this.sharing()?.attached(this.store.hosts().find(h => h.id === this.host.id) ?? this.host, this.transport, task);
      return structuredClone(session.agent);
    } catch (error) {
      // Release the local attachment only: a persistent CLI must survive shutdown or a failed restore.
      session?.release();
      if (session && this.sessions.get(task.id) === session) this.sessions.delete(task.id);
      throw error;
    } finally { release(); }
  }
  /** Synchronous admission: no async launch/restore can pass the same last free slot. */
  private reserve(id: string): () => void {
    this.assertOpen();
    if (this.reservations.has(id)) throw new Error('This CLI session is already being attached');
    const occupied = () => this.reservations.size + [...this.sessions].filter(([id, session]) => session.alive && !this.reservations.has(id)).length;
    while (occupied() >= SESSION_LIMIT) {
      const idle = [...this.sessions].find(([id, session]) => !this.reservations.has(id) && !this.starting.has(id) && !this.restoring.has(id) && !this.leases.has(id) && session.evictable);
      if (!idle) throw new Error(`This SSH host already has ${SESSION_LIMIT} working CLI sessions. Wait for one to finish, or archive an idle agent.`);
      idle[1].close(); this.sessions.delete(idle[0]);
    }
    this.reservations.add(id);
    return () => { this.reservations.delete(id); };
  }
  private lease(id: string): () => void {
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = this.leases.get(id)! - 1;
      if (count) this.leases.set(id, count); else this.leases.delete(id);
    };
  }
  async create(task: Task, signal?: AbortSignal): Promise<Agent> { return this.start(task, false, signal); }
  async recover(task: Task, signal?: AbortSignal): Promise<Agent> { return this.start(task, true, signal); }
  private async start(task: Task, resume: boolean, signal?: AbortSignal): Promise<Agent> {
    this.assertOpen();
    const existing = this.sessions.get(task.id);
    if (existing?.alive && existing.agent.status !== 'closed') return structuredClone(existing.agent);
    const pending = this.starting.get(task.id); if (pending) return pending;
    const operation = this.open(task, resume, signal); this.starting.set(task.id, operation);
    try { return await operation; } finally { this.starting.delete(task.id); }
  }
  private async open(task: Task, resume: boolean, signal?: AbortSignal): Promise<Agent> {
    if (!CLI_PROVIDERS.some(provider => provider.id === task.provider)) throw new Error('This CLI provider is no longer supported. Saved output remains available.');
    await this.control(task);
    const saved = this.store.task(t => t.id === task.id) ?? task;
    if (saved.relay && saved.native) {
      // The CLI may still be running remotely: reattach instead of starting or resuming another one.
      const restored = await this.reattach(saved);
      if (restored) {
        const history = await this.history(task.id);
        if (!resume && !(await history.hasMessage(task.id))) {
          const attachments = await transferAttachments(this.transport, this.store.directory, task.id, task.id, restored.agent.cwd, task.attachments ?? [], signal);
          await restored.send(attachmentPrompt(task.prompt, attachments), task.id, attachments);
        }
        return structuredClone(restored.agent);
      }
    }
    this.sessions.get(task.id)?.close();
    let profile: Profile;
    if (resume) {
      if (!task.native) throw new Error('No saved native CLI session exists. The task will not be replayed.');
      profile = { protocol: task.native.protocol, argv: task.native.argv, cwd: task.executionCwd ?? task.cwd, provider: { id: task.provider, label: task.provider, status: 'ready', models: [], modes: [] } };
    } else {
      // Reuses the probe `create` just ran for this task, so starting a session launches only the one CLI it needs.
      const resolved = await this.resolveTarget(task.cwd, task.provider);
      if (!resolved.profile) throw new Error('The selected CLI is not ready on this SSH host'); profile = resolved.profile;
    }
    let argv = [...profile.argv];
    if (profile.protocol === 'antigravity') argv = antigravityArguments(argv[0], task, resume);
    if (profile.protocol === 'claude') argv = [argv[0], '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--model', task.model, ...(resume ? ['--resume', task.native!.sessionId] : ['--session-id', randomUUID()]), ...(task.modeId && task.modeId !== 'inherit' ? ['--permission-mode', task.modeId] : []), ...(task.thinkingOptionId ? ['--effort', task.thinkingOptionId] : []), ...unattendedClaude(task)];
    const relay = await this.relays();
    this.assertOpen(); signal?.throwIfAborted();
    // A direct pipe would end silently with DSH; refuse and say why before touching the host.
    if (!relay && this.transport.relays) throw new RemoteError(RELAY_UNAVAILABLE[this.relayUnavailable ?? 'install-failed'], 409);
    const history = await this.history(task.id);
    // Upload before creating a native session, so a failed upload can be retried safely.
    const attachments = !resume ? await transferAttachments(this.transport, this.store.directory, task.id, task.id, profile.cwd, task.attachments ?? [], signal) : [];
    signal?.throwIfAborted();
    this.assertOpen();
    const release = this.reserve(task.id);
    try {
      // DSH's shared MCP servers and skills are launch options only; the saved argv stays the CLI's own.
      // Sharing never blocks a launch: the CLI starts without what could not be prepared.
      const shared = await this.sharing()?.prepare(this.store.hosts().find(h => h.id === this.host.id) ?? this.host, this.transport, saved, profile.protocol, signal)
        .catch(error => { signal?.throwIfAborted(); console.warn(`[remote-agents] Sharing with ${this.host.label} failed: ${String(error)}`); return undefined; });
      signal?.throwIfAborted(); this.assertOpen();
      const launch = profile.protocol === 'antigravity' ? ['node', '--input-type=module', '-e', ANTIGRAVITY_RUNNER, '--', ...argv] : sharedArguments(profile.protocol, argv, shared);
      const prefix = profile.protocol === 'claude' && maySkipPermissions(task.modeId) ? CLAUDE_ROOT_ENV : undefined;
      let link: RelayLink | undefined;
      if (relay) {
        // Record the relay before it exists, so an interrupted start is cleaned up rather than leaked.
        const relayId = randomUUID(), previous = this.store.task(t => t.id === task.id)?.relay;
        await this.store.update(state => {
          const saved = state.tasks.find(t => t.id === task.id);
          if (!saved) throw new RemoteError('Remote agent was deleted', 409);
          saved.relay = { id: relayId };
          if (previous) state.relayCleanups = [...(state.relayCleanups ?? []), { hostId: this.host.id, relayId: previous.id }];
        });
        if (previous) void this.cleanup();
        // Another DSH taking the session over must find this relay rather than resume the CLI a second time.
        await this.shared?.flush(task.id);
        this.assertOpen();
        try { await relay.launch(relayId, profile.cwd, launch, prefix); }
        catch (error) { await this.relayEnded(task.id, relayId).catch(() => {}); throw error; }
        link = this.link(relayId, 0, state => { if (this.sessions.get(task.id)?.relay === link) this.sessions.get(task.id)!.agent.reconnecting = !state.connected; }, task.id);
      }
      this.assertOpen();
      const session = this.session({ ...task, executionCwd: profile.cwd }, new JsonlPeer(link ?? this.transport.start(profile.cwd, launch, { prefix })), history, link);
      this.sessions.set(task.id, session);
      link?.open();
      try {
        await session.initialize(profile.protocol, argv, resume, acpServers(shared));
        this.assertOpen();
        if (!resume) await session.send(attachmentPrompt(task.prompt, attachments), task.id, attachments);
        return structuredClone(session.agent);
      } catch (error) { session.close(); throw error; }
    } finally { release(); }
  }
  async agent(id: string): Promise<Agent | null> {
    const task = this.task(id), session = this.sessions.get(task.id);
    if (session && (!session.detached || !this.shared)) return structuredClone(session.agent);
    const saved: Agent = { id, cwd: task.executionCwd ?? task.cwd, provider: task.provider, model: task.model, title: task.title, status: 'closed', pendingPermissions: [], nativeSessionId: task.native?.sessionId, resumable: task.native?.resumable };
    // Another DSH drives the CLI: report the state it shares.
    const remote = this.shared?.remoteLive(task.id);
    return remote ? { ...saved, ...remote, id, cwd: saved.cwd, provider: task.provider, model: task.model, title: task.title, persistent: true } : saved;
  }
  /** A history another DSH drives is brought up to date before it is read. */
  private async read(id: string): Promise<TaskHistory> {
    const task = this.task(id);
    await this.shared?.catchUp(task.id);
    return this.history(task.id);
  }
  async timeline(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage> { return (await this.read(id)).page(cursor, direction); }
  async messageTimeline(id: string, messageId: string, cursor?: Cursor): Promise<MessageTimeline> { return (await this.read(id)).messagePage(messageId, cursor); }
  async reply(id: string): Promise<string> { return (await this.read(id)).lastReply(); }
  /** A restored relay session once it is connected, or undefined when its CLI has ended. */
  private async reattach(task: Task): Promise<CliSession | undefined> {
    if (!this.sessions.get(task.id)?.alive) await this.restore(task);
    const session = this.sessions.get(task.id);
    // An idle CLI may have ended while DSH was away; then the native session is resumed instead.
    if (session?.relay) await session.relay.ready(30_000).catch(() => {});
    if (session?.alive) return session;
    await this.ending.get(task.id);
  }
  /** The live session, resuming the saved native session when the process is gone. */
  private async attached(task: Task): Promise<CliSession> {
    const saved = this.store.task(t => t.id === task.id) ?? task;
    const session = saved.relay && saved.native ? await this.reattach(saved) : this.sessions.get(task.id);
    if (session?.alive) return session;
    if (task.native?.resumable === false) throw new RemoteError('This CLI session has ended and cannot be resumed. Its output is kept.', 409);
    await this.start(task, true);
    return this.sessions.get(task.id)!;
  }
  async send(id: string, text: string, messageId: string, attachments: Attachment[] = [], signal?: AbortSignal): Promise<void> {
    const task = this.task(id), release = this.lease(task.id);
    try {
      if (await (await this.history(task.id)).hasMessage(messageId)) return; // Durable at-most-once admission.
      await this.control(task);
      // Taking over brought in the shared history, which may hold a retried message that already reached the CLI.
      if (await (await this.history(task.id)).hasMessage(messageId)) return;
      let session = await this.attached(this.store.task(t => t.id === task.id) ?? task);
      if (session.busy) { await session.stop(); session = await this.attached(this.store.task(t => t.id === task.id) ?? task); }
      const files = await transferAttachments(this.transport, this.store.directory, task.id, messageId, task.executionCwd ?? task.cwd, attachments, signal);
      // Other DSH instances name where a message they did not send came from.
      const sender = this.shared?.identity;
      await session.send(attachmentPrompt(text, files), messageId, files, sender);
    } finally { release(); }
  }
  async stop(id: string): Promise<void> {
    const task = this.task(id);
    let session = this.sessions.get(task.id);
    // A turn another DSH drives is taken over to stop it.
    if (!session?.alive && this.shared?.remoteLive(task.id)) session = await this.takeOver(task);
    if (session?.alive) await session.stop();
  }
  async respond(id: string, requestId: string, answer: PermissionAnswer): Promise<void> {
    const task = this.task(id);
    let session = this.sessions.get(task.id);
    // Another DSH asked: take the session over; its pending requests are rebuilt from the shared history.
    if (!session?.alive && this.shared) session = await this.takeOver(task);
    if (!session?.alive) throw new RemoteError('This permission request is no longer pending', 409);
    await session.respond(requestId, answer);
  }
  private async takeOver(task: Task): Promise<CliSession | undefined> {
    await this.control(task);
    const saved = this.store.task(t => t.id === task.id) ?? task;
    return saved.relay && saved.native ? this.reattach(saved) : this.sessions.get(task.id);
  }
  async detach(task: Task): Promise<void> {
    // Stopping a CLI another DSH drives takes it over first, so that DSH lets go instead of reporting a failure.
    // An unreachable host never delays archiving or deleting.
    if (this.shared?.connected && !this.sessions.get(task.id)?.alive && (task.relay || this.shared.remoteLive(task.id))) await this.control(task, 3000).catch(() => {});
    const session = this.sessions.get(task.id);
    if (session) {
      // Interrupting needs a connection; an unreachable relay is stopped by its queued cleanup instead.
      if (session.alive && session.busy && (!session.relay || session.relay.connected)) await session.stop();
      session.close(); this.sessions.delete(task.id);
    }
    const relay = this.store.task(t => t.id === task.id)?.relay;
    if (relay) await this.relayEnded(task.id, relay.id);
    await this.ending.get(task.id);
  }
  async forget(task: Task): Promise<void> {
    await this.detach(task);
    // Every DSH sharing the host forgets it too. A summary's temporary session was never shared.
    if (!task.chat?.sessionId.startsWith('remote-compaction-')) await this.shared?.delete(task.id);
    await this.removeFiles(task.id);
  }
  async forgetLocal(task: Task): Promise<void> {
    if (!this.shared) { await this.forget(task); return; }
    const session = this.sessions.get(task.id);
    if (session) { if (session.alive) session.release(); this.sessions.delete(task.id); }
    await this.shared.release(task.id);
    await this.removeFiles(task.id);
  }
  private async removeFiles(id: string): Promise<void> {
    const history = this.histories.get(id) ?? this.history(id);
    this.histories.delete(id);
    await (await history.catch(() => new TaskHistory(this.store.directory, id))).remove();
    await rm(join(this.store.directory, 'attachments', id), { recursive: true, force: true });
  }
  /** Another DSH deleted a shared session: forget it here. Its CLI was stopped by that DSH. */
  private async removeLocal(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) { if (session.alive) session.release(); this.sessions.delete(id); }
    await this.removeFiles(id);
    await this.store.update(state => { state.tasks = state.tasks.filter(t => t.id !== id); });
  }
  async account(provider: string, cwd: string | undefined, refresh: boolean): Promise<AccountUsage | null> {
    this.assertOpen();
    const definition = CLI_PROVIDERS.find(p => p.id === provider);
    if (definition?.protocol !== 'codex' && definition?.protocol !== 'claude') return null;
    const cached = this.accounts.get(provider);
    if (cached && !refresh && Date.now() - cached.at < ACCOUNT_TTL) return cached.value;
    const value = this.readAccount(definition, cwd, this.plans.get(provider)).then(usage => {
      if (usage.plan) this.plans.set(provider, usage.plan);
      return usage;
    });
    this.accounts.set(provider, { at: Date.now(), value });
    value.catch(() => { if (this.accounts.get(provider)?.value === value) this.accounts.delete(provider); });
    return value;
  }
  /** Ask a running session of this CLI, or briefly start one without a prompt. */
  private async readAccount(definition: typeof CLI_PROVIDERS[number], cwd: string | undefined, lastPlan?: string): Promise<AccountUsage> {
    const live = [...this.sessions.values()].find(s => s.alive && s.task.provider === definition.id && s.agent.status !== 'initializing');
    if (live) return readAccountUsage(live.peer, definition.protocol, live.account, lastPlan);
    const path = await this.transport.exec(`printf '%s' "$(command -v ${quote(definition.command)} 2>/dev/null || true)"`);
    this.assertOpen();
    if (!path.startsWith('/')) throw new Error(`${definition.label} is not installed on this SSH host`);
    const argv = definition.protocol === 'claude' ? claudeProbe(path) : [path, ...definition.args];
    const peer = new JsonlPeer(this.transport.start(cwd ?? await this.homeDirectory(), argv, definition.protocol === 'claude' ? { prefix: CLAUDE_ROOT_ENV } : undefined)); this.probes.add(peer);
    try {
      peer.onMessage(message => { if (message.method && message.id !== undefined) peer.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Usage checks do not execute tools' } }); });
      if (definition.protocol === 'codex') { await initializeCodex(peer); return await readAccountUsage(peer, 'codex'); }
      const init = await peer.control({ subtype: 'initialize' });
      return await readAccountUsage(peer, 'claude', init?.account, lastPlan);
    } finally { this.probes.delete(peer); peer.close(); }
  }
  /** Shutdown releases persistent sessions, which keep running and are restored on the next start. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.historySweep); this.historySweep = undefined;
    // Leases are kept: this DSH reattaches its CLIs when it starts again, unless another took them over.
    this.shared?.close();
    for (const probe of this.probes) probe.close();
    for (const session of this.sessions.values()) session.release();
    // Restores never wait for starts, so a start awaiting restore cannot form a shutdown cycle.
    await Promise.allSettled([...this.starting.values(), ...this.restoring.values(), ...this.ending.values()]);
    this.probes.clear(); this.sessions.clear();
    for (const history of this.histories.values()) await (await history.catch(() => undefined))?.flush();
  }
}
