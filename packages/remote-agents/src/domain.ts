/** Browser-safe types. SSH configuration and native CLI argv stay on the DSH server. */
export interface Host {
  id: string;
  label: string;
  connection: string;
  serverId?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
  modelCount?: number;
  modelError?: string;
  modelsCheckedAt?: string;
  providerErrors?: { label: string; error: string }[];
  enabledProviders?: string[];
}
export interface HostCatalog { cwd: string; providers: Provider[]; checkedAt: string }
export interface HostConfig { id: string; label: string; connection: string; password?: string; serverId?: string; catalog?: HostCatalog; modelError?: string; enabledProviders?: string[] }
export interface SshConfigHost { alias: string; connection: string }
export interface SshConfigHosts { hosts: SshConfigHost[]; warnings: string[] }
export interface Choice { id: string; label: string; isDefault?: boolean }
/** Keep new Claude modes selectable in catalogs and sessions saved before an upgrade. */
export function permissionModes(provider: string, modes: Choice[]): Choice[] {
  // Codex's inherit mode leaves approval policy and sandbox to the remote config.toml.
  if (provider === 'codex') return modes.some(m => m.id === 'inherit') ? modes : [{ id: 'inherit', label: 'Remote CLI settings' }, ...modes];
  if (provider !== 'claude') return modes;
  const choices = modes.some(m => m.id === 'inherit') ? [...modes] : [{ id: 'inherit', label: 'Remote CLI settings' }, ...modes];
  if (!choices.some(m => m.id === 'auto')) choices.splice(choices.findIndex(m => m.id === 'inherit') + 1, 0, { id: 'auto', label: 'Auto · safety checks' });
  return choices;
}
/** `serviceTiers` are Codex speed tiers (for example Fast); without one the CLI's configured tier applies. */
export interface Model extends Choice { thinkingOptions?: Choice[]; defaultThinkingOptionId?: string; serviceTiers?: Choice[]; inputModalities?: ('text' | 'image')[] }
export interface Provider {
  id: string;
  label: string;
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  error?: string;
  notice?: string;
  models: Model[];
  modes: Choice[];
  defaultModeId?: string | null;
}
export interface Cursor { epoch: string; seq: number }
/** Relay output already reflected in the history: resume at byte `at`; `partial` restores Claude's streaming state. */
export interface RelayPosition { id: string; at: number; partial?: true }
export interface TimelineEntry {
  seqStart: number;
  seqEnd: number;
  timestamp: string;
  turnId?: string;
  item: Record<string, unknown> & { type: string };
  relay?: RelayPosition;
}
export interface TimelinePage {
  epoch: string;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  entries: TimelineEntry[];
  startCursor: Cursor | null;
  endCursor: Cursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
}
/** A single submitted message's output, bounded by the next user message. */
export interface MessageTimeline extends TimelinePage { found: boolean; deliveryConfirmed: boolean; hasFollowingMessage: boolean; terminalStatus?: string }
export interface ChatProject {
  id: string;
  label: string;
  hostId: string;
  cwd: string;
  providers: Provider[];
}
export interface Permission {
  id: string;
  name: string;
  kind: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: unknown;
  actions?: { id: string; label: string; behavior: 'allow' | 'deny'; scope?: 'once' | 'session' | 'project' }[];
}
export interface PermissionAnswer {
  behavior: 'allow' | 'deny';
  selectedActionId?: string;
  answers?: Record<string, string>;
  message?: string;
}
/** Tokens held in one native session's context window. */
export interface ContextUsage { used: number; max: number }
/** One plan rate-limit window of a CLI account; `label` is English and localized by the client. */
export interface QuotaWindow { id: string; label: string; usedPercent: number; resetsAt?: string }
/** Plan limits of the account a CLI is signed in with on an SSH host, as that CLI reports them. */
export interface AccountUsage { provider: string; plan?: string; email?: string; windows: QuotaWindow[]; extraUsage?: boolean; credits?: string; checkedAt: string; error?: string }
/** What the composer usage ring shows for a DSH conversation bound to a remote CLI. */
export interface UsageReport { provider: string; context: ContextUsage | null; account?: AccountUsage }
/** Live state of one attached (or detached) native CLI session. */
export interface Agent {
  id: string;
  cwd: string;
  provider: string;
  model: string | null;
  title: string | null;
  status: string;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  pendingPermissions: Permission[];
  lastError?: string;
  nativeSessionId?: string | null;
  resumable?: boolean;
  context?: ContextUsage;
  /** The CLI runs under a relay on the SSH host and survives DSH restarts and SSH interruptions. */
  persistent?: boolean;
  /** A persistent CLI whose SSH connection is being re-established. */
  reconnecting?: boolean;
}
export interface TaskInput {
  id: string;
  hostId: string;
  cwd: string;
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  serviceTier?: string;
  prompt: string;
  attachments?: Attachment[];
}
/** Staged, content-addressed bytes. No host filesystem paths or base64 enter the registry. */
export interface Attachment { sha256: string; name: string; bytes: number; kind: 'image' | 'file'; mediaType?: string }
export interface NativeAttachment extends Attachment { path: string; data?: string }
export const inputModalitiesOf = (provider: string, model: Model): ('text' | 'image')[] => model.inputModalities ?? (['claude', 'codex'].includes(provider) ? ['text', 'image'] : ['text']);
/** Durable agent record. `id` is the client request ID, so retried creation is idempotent. */
export interface Task extends TaskInput {
  /** Native DSH conversation binding, independent of background delegation. */
  chat?: { sessionId: string; route: string; receiptRoute?: string; lastUserId?: string;
    /** How much of a message's output reached the DSH conversation; the rest is shown with the next response. */
    delivered?: { messageId: string; cursor: Cursor | null; done?: true } };
  serverId: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  /** Mode choices discovered when the agent was created; mode changes are validated against them. */
  modes?: Choice[];
  archived?: boolean;
  /** Started by the DSH agent through a delegation tool. */
  origin?: 'dsh';
  agentId?: string;
  executionCwd?: string;
  native?: { protocol: NativeProtocol; sessionId: string; argv: string[]; resumable?: boolean; initialSent: boolean; imageInput?: boolean };
  /** A relay that may still run this task's CLI on the SSH host; restored after DSH restarts. */
  relay?: { id: string };
  /** Last reported context window fill, kept for a detached session. */
  context?: ContextUsage;
  state: 'creating' | 'ready' | 'uncertain';
  error?: string;
}
export type NativeProtocol = 'codex' | 'claude' | 'acp' | 'antigravity';
export const PROVIDER_LABELS: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex', dsh: 'DSH', antigravity: 'Antigravity', grok: 'Grok', codebuddy: 'CodeBuddy' };
/** Older machines retain their providers until the user explicitly changes the selection. */
export const enabledProvidersOf = (host: Pick<HostConfig, 'enabledProviders'>): string[] => host.enabledProviders ?? Object.keys(PROVIDER_LABELS);
export function providerSelection(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !Object.hasOwn(PROVIDER_LABELS, id))) throw new RemoteError('Invalid CLI selection');
  return [...new Set(value)];
}
/** `attention` means a permission request or question is waiting for the user. */
export type AgentStatus = 'starting' | 'running' | 'attention' | 'idle' | 'error' | 'closed';
export interface AgentSummary {
  id: string;
  /** Open bound conversations in the native DSH UI; never submit a second conversation here. */
  chatSessionId?: string;
  hostId: string;
  cwd: string;
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  serviceTier?: string;
  modes: Choice[];
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  delegated: boolean;
  /** The native CLI session was created; messages can be sent (resuming it when needed). */
  started: boolean;
  /** Whether the CLI process is currently attached; an idle resumable agent can be detached. */
  attached: boolean;
  status: AgentStatus;
  pendingPermissions: number;
  error?: string;
  resumable?: boolean;
  nativeSessionId?: string;
  persistent?: boolean;
  reconnecting?: boolean;
}
export interface AgentState { agent: AgentSummary; permissions: Permission[] }
export interface AgentDetail extends AgentState { timeline: TimelinePage | null }
export interface Dashboard { hosts: Host[]; agents: AgentSummary[] }
/** One remote directory level: `path` is canonical; `entries` lists subdirectories only. */
export interface DirectoryListing { path: string; home: string; entries: { name: string; path: string }[]; truncated: boolean }
/** A remote directory adopted as a DSH workspace through its local anchor folder. */
export interface RemoteWorkspace { hostId: string; path: string; remotePath: string }
export const busy =(agent: Pick<AgentSummary, 'status'>) => agent.status === 'starting' || agent.status === 'running' || agent.status === 'attention';

export class RemoteError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteError('Expected a JSON object');
  return value as Record<string, unknown>;
}
export function field(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r]/.test(value)) throw new RemoteError(`Invalid ${label}`);
  return value.trim();
}
export function identifier(value: unknown): string {
  const id = field(value, 'request ID', 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,99}$/.test(id)) throw new RemoteError('Invalid request ID');
  return id;
}
export function remotePath(value: unknown): string {
  const path = field(value, 'remote project path');
  if (!/^(?:\/|[a-zA-Z]:[\\/])/.test(path) || /[\n]/.test(path)) throw new RemoteError('Enter an absolute remote project path');
  return path;
}
/** An absolute remote path, or one under the remote home written as `~` or `~/…`. */
export function browsePath(value: unknown): string {
  const path = field(value, 'remote path');
  if (!/^(?:\/|~$|~\/)/.test(path) || /\n/.test(path)) throw new RemoteError('Enter an absolute remote path or one starting with ~/');
  return path;
}
export function taskInput(value: unknown): TaskInput {
  const v = record(value);
  return {
    id: identifier(v.id), hostId: identifier(v.hostId), cwd: remotePath(v.cwd),
    provider: field(v.provider, 'provider', 200), model: field(v.model, 'model', 500),
    prompt: field(v.prompt, 'prompt', 100_000),
    ...(v.attachments !== undefined ? { attachments: attachmentInput(v.attachments) } : {}),
    ...(v.modeId ? { modeId: field(v.modeId, 'mode', 200) } : {}),
    ...(v.thinkingOptionId ? { thinkingOptionId: field(v.thinkingOptionId, 'thinking level', 200) } : {}),
    ...(v.serviceTier ? { serviceTier: field(v.serviceTier, 'speed', 200) } : {}),
  };
}
export function attachmentInput(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > 100) throw new RemoteError('Up to 100 attachments can be sent at once');
  return value.map(raw => {
    const a = record(raw);
    if (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.bytes) || Number(a.bytes) < 0 || !['image', 'file'].includes(String(a.kind))) throw new RemoteError('Invalid attachment');
    if (a.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(a.mediaType))) throw new RemoteError('Unsupported image format');
    if (a.kind === 'image' && Number(a.bytes) > 5_000_000) throw new RemoteError('An image exceeds the 5 MB CLI input limit');
    return { sha256: a.sha256, name: field(a.name, 'attachment name', 255), bytes: Number(a.bytes), kind: a.kind as Attachment['kind'], ...(a.kind === 'image' ? { mediaType: String(a.mediaType) } : {}) };
  });
}
export function cursorInput(value: unknown): Cursor | undefined {
  if (value === undefined || value === null) return;
  const v = record(value);
  if (!Number.isSafeInteger(v.seq) || Number(v.seq) < 0) throw new RemoteError('Invalid timeline cursor');
  return { epoch: field(v.epoch, 'timeline epoch', 200), seq: Number(v.seq) };
}

export interface Question {
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiple: boolean;
  freeText: boolean;
  optional: boolean;
}
export function questionsOf(input: Record<string, unknown> | undefined): Question[] {
  if (!Array.isArray(input?.questions) || !input.questions.length) return [];
  const questions: Question[] = [];
  for (const raw of input.questions) {
    if (!raw || typeof raw !== 'object') return [];
    const q = raw as Record<string, unknown>;
    if (typeof q.header !== 'string' || typeof q.question !== 'string' || !Array.isArray(q.options)) return [];
    const options = q.options.filter((o): o is { label: string; description?: string } => !!o && typeof o === 'object' && typeof o.label === 'string');
    if (options.length !== q.options.length) return [];
    questions.push({ header: q.header, question: q.question, options, multiple: q.multiSelect === true, freeText: !options.length || q.allowOther === true || q.isOther === true, optional: q.allowEmpty === true });
  }
  return questions;
}
