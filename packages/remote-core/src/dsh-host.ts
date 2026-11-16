import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { DshPermission } from './domain.js';

/** DSH's logger, when the host provides one. */
export const loggerOf = (ctx: Context) => ctx.get('logger') as { info?(text: string): void; warn?(text: string): void } | undefined;
/** A conversation's preset (composer or /permission), mapped through its sandbox so renamed presets still match; `custom` has no mapping. */
export function permissionOf(ctx: Context, session: Session | undefined): DshPermission | undefined {
  const presets = ctx.get('permissionPresets') as { current(session: Session): string; resolve(name: string): { sandbox: DshPermission } } | undefined;
  if (!presets || !session) return;
  const preset = presets.current(session);
  if (preset === 'auto') return 'auto';
  try { return presets.resolve(preset).sandbox; } catch { return; }
}
const SANDBOXES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access'];
type Knobs = { sandbox?: unknown; approval?: unknown } | undefined;
function knobsOf(ctx: Context, session: Session): Knobs {
  try { return (ctx.get('sessionProjections') as { stateOf?(session: Session, name: string): Knobs } | undefined)?.stateOf?.(session, 'permissions'); } catch { return undefined; }
}
/** DSH's approval policy for a conversation. Under `never` DSH refuses every approval request without showing it. */
function neverAsks(ctx: Context, session: Session | undefined, knobs: Knobs): boolean {
  const approval = ctx.get('approval') as { effectivePolicy?(session: Session): unknown; config?: { policy?: unknown } } | undefined;
  let policy: unknown;
  if (session) try { policy = approval?.effectivePolicy?.(session); } catch { policy = undefined; }
  return (policy ?? knobs?.approval ?? approval?.config?.policy) === 'never';
}
/**
 * How a remote CLI may act for a conversation. A subagent DSH delegated with the `never` approval policy is
 * unattended: nobody answers its prompts, and its knobs (workspace sandbox, never ask) match no preset, so its
 * sandbox sets the CLI's limits. Other conversations keep {@link permissionOf}, where `custom` keeps the CLI's mode.
 * `never`: DSH refuses this conversation's approval requests without showing them.
 */
export function accessOf(ctx: Context, session: Session | undefined): { permission?: DshPermission; unattended: boolean; never: boolean } {
  const permission = permissionOf(ctx, session), knobs = session && knobsOf(ctx, session), never = neverAsks(ctx, session, knobs);
  if (!session?.header.parentSession || permission === 'auto') return { permission, unattended: false, never };
  const approval = knobs?.approval ?? (ctx.get('approval') as { config?: { policy?: unknown } } | undefined)?.config?.policy ?? 'ask';
  if (approval !== 'never') return { permission, unattended: false, never };
  const sandbox = knobs?.sandbox ?? (ctx.get('shell') as { sandboxMode?: unknown } | undefined)?.sandboxMode;
  return { permission: permission ?? (SANDBOXES.includes(String(sandbox)) ? sandbox as DshPermission : undefined), unattended: true, never: true };
}
/**
 * Full access: the conversation lets its agent act without asking, and DSH would refuse unseen whatever a CLI still asks.
 * A preset with a full-access sandbox that does ask keeps its prompts.
 */
export const fullAccess = (access: { permission?: DshPermission; never: boolean }): boolean => access.never && access.permission === 'danger-full-access';
type Schema = Record<string, unknown>;
/** The narrow DSH host surface the plugin's tools use: approvals and questions in the calling conversation. */
export interface ToolHost {
  approval: { request(input: { agent: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }): Promise<string> };
  userQuestions: { ask(input: { agent: unknown; signal: AbortSignal; questions: { id: string; header?: string; question: string; options: { label: string; description?: string }[]; multiSelect: boolean }[] }): Promise<{ answers?: { id: string; selected?: string[]; custom?: string }[] }> };
}
export interface ToolCall { callId: string; agent?: unknown; signal: AbortSignal }
/** Structurally a `@deepseek-ai/dsh-tools` ToolDefinition; raw schemas stay within its enforced subset. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Schema;
  output: { schema: Schema; render(args: unknown, value: unknown): { type: 'text'; text: string }[] };
  execute(args: unknown, exec: ToolCall): Promise<unknown>;
  isConcurrencySafe?(args: unknown): boolean;
}
