/** The model menu's rows. The same model on several machines is one row, because a flow moves to the conversation's machine anyway. */
import { machineOf, nameParts, nativeModel, type CatalogModel, type Route } from '../routes.js';

export interface ModelRow { label: string; keywords: string; models: CatalogModel[] }
export interface ModelGroup { id: string; name: string; rows: ModelRow[] }

export const modelKey = (model: Pick<CatalogModel, 'provider' | 'id'>) => JSON.stringify([model.provider, model.id]);
export const routeKey = (route: Route) => modelKey({ provider: route.provider, id: route.model });
export const machineName = (model: CatalogModel) => nameParts(model.provider, model.name).machine ?? model.name;

export function modelGroups(models: readonly CatalogModel[]): ModelGroup[] {
  const groups = new Map<string, { name: string; rows: Map<string, ModelRow> }>();
  for (const model of models) {
    const group = groups.get(model.provider) ?? { name: model.providerName ?? model.provider, rows: new Map<string, ModelRow>() };
    groups.set(model.provider, group);
    const native = nativeModel(model), parts = nameParts(model.provider, model.name), row = group.rows.get(native);
    if (row) { row.models.push(model); row.keywords += ` ${parts.machine ?? ''}`; }
    else group.rows.set(native, { label: parts.name, keywords: `${native} ${parts.machine ?? ''}`, models: [model] });
  }
  return [...groups].map(([id, group]) => ({ id, name: group.name, rows: [...group.rows.values()] }));
}
/** Which machine a click on a row means: the first of `machines` the row has, by the order given. */
export function preferredModel(row: ModelRow, machines: readonly (string | undefined)[]): CatalogModel {
  for (const machine of machines) {
    const found = machine && row.models.find(model => machineOf({ provider: model.provider, model: model.id }) === machine);
    if (found) return found;
  }
  return row.models[0];
}
