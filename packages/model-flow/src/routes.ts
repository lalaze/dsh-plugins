/** Which model does which job, and how a word on the command line becomes a model. */
export type Role = 'plan' | 'implement' | 'review';
export interface Route { provider: string; model: string; effort?: string; label: string }
export interface Routes { plan?: Route; implement: Route; review: Route }
export interface CatalogModel { provider: string; providerName?: string; id: string; name: string }

export const OFF = new Set(['off', 'none', 'skip']);
const REMOTE_PREFIX = 'remote-cli-';
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const decode = (part: string) => { try { return decodeURIComponent(part); } catch { return part; } };

/** A remote CLI's route is `<machine>/<cli>/<model>`; the model's own name is the part both machines share. */
export function nativeModel(model: Pick<CatalogModel, 'provider' | 'id'>): string {
  if (!model.provider.startsWith(REMOTE_PREFIX)) return model.id;
  const parts = model.id.split('/');
  return parts.length >= 3 ? decode(parts[2]) : model.id;
}
/** A remote CLI's name ends with its machine, `Opus 5.5 · mac-mini`; the two parts show separately. */
export function nameParts(provider: string, name: string): { name: string; machine?: string } {
  const at = provider.startsWith(REMOTE_PREFIX) ? name.lastIndexOf(' · ') : -1;
  return at > 0 ? { name: name.slice(0, at), machine: name.slice(at + 3) } : { name };
}
export function machineOf(route: { provider?: string; model?: string } | undefined): string | undefined {
  if (!route?.provider?.startsWith(REMOTE_PREFIX) || !route.model) return undefined;
  const parts = route.model.split('/');
  return parts.length >= 3 ? parts[0] : undefined;
}
export function routeFrom(value: unknown): Route | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { provider, model, effort, label } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) return undefined;
  return { provider, model, label: typeof label === 'string' && label ? label : model, ...(typeof effort === 'string' && effort ? { effort } : {}) };
}
/** The machine with the most models: where a first choice has the best chance of finding the others. */
export function mainMachine(catalog: readonly CatalogModel[]): string | undefined {
  const counts = new Map<string, number>();
  for (const model of catalog) {
    const machine = machineOf({ provider: model.provider, model: model.id });
    if (machine) counts.set(machine, (counts.get(machine) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}
const onMachine = (model: CatalogModel, machine: string | undefined) => machine !== undefined && machineOf({ provider: model.provider, model: model.id }) === machine;
const providerMatches = (model: CatalogModel, word: string) => same(model.provider, word) || same(model.provider, `${REMOTE_PREFIX}${word}`) || same(model.providerName ?? '', word);
const modelNamed = (model: CatalogModel, word: string) => same(nativeModel(model), word) || same(model.name, word);
const modelContains = (model: CatalogModel, word: string) => [nativeModel(model), model.name].some(text => text.toLowerCase().includes(word.trim().toLowerCase()));
const describe = (models: readonly CatalogModel[]) => models.slice(0, 8).map(model => model.name).join(', ');
const toRoute = (model: CatalogModel, effort?: string): Route => ({ provider: model.provider, model: model.id, label: model.name, ...(effort ? { effort } : {}) });

/**
 * Turn `codex`, `claude/haiku`, `sol@high` or `local-qwen/local-current` into a model. The same model on the
 * conversation's own machine wins, because a remote CLI only works in workspaces of its machine.
 */
export function resolveSpec(spec: string, catalog: readonly CatalogModel[], machine?: string): Route {
  const at = spec.lastIndexOf('@');
  const body = (at > 0 ? spec.slice(0, at) : spec).trim(), effort = at > 0 ? spec.slice(at + 1).trim() : undefined;
  const slash = body.indexOf('/');
  const left = slash > 0 ? body.slice(0, slash) : body, right = slash > 0 ? body.slice(slash + 1) : undefined;
  const fromProvider = catalog.filter(model => providerMatches(model, left));
  let found: readonly CatalogModel[];
  if (right !== undefined) {
    const exact = fromProvider.filter(model => modelNamed(model, right));
    found = exact.length ? exact : fromProvider.filter(model => modelContains(model, right));
  } else if (fromProvider.length) {
    // A bare provider means its first model, on this machine when it has one there.
    found = [fromProvider.find(model => onMachine(model, machine)) ?? fromProvider[0]];
  } else {
    const exact = catalog.filter(model => modelNamed(model, body));
    found = exact.length ? exact : catalog.filter(model => modelContains(model, body));
  }
  if (!found.length) throw new Error(`No model matches "${body}". Available: ${describe(catalog) || 'none'}`);
  const here = found.filter(model => onMachine(model, machine)), pool = here.length ? here : found;
  // The same model on several machines is one choice; different models are not.
  if (new Set(pool.map(model => `${model.provider}/${nativeModel(model)}`)).size > 1) throw new Error(`"${body}" matches several models: ${describe(pool)}`);
  return toRoute(pool[0], effort);
}

/** A saved route points at one machine: move it to the conversation's machine when that machine has the model too. */
export function relocate(route: Route, catalog: readonly CatalogModel[], machine?: string): Route {
  if (!machine || !route.provider.startsWith(REMOTE_PREFIX) || machineOf(route) === machine) return route;
  const wanted = nativeModel({ provider: route.provider, id: route.model });
  const moved = catalog.find(model => model.provider === route.provider && nativeModel(model) === wanted && onMachine(model, machine));
  return moved ? { ...route, model: moved.id, label: moved.name } : route;
}

/**
 * Where a conversation works, as Remote Agents tells it. `machines` are the saved machines that are the workspace's
 * computer: none when the workspace is on DSH's own computer (`local`) or on a machine that is not saved.
 */
export interface Place { machines: readonly string[]; saved: readonly string[]; name?: string; local: boolean }

/** A remote CLI runs only in workspaces of its own machine. A route that names no saved machine is not judged here. */
export function runsIn(route: Route, place: Place): boolean {
  const machine = machineOf(route);
  return !machine || !place.saved.includes(machine) || place.machines.includes(machine);
}
/** The machines to look for a model on, best first: the workspace's, with the conversation's own model's machine ahead. */
export function machinesFor(place: Place | undefined, own: string | undefined): (string | undefined)[] {
  if (!place) return [own];
  return own && place.machines.includes(own) ? [own, ...place.machines.filter(id => id !== own)] : [...place.machines];
}
/** `relocate` over several machines: the first that has the model. */
export function settle(route: Route, catalog: readonly CatalogModel[], machines: readonly (string | undefined)[]): Route {
  for (const machine of machines) {
    const moved = relocate(route, catalog, machine);
    if (machine && machineOf(moved) === machine) return moved;
  }
  return route;
}
const ROLE_NAMES = { en: { plan: 'plan', implement: 'implement', review: 'review' }, zh: { plan: '计划', implement: '实现', review: '审核' } } as const;
/**
 * What to say before a flow starts when models it would use cannot run where the conversation works; undefined when
 * all of them can. Without it the step fails in a second with Remote Agents' refusal, which names neither model nor machine.
 */
export function misplaced(routes: Routes, place: Place, catalog: readonly CatalogModel[], zh: boolean): string | undefined {
  const lost = (['plan', 'implement', 'review'] as const).flatMap(role => routes[role] && !runsIn(routes[role]!, place) ? [{ role, ...nameParts(routes[role]!.provider, routes[role]!.label) }] : []);
  if (!lost.length) return undefined;
  const all = [...new Set(catalog.filter(model => place.machines.some(machine => onMachine(model, machine))).map(model => nameParts(model.provider, model.name).name))];
  const has = all.slice(0, 5), more = all.length > has.length;
  const { name } = place;
  if (zh) {
    const list = lost.map(item => `${ROLE_NAMES.zh[item.role]}模型 ${item.name}${item.machine ? `（${item.machine}）` : ''}`).join('、');
    const start = `${list}${list.endsWith('）') ? '' : ' '}不能在这个工作区里运行：`, rule = '远程 CLI 模型只在自己那台机器的工作区里运行。';
    if (name) return `${start}工作区在 ${name} 上，而 ${name} 上没有${lost.length > 1 ? '这些模型' : '这个模型'}。${rule}${has.length ? `${name} 上有：${has.join('、')}${more ? ' 等' : ''}。请在「设置 → 模型分工」里换一个。` : `${name} 上还没有可用的远程 CLI 模型，请在「设置 → 模型分工」里换成不带机器名的模型。`}`;
    return `${start}工作区在${place.local ? '运行 DSH 的这台电脑上' : '一台没有保存在 Remote agents 里的机器上'}。${rule}请在「设置 → 模型分工」里换成不带机器名的模型，或者到那台机器的工作区里再开始。`;
  }
  const list = lost.map(item => `the ${ROLE_NAMES.en[item.role]} model ${item.name}${item.machine ? ` (${item.machine})` : ''}`).join(', ');
  const rule = 'A remote CLI model only runs in workspaces on its own machine.';
  const sentence = `${list[0].toUpperCase()}${list.slice(1)} cannot run in this workspace`;
  if (name) return `${sentence}: the workspace is on ${name}, and ${name} does not have ${lost.length > 1 ? 'these models' : 'this model'}. ${rule} ${has.length ? `${name} has: ${has.join(', ')}${more ? ' and others' : ''}. Choose another in Settings → Model flow.` : `${name} has no remote CLI model ready. Choose a model without a machine in Settings → Model flow.`}`;
  return `${sentence}: the workspace is on ${place.local ? 'the computer DSH runs on' : 'a machine that is not saved in Remote agents'}. ${rule} Choose models without a machine in Settings → Model flow, or start from a workspace on that machine.`;
}
