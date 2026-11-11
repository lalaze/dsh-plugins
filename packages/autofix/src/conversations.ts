/** The parts of DSH a task runs on: a conversation in a workspace, and a model flow inside it. */

export interface ModelChoice { provider: string; model: string; reasoningEffort?: string }
export type FlowRole = 'plan' | 'implement' | 'review';
export interface FlowStep { role: FlowRole; round: number; model: string; machine?: string; status: string; ms?: number; childId?: string; body?: string; note?: string }
export type FlowEnd =
  | { kind: 'passed'; round: number; sentBack: number; ms: number }
  | { kind: 'rejected'; rounds: number; ms: number }
  | { kind: 'failed'; role: FlowRole; reason: string; ms: number }
  | { kind: 'stopped'; ms: number }
  | { kind: 'noVerdict'; ms: number };
export interface FlowResult { end: FlowEnd; report?: string; steps: FlowStep[] }
export interface FlowRun { done: Promise<FlowResult>; stop(): void }
export interface FlowInput { goal: string; rounds?: number; models?: Partial<Record<FlowRole, string>>; attachments?: readonly unknown[] }

/** dsh-model-flow's service `modelFlow`. */
interface ModelFlow { readonly version: number; start(agent: unknown, input: FlowInput): Promise<FlowRun> }
interface SessionController {
  create(input: { workspaceId: string }): Promise<{ sessionId: string }>;
  selectModel(input: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>;
  rename(input: { sessionId: string; title: string }): Promise<unknown>;
  /** The conversation's live agent, resumed when DSH has it closed. */
  resolveAgent(sessionId: string): Promise<{ agent: unknown } | { error: { message?: string; code?: string } }>;
}
interface WorkspaceController { create(input: { path: string }): Promise<{ workspace: { workspaceId: string } }> }
interface Sessions { get(id: string): unknown }
/** DSH's commands: a line run for a conversation adds a row to it, the one way to do that without a model's turn. */
interface Commands { execute(agent: unknown, line: string, attachments: readonly never[], signal: AbortSignal): Promise<unknown> }
interface PermissionPresets { set(session: unknown, preset: string): void }
/** DSH's attachment store: a saved picture is named by a reference that prompts carry. */
interface Attachments {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>;
  readImage(ref: unknown): Promise<{ ref: { mediaType: string }; data: Uint8Array }>;
}
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** What a task's conversation may do without anyone watching. */
export type Permission = 'workspace-write' | 'auto' | 'danger-full-access';
/** Without `model` the conversation keeps the one DSH gives a new conversation. */
export interface OpenInput { path: string; title: string; model?: ModelChoice; permission: Permission }
export interface Conversation { workspaceId: string; sessionId: string }

export class Conversations {
  /** `service` looks a DSH service up by name at the moment it is needed: plugins load in any order. */
  constructor(private readonly service: (name: string) => unknown) {}

  private need<T>(name: string, what: string): T {
    const value = this.service(name);
    if (!value) throw new Error(`${what} is not available in this DSH`);
    return value as T;
  }

  /** A new conversation in the workspace at `path` (an existing folder, or a remote workspace's local anchor). */
  async open(input: OpenInput): Promise<Conversation> {
    const workspaces = this.need<WorkspaceController>('workspaceController', 'Workspaces'), sessions = this.need<SessionController>('sessionController', 'Conversations');
    const workspaceId = String((await workspaces.create({ path: input.path })).workspace.workspaceId);
    const sessionId = String((await sessions.create({ workspaceId })).sessionId);
    if (input.model) {
      const { provider, model, reasoningEffort } = input.model;
      await sessions.selectModel({ sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
    }
    await sessions.rename({ sessionId, title: input.title });
    const session = this.need<Sessions>('sessions', 'Conversations').get(sessionId);
    if (!session) throw new Error('DSH did not keep the new conversation open');
    // The steps of a flow take the conversation's permission, and nobody is there to answer a prompt.
    this.need<PermissionPresets>('permissionPresets', 'Permissions').set(session, input.permission);
    return { workspaceId, sessionId };
  }

  /** A picture into DSH's attachment store. Throws when DSH will not take it (too large, not a picture it reads). */
  async picture(image: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown> {
    const mediaType = image.mediaType === 'image/jpg' ? 'image/jpeg' : image.mediaType;
    if (!IMAGE_TYPES.includes(mediaType)) throw new Error(`DSH does not read ${image.mediaType} pictures`);
    return this.need<Attachments>('attachments', 'Attachments').saveImage({ data: image.data, mediaType, ...(image.name ? { name: image.name } : {}) });
  }

  /** A picture DSH keeps, as its bytes: for handing it to another DSH. */
  async image(ref: unknown): Promise<{ data: Uint8Array; mediaType: string }> {
    const stored = await this.need<Attachments>('attachments', 'Attachments').readImage(ref);
    return { data: stored.data, mediaType: stored.ref.mediaType };
  }

  /** Runs a command line in a conversation, as if it had been typed there. */
  async command(sessionId: string, line: string): Promise<void> {
    const commands = this.need<Commands>('commands', 'Commands');
    const resolved = await this.need<SessionController>('sessionController', 'Conversations').resolveAgent(sessionId);
    if ('error' in resolved) throw new Error(`The task's conversation could not be opened: ${resolved.error.message ?? resolved.error.code ?? 'unknown reason'}`);
    await commands.execute(resolved.agent, line, [], new AbortController().signal);
  }

  /** Plan, implement and review in that conversation; resolves once the flow has started. */
  async flow(sessionId: string, input: FlowInput): Promise<FlowRun> {
    const flows = this.need<ModelFlow>('modelFlow', 'Model flow (the dsh-model-flow plugin, 0.1.7 or newer)');
    const resolved = await this.need<SessionController>('sessionController', 'Conversations').resolveAgent(sessionId);
    if ('error' in resolved) throw new Error(`The task's conversation could not be opened: ${resolved.error.message ?? resolved.error.code ?? 'unknown reason'}`);
    return flows.start(resolved.agent, input);
  }
}
