import { decodePictures } from './pictures.js';
import type { AutofixService } from './service.js';
import type { Tasks } from './tasks.js';
export { API_PATH } from './shared.js';
/** One JSON route for the board and the settings page. Only pages of this DSH reach it, and only with the plugin's own header. */
/** Tasks another DSH runs, reached through a workspace of this one. */
export interface Remote {
    task(at: string, key: string): Promise<{
        task: unknown;
        route: unknown;
    } | undefined>;
    diff(at: string, key: string): Promise<unknown>;
    act(at: string, ask: {
        kind: 'sendBack';
        key: string;
        feedback: string;
    } | {
        kind: 'accept' | 'stop' | 'retryReport';
        key: string;
    }, pictures?: ReturnType<typeof decodePictures>): Promise<void>;
}
export declare function createHandler(service: AutofixService, tasks: Tasks, chat?: {
    lastCommand(): string | undefined;
}, remote?: Remote): (request: Request) => Promise<Response>;
