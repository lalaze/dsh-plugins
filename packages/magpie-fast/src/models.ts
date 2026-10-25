import type { Model, ModelThinkingLevel } from '@earendil-works/pi-ai';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { PiAiModelProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { isGpt, LEVELS, sourceAddress, type Protocol, type SourceProvider } from './config.js';

function modelReasoning(efforts: PiAiModelProfile['reasoningEfforts']): Pick<Model<Protocol>, 'reasoning' | 'thinkingLevelMap'> {
  if (!efforts || !Object.keys(efforts).length) return { reasoning: false };
  const map: Partial<Record<ModelThinkingLevel, string | null>> = Object.fromEntries(LEVELS.map(level => [level, null]));
  for (const [key, value] of Object.entries(efforts)) {
    if (!LEVELS.includes(key as ModelThinkingLevel)) throw new LlmError(`Unsupported reasoning level ${key}`, 'INVALID_CONFIG');
    if (key !== 'off' && (typeof value !== 'string' || !value)) throw new LlmError(`Reasoning level ${key} is missing its API parameter value`, 'INVALID_CONFIG');
    if (value === null) delete map[key as ModelThinkingLevel];
    else map[key as ModelThinkingLevel] = value;
  }
  return { reasoning: Object.keys(efforts).some(k => k !== 'off'), thinkingLevelMap: map };
}
/** Retain the original provider/model identity, metadata and protocol switches. */
export function materializeModels(source: SourceProvider): { models: Model<Protocol>[]; caps: ReadonlyMap<string, number> } {
  const profile = source.profile; const baseUrl = sourceAddress(source); const caps = new Map<string, number>();
  const models = (profile.models ?? []).filter(m => isGpt(m.id)).map(m => {
    if (m.maxTokens !== undefined) caps.set(m.id, m.maxTokens);
    const contextWindow = m.contextWindow ?? profile.defaultContextWindow ?? 262144;
    const maxTokens = m.maxTokens ?? profile.defaultMaxTokens ?? 32768;
    if (![contextWindow, maxTokens].every(n => Number.isSafeInteger(n) && n > 0)) throw new LlmError(`Invalid token capacity for model ${m.id}`, 'INVALID_CONFIG');
    return {
      id: m.id, name: m.name ?? m.id, api: profile.api as Protocol, provider: source.id, baseUrl,
      input: m.input?.length ? m.input : profile.defaultInput ?? ['text'], contextWindow, maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...modelReasoning(m.reasoningEfforts), compat: { ...profile.compat, ...m.compat },
    } satisfies Model<Protocol>;
  });
  return { models, caps };
}
