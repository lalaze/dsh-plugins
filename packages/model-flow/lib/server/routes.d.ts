/** Which model does which job, and how a word on the command line becomes a model. */
export type Role = 'plan' | 'implement' | 'review';
export interface Route {
    provider: string;
    model: string;
    effort?: string;
    label: string;
}
export interface Routes {
    plan?: Route;
    implement: Route;
    review: Route;
}
export interface CatalogModel {
    provider: string;
    providerName?: string;
    id: string;
    name: string;
}
export declare const OFF: Set<string>;
/** A remote CLI's route is `<machine>/<cli>/<model>`; the model's own name is the part both machines share. */
export declare function nativeModel(model: Pick<CatalogModel, 'provider' | 'id'>): string;
/** A remote CLI's name ends with its machine, `Opus 5.5 · mac-mini`; the two parts show separately. */
export declare function nameParts(provider: string, name: string): {
    name: string;
    machine?: string;
};
export declare function machineOf(route: {
    provider?: string;
    model?: string;
} | undefined): string | undefined;
export declare function routeFrom(value: unknown): Route | undefined;
/** The machine with the most models: where a first choice has the best chance of finding the others. */
export declare function mainMachine(catalog: readonly CatalogModel[]): string | undefined;
/**
 * Turn `codex`, `claude/haiku`, `sol@high` or `local-qwen/local-current` into a model. The same model on the
 * conversation's own machine wins, because a remote CLI only works in workspaces of its machine.
 */
export declare function resolveSpec(spec: string, catalog: readonly CatalogModel[], machine?: string): Route;
/** A saved route points at one machine: move it to the conversation's machine when that machine has the model too. */
export declare function relocate(route: Route, catalog: readonly CatalogModel[], machine?: string): Route;
/**
 * Where a conversation works, as Remote Agents tells it. `machines` are the saved machines that are the workspace's
 * computer: none when the workspace is on DSH's own computer (`local`) or on a machine that is not saved.
 */
export interface Place {
    machines: readonly string[];
    saved: readonly string[];
    name?: string;
    local: boolean;
}
/** A remote CLI runs only in workspaces of its own machine. A route that names no saved machine is not judged here. */
export declare function runsIn(route: Route, place: Place): boolean;
/** The machines to look for a model on, best first: the workspace's, with the conversation's own model's machine ahead. */
export declare function machinesFor(place: Place | undefined, own: string | undefined): (string | undefined)[];
/** `relocate` over several machines: the first that has the model. */
export declare function settle(route: Route, catalog: readonly CatalogModel[], machines: readonly (string | undefined)[]): Route;
/**
 * What to say before a flow starts when models it would use cannot run where the conversation works; undefined when
 * all of them can. Without it the step fails in a second with Remote Agents' refusal, which names neither model nor machine.
 */
export declare function misplaced(routes: Routes, place: Place, catalog: readonly CatalogModel[], zh: boolean): string | undefined;
