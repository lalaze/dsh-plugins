import type { AutofixService } from './service.js';
import type { Tasks } from './tasks.js';
export { API_PATH } from './shared.js';
/** One JSON route for the board and the settings page. Only pages of this DSH reach it, and only with the plugin's own header. */
export declare function createHandler(service: AutofixService, tasks: Tasks, chat?: {
    lastCommand(): string | undefined;
}): (request: Request) => Promise<Response>;
