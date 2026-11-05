/** Settings data: the models to choose from, their thinking levels, and saving the choice. */
import type { CatalogModel } from './routes.js';
import { API_PATH, type EffortOption, type Locale } from './shared.js';
import { type FlowStore } from './store.js';
export { API_PATH };
export interface SettingsHost {
    catalog(): Promise<CatalogModel[]>;
    efforts(provider: string, model: string): Promise<EffortOption[]>;
    /** The conversation of a /flow typed within the last `maxAge` milliseconds. */
    lastCommand(maxAge: number): string | undefined;
    setLocale(locale: Locale): void;
}
export declare function createHandler(store: FlowStore, host: SettingsHost): (request: Request) => Promise<Response>;
