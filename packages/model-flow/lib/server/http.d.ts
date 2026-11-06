/** Settings data: the models to choose from, their thinking levels, and saving the choice. */
import type { CatalogModel } from './routes.js';
import { API_PATH, type EffortOption, type LiveStep, type Locale } from './shared.js';
import { type FlowStore } from './store.js';
export { API_PATH };
export interface SettingsHost {
    catalog(): Promise<CatalogModel[]>;
    efforts(provider: string, model: string): Promise<EffortOption[]>;
    /** The conversation of a /flow typed within the last `maxAge` milliseconds. */
    lastCommand(maxAge: number): string | undefined;
    setLocale(locale: Locale): void;
    /** The step a row shows while it runs. None means it is not running in this DSH, for example after a restart. */
    step(commandId: string): LiveStep | undefined;
    /** Stop the flow a running row belongs to. False when that row is not running in this DSH. */
    stop(commandId: string): boolean;
}
export declare function createHandler(store: FlowStore, host: SettingsHost): (request: Request) => Promise<Response>;
