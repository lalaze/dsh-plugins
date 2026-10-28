import { sshEndpoint } from './workspace-access.js';
import type { RemoteAgentsService } from './service.js';
import type { LegacyMachine } from './workspace-domain.js';
/** Explicit, read-only migration of connection references; never imports another plugin's secrets. */
export declare class WorkspaceMigration {
    private readonly service;
    private readonly home;
    private readonly endpoint;
    constructor(service: RemoteAgentsService, home?: string, endpoint?: typeof sshEndpoint);
    private records;
    list(): Promise<LegacyMachine[]>;
    import(id: string): Promise<unknown>;
}
