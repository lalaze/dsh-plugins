export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
interface ModelDirectoryState {
  status: string; error: string | null; pending: ModelSelection | null; failures: unknown[]; current: ModelSelection;
  groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[] }[];
}
type SelectionResult = { ok: true } | { ok: false; error: { code: string; message: string } };

const listeners = new Set<() => void>();
let value: ModelDirectoryState = {
  status: 'ready', error: null, pending: null, failures: [], current: { provider: 'remote-cli-codex', model: 'codex-model', reasoningEffort: 'medium' },
  groups: [
    { id: 'remote-cli-claude', name: 'Claude', models: [{ id: 'claude-model', name: 'Claude model · macmini' }] },
    { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-model', name: 'DeepSeek model' }] },
    { id: 'remote-cli-codex', name: 'Codex', models: [
      { id: 'codex-model', name: 'Codex model · macmini', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } },
      { id: 'codex-fast', name: 'Codex Fast · macmini' },
    ] },
    { id: 'remote-cli-codebuddy', name: 'CodeBuddy Code', models: ['Auto', 'Fast', 'Balanced', 'Primary', ...Array.from({ length: 20 }, (_, i) => `CodeBuddy model ${i + 1}`)].map((name, i) => ({ id: `buddy-${i}`, name: `${name} · macmini` })) },
  ],
};
const update = (patch: Partial<ModelDirectoryState>) => { value = { ...value, ...patch }; for (const listener of listeners) listener(); };
export const modelFixture = {
  selections: [] as ModelSelection[], loads: 0, rejectNext: false,
  current: (selection: ModelSelection) => update({ current: selection }),
  snapshot: () => value,
  addModel: () => update({ groups: value.groups.map(g => g.id === 'remote-cli-codebuddy' ? { ...g, models: [...g.models, { id: 'buddy-new', name: 'New model · macmini' }] } : g) }),
};
export const modelDirectory = {
  store: { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
  async load() { modelFixture.loads++; update({ status: 'ready', error: null }); return value; },
  async select(selection: ModelSelection): Promise<SelectionResult> {
    modelFixture.selections.push(selection); update({ pending: selection, status: 'selecting' });
    await new Promise(resolve => setTimeout(resolve, 50));
    if (modelFixture.rejectNext) { modelFixture.rejectNext = false; update({ pending: null, status: 'error', error: 'Selection rejected by host' }); return { ok: false, error: { code: 'rejected', message: 'Selection rejected by host' } }; }
    update({ pending: null, current: selection, status: 'ready', error: null }); return { ok: true };
  },
};
