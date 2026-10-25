/** Browser-safe types. SDK and connection credentials stay on the DSH server. */
export interface Host {
  id: string;
  label: string;
  connection: string;
  serverId?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}
export interface HostConfig { id: string; label: string; connection: string; password?: string; serverId?: string }
export interface Choice { id: string; label: string; isDefault?: boolean }
export interface Model extends Choice { thinkingOptions?: Choice[]; defaultThinkingOptionId?: string }
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
export interface Workspace { id: string; name: string; path: string }
export interface Cursor { epoch: string; seq: number }
export interface TimelineEntry {
  seqStart: number;
  seqEnd: number;
  timestamp: string;
  turnId?: string;
  item: Record<string, unknown> & { type: string };
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
export interface Permission {
  id: string;
  name: string;
  kind: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: unknown;
  actions?: { id: string; label: string; behavior: 'allow' | 'deny' }[];
}
export interface PermissionAnswer {
  behavior: 'allow' | 'deny';
  selectedActionId?: string;
  answers?: Record<string, string>;
  message?: string;
}
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
}
export interface TaskInput {
  id: string;
  hostId: string;
  cwd: string;
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  prompt: string;
}
export interface Submission { id: string; text: string; state: 'pending' | 'accepted' | 'uncertain'; error?: string }
export interface Task extends TaskInput {
  serverId: string;
  title: string;
  createdAt: string;
  agentId?: string;
  executionCwd?: string;
  native?: { protocol: NativeProtocol; sessionId: string; argv: string[]; resumable?: boolean; initialSent: boolean; initialConfirmed?: boolean };
  state: 'creating' | 'ready' | 'uncertain';
  error?: string;
  submissions: Submission[];
}
export type NativeProtocol = 'codex' | 'claude' | 'acp' | 'antigravity';
export interface TaskDetail { task: Task; agent: Agent | null; timeline: TimelinePage | null }
export interface Dashboard { hosts: Host[]; tasks: Task[] }
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
export function taskInput(value: unknown): TaskInput {
  const v = record(value);
  return {
    id: identifier(v.id), hostId: identifier(v.hostId), cwd: remotePath(v.cwd),
    provider: field(v.provider, 'provider', 200), model: field(v.model, 'model', 500),
    prompt: field(v.prompt, 'prompt', 100_000),
    ...(v.modeId ? { modeId: field(v.modeId, 'mode', 200) } : {}),
    ...(v.thinkingOptionId ? { thinkingOptionId: field(v.thinkingOptionId, 'thinking level', 200) } : {}),
  };
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
