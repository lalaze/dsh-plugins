import { Config, apply, inject } from 'dsh-claude-ssh';
import type { Context } from '@deepseek-ai/cordis';

export const ClaudeConfig = Config;
export const claudeInject = inject;
/** The packaged build rewrites this module's import to the embedded engine. */
export function installNativeClaude(ctx: Context, config?: Record<string, unknown>): void {
  // DSH supplies these services through claudeInject; the original adapter keeps its narrow mirror.
  apply(ctx as unknown as Parameters<typeof apply>[0], Config(config ?? {}));
}
