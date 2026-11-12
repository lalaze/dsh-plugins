/** Named sets of models to switch between. Used on both sides, so it must not import anything from Node. */
import { DEFAULT_ROUNDS, MAX_ROUNDS } from './line.js';
import { mainMachine, nameParts, nativeModel, resolveSpec, routeFrom, type CatalogModel, type Role, type Route } from './routes.js';

export interface Setup { plan?: Route; implement?: Route; review?: Route; rounds: number }
export interface Combo extends Setup { name: string; implement: Route; review: Route }

export const MAX_COMBO_NAME = 40;
const ROLES: readonly Role[] = ['plan', 'implement', 'review'];

export function roundsFrom(value: unknown): number {
  const rounds = Number(value);
  return Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= MAX_ROUNDS ? rounds : DEFAULT_ROUNDS;
}
export function combosFrom(values: readonly unknown[]): Combo[] {
  const combos = new Map<string, Combo>();
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const raw = value as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? [...raw.name.trim()].slice(0, MAX_COMBO_NAME).join('') : '';
    const plan = routeFrom(raw.plan), implement = routeFrom(raw.implement), review = routeFrom(raw.review);
    if (name && implement && review && !combos.has(name)) combos.set(name, { name, ...(plan ? { plan } : {}), implement, review, rounds: roundsFrom(raw.rounds) });
  }
  return [...combos.values()];
}
/** A typed name as it is kept: trimmed, and no longer than a card can show. */
export const comboName = (typed: string): string => [...typed.trim()].slice(0, MAX_COMBO_NAME).join('');
/**
 * The list with one combo under a new name, in the same place. Undefined when nothing can be done with that name: it
 * is empty, it is the combo's own, another combo has it, or no combo is called `from`.
 */
export function renameCombo(combos: readonly Combo[], from: string, typed: string): Combo[] | undefined {
  const name = comboName(typed);
  if (!name || name === from || combos.some(combo => combo.name === name) || !combos.some(combo => combo.name === from)) return undefined;
  return combos.map(combo => combo.name === from ? { ...combo, name } : combo);
}
const nativeOf = (route: Route) => `${route.provider}/${nativeModel({ provider: route.provider, id: route.model })}`;
const sameRoute = (a?: Route, b?: Route) => a === b || (!!a && !!b && nativeOf(a) === nativeOf(b) && a.effort === b.effort);
/** The machine does not count: a flow moves to the conversation's machine anyway. */
export const sameSetup = (a: Setup, b: Setup) => a.rounds === b.rounds && ROLES.every(role => sameRoute(a[role], b[role]));

/** A combo's routes in today's models: the saved machine when it still has the model, otherwise another one that does. */
export function placeCombo(combo: Combo, catalog: readonly CatalogModel[]): { setup: Setup; missing: string[] } {
  const setup: Setup = { rounds: combo.rounds }, missing: string[] = [];
  for (const role of ROLES) {
    const route = combo[role];
    if (!route) continue;
    const found = catalog.find(model => model.provider === route.provider && model.id === route.model)
      ?? catalog.find(model => nativeOf({ provider: model.provider, model: model.id, label: model.name }) === nativeOf(route));
    if (found) setup[role] = { provider: found.provider, model: found.id, label: found.name, ...(route.effort ? { effort: route.effort } : {}) };
    else missing.push(nameParts(route.provider, route.label).name);
  }
  return { setup, missing: [...new Set(missing)] };
}
export const STARTERS: readonly { name: string; plan?: string; implement: string; review: string; rounds?: number }[] = [
  { name: 'Codex builds, Claude reviews', plan: 'claude/opus', implement: 'codex', review: 'claude/opus' },
  { name: 'Claude builds, Codex reviews', plan: 'claude/opus', implement: 'claude/sonnet', review: 'codex' },
  { name: 'Claude only', plan: 'claude/opus', implement: 'claude/sonnet', review: 'claude/opus' },
  { name: 'Quick, no plan', implement: 'codex', review: 'claude/sonnet', rounds: 2 },
];
/** The first combos on offer: only those whose models this DSH has, all on one machine where it can. */
export function startersFor(catalog: readonly CatalogModel[], translate: (name: string) => string = name => name): Combo[] {
  const machine = mainMachine(catalog), resolve = (spec: string) => resolveSpec(spec, catalog, machine);
  return STARTERS.flatMap(starter => {
    try {
      const plan = starter.plan ? resolve(starter.plan) : undefined;
      return [{ name: translate(starter.name), ...(plan ? { plan } : {}), implement: resolve(starter.implement), review: resolve(starter.review), rounds: starter.rounds ?? DEFAULT_ROUNDS }];
    } catch { return []; }
  });
}
