/** Settings data: the models to choose from, their thinking levels, and saving the choice. */
import type { CatalogModel } from './routes.js';
import { API_PATH, type EffortOption, type LiveCard, type Locale } from './shared.js';
import { type FlowStore } from './store.js';
export { API_PATH };
export interface SettingsHost {
    catalog(): Promise<CatalogModel[]>;
    efforts(provider: string, model: string): Promise<EffortOption[]>;
    /** The conversation of a /flow typed within the last `maxAge` milliseconds. */
    lastCommand(maxAge: number): string | undefined;
    setLocale(locale: Locale): void;
    /**
     * What a running row is: a flow's card (live, or what is left of it after DSH stopped), or the /flow line that started
     * one, which draws nothing. Neither means this DSH knows nothing about it.
     */
    card(commandId: string): {
        card?: LiveCard;
        start?: true;
    };
    /** A finished step's result in a running card, fetched when it is opened. */
    stepBody(commandId: string, index: number): string | undefined;
    /** Stop the flow a running card belongs to. False when that card is not running in this DSH. */
    stop(commandId: string): boolean;
    /** Whether a card's flow can go on from where it stopped, or already has in a later card. */
    resumable(commandId: string): {
        resumable: boolean;
        continued?: true;
    };
    /** Go on with that flow in its conversation, in a new card. */
    resume(commandId: string): Promise<{
        ok: true;
    } | {
        error: string;
    }>;
}
export declare function createHandler(store: FlowStore, host: SettingsHost): (request: Request) => Promise<Response>;
