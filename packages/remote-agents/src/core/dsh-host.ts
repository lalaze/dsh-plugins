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
