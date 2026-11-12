import { type CatalogModel, type Route } from './routes.js';
export interface Setup {
    plan?: Route;
    implement?: Route;
    review?: Route;
    rounds: number;
}
export interface Combo extends Setup {
    name: string;
    implement: Route;
    review: Route;
}
export declare const MAX_COMBO_NAME = 40;
export declare function roundsFrom(value: unknown): number;
export declare function combosFrom(values: readonly unknown[]): Combo[];
/** A typed name as it is kept: trimmed, and no longer than a card can show. */
export declare const comboName: (typed: string) => string;
/**
 * The list with one combo under a new name, in the same place. Undefined when nothing can be done with that name: it
 * is empty, it is the combo's own, another combo has it, or no combo is called `from`.
 */
export declare function renameCombo(combos: readonly Combo[], from: string, typed: string): Combo[] | undefined;
/** The machine does not count: a flow moves to the conversation's machine anyway. */
export declare const sameSetup: (a: Setup, b: Setup) => boolean;
/** A combo's routes in today's models: the saved machine when it still has the model, otherwise another one that does. */
export declare function placeCombo(combo: Combo, catalog: readonly CatalogModel[]): {
    setup: Setup;
    missing: string[];
};
export declare const STARTERS: readonly {
    name: string;
    plan?: string;
    implement: string;
    review: string;
    rounds?: number;
}[];
/** The first combos on offer: only those whose models this DSH has, all on one machine where it can. */
export declare function startersFor(catalog: readonly CatalogModel[], translate?: (name: string) => string): Combo[];
