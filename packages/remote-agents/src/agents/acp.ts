import type { Choice, Model, Task } from '../core/domain.js';
import type { JsonlPeer } from '../core/ssh.js';
import { list } from '../core/domain.js';

type SelectOption = { id: string; category?: string; currentValue: string; options: unknown[] };
function selector(session: any, category: string, fallbackId: string): SelectOption | undefined {
  const options = list(session?.configOptions).filter(o => o?.type === 'select' && typeof o.id === 'string');
  return options.find(o => o.category === category) ?? options.find(o => !o.category && o.id === fallbackId);
}
function choices(option?: SelectOption): Choice[] {
  const values = list(option?.options).flatMap(o => Array.isArray(o?.options) ? o.options : [o]);
  return values.filter(o => typeof o?.value === 'string' && typeof o.name === 'string').map(o => ({ id: o.value, label: o.name, isDefault: o.value === option?.currentValue }));
}
/** ACP configOptions supersede the older model/mode fields; keep compatibility with both. */
export function acpCatalog(session: any): { models: Model[]; modes: Choice[]; defaultModeId?: string } {
  const model = selector(session, 'model', 'model'), mode = selector(session, 'mode', 'mode');
  const thinking = selector(session, 'thought_level', 'thinking');
  const thinkingOptions = choices(thinking);
  let models: Model[] = model ? choices(model) : list(session?.models?.availableModels).map(m => ({ id: String(m.modelId), label: String(m.name ?? m.modelId), isDefault: m.modelId === session.models.currentModelId }));
  if (!models.length) models = [{ id: 'default', label: 'CLI default', isDefault: true }];
  if (thinkingOptions.length) models = models.map(m => ({ ...m, thinkingOptions, defaultThinkingOptionId: thinking?.currentValue }));
  return {
    models,
    modes: mode ? choices(mode) : list(session?.modes?.availableModes).map(m => ({ id: String(m.id), label: String(m.name ?? m.id) })),
    defaultModeId: mode?.currentValue ?? session?.modes?.currentModeId,
  };
}
export async function configureAcpSession(peer: JsonlPeer, sessionId: string, task: Pick<Task, 'model' | 'modeId' | 'thinkingOptionId'>, initial: any): Promise<any> {
  let session = initial;
  for (const [category, fallbackId, value, legacyMethod, legacyKey] of [
    ['model', 'model', task.model === 'default' ? undefined : task.model, 'session/set_model', 'modelId'],
    ['mode', 'mode', task.modeId, 'session/set_mode', 'modeId'],
    ['thought_level', 'thinking', task.thinkingOptionId, undefined, undefined],
  ] as const) {
    if (!value) continue;
    const option = selector(session, category, fallbackId);
    if (option) {
      if (!choices(option).some(o => o.id === value)) throw new Error(`This ACP session no longer offers the selected ${category}: ${value}`);
      if (option.currentValue === value) continue;
      const result = await peer.request('session/set_config_option', { sessionId, configId: option.id, value });
      if (!Array.isArray(result?.configOptions)) throw new Error('ACP CLI did not confirm its configuration options');
      session = { ...session, configOptions: result.configOptions };
      if (selector(session, category, fallbackId)?.currentValue !== value) throw new Error(`ACP CLI did not apply the selected ${category}`);
    } else if (legacyMethod && legacyKey) {
      if (category === 'model' && session?.models?.currentModelId === value) continue;
      await peer.request(legacyMethod, { sessionId, [legacyKey]: value });
    } else throw new Error('This ACP CLI does not expose the selected thinking level');
  }
  return session;
}

/** Reasoning choices can change with the model (for example in CodeBuddy). */
export async function discoverAcpCatalog(peer: JsonlPeer, session: any): Promise<ReturnType<typeof acpCatalog>> {
  const catalog = acpCatalog(session);
  if (!selector(session, 'model', 'model') || !selector(session, 'thought_level', 'thinking')) return catalog;
  for (const model of catalog.models) {
    try {
      session = await configureAcpSession(peer, session.sessionId, { model: model.id }, session);
      const configured = acpCatalog(session).models.find(m => m.id === model.id);
      model.thinkingOptions = configured?.thinkingOptions;
      model.defaultThinkingOptionId = model.thinkingOptions?.some(o => o.id === configured?.defaultThinkingOptionId) ? configured?.defaultThinkingOptionId : undefined;
    } catch {
      // Keep the advertised model; do not invent reasoning choices when a CLI cannot select it.
      delete model.thinkingOptions; delete model.defaultThinkingOptionId;
    }
  }
  return catalog;
}
