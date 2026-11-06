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
