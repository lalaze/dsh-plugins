import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { isGpt } from './gpt.js';
export { isGpt } from './gpt.js';

export const NAME = 'dsh-magpie-fast';
export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Protocol = 'openai-completions' | 'openai-responses';
export const defaultStateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', NAME);
export const Config = Schema.object({
  defaultEnabled: Schema.boolean().default(false).description("Enable GPT Fast for new sessions by default (priority processing, billed according to upstream pricing)").i18n({"en": "Enable GPT Fast for new sessions by default (priority processing, billed according to upstream pricing)", "zh": "新会话默认开启 GPT Fast（priority 优先处理，按上游规则计费）"}),
  stateDir: Schema.string().default(defaultStateDir()).description("Directory for saved session preferences").i18n({"en": "Directory for saved session preferences", "zh": "会话开关的保存目录"}),
});
export interface PluginConfig { defaultEnabled?: boolean; stateDir?: string }
export interface SourceProvider { id: string; profile: PiAiProviderProfile }
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Host-only read: source configuration remains owned by DSH. */
export function readSources(descriptors: readonly { value: unknown }[]): SourceProvider[] {
  return descriptors.flatMap(({ value }) => Object.entries(record(record(value)?.providers) ?? {}).flatMap(([id, raw]) => {
    const profile = record(raw);
    return typeof profile?.baseURL === 'string' ? [{ id, profile: structuredClone(profile) as PiAiProviderProfile }] : [];
  }));
}
export function supportedSource(sources: readonly SourceProvider[], provider: string, model: string): SourceProvider | undefined {
  if (!isGpt(model)) return;
  return sources.find(source => source.id === provider
    && ['openai-completions', 'openai-responses'].includes(source.profile.api ?? '')
    && source.profile.models?.some(m => m.id === model));
}
export function sourceAddress(source: SourceProvider): string {
  let url: URL;
  try { url = new URL(source.profile.baseURL!); } catch { throw new LlmError("The current provider's baseURL is invalid", 'INVALID_CONFIG'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LlmError("GPT Fast requires an HTTP/HTTPS API URL", 'INVALID_CONFIG');
  }
  return source.profile.baseURL!;
}
