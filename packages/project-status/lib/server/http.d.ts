import type { ProjectStatusService } from './service.js';
/** `POST` takes a JSON `action`: `get` reads the status of a conversation's project, `change` makes one change to it. */
export declare function createHandler(service: ProjectStatusService, log?: (message: string) => void): (request: Request) => Promise<Response>;
