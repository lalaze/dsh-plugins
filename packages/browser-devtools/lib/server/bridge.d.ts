import { type PageState, type SessionKey } from './protocol.js';
import { type LaunchWindow } from './launcher.js';
/** DSH's authenticated Connection transports owner traffic. The browser gets a separate, local capability. */
export declare class DebuggerBridge {
    private readonly launch;
    private readonly now;
    private readonly asset;
    private sessions;
    private server?;
    private starting?;
    private origin;
    private disposed;
    private cleanupJobs;
    private sweep;
    constructor(launch?: LaunchWindow, now?: () => number, asset?: () => Promise<string>);
    private listen;
    create(page: PageState): Promise<SessionKey>;
    private session;
    ownerRequest(input: Record<string, unknown>): Promise<unknown>;
    windowRequest(input: Record<string, unknown>, authorization: string): Promise<unknown>;
    closeSession(id: string): void;
    expire(): void;
    dispose(): Promise<void>;
}
export declare function createHandler(bridge: DebuggerBridge): (request: Request) => Promise<Response>;
