import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Busy, Target, Versions } from './target.js';
import type { RestartMode, RestartRecord } from './state.js';
export interface RestartOptions {
    /** `$DSH_HOME/storages/dsh-machines/restart`. */
    dir: string;
    /** The compiled helper.js. */
    helper: string;
    target: () => Target;
    busy: () => Busy;
    versions: () => Versions;
    warn: (text: string) => void;
}
/** What `GET /dsh-machines/restart` answers. */
export interface RestartStatus {
    supported: boolean;
    reason?: string;
    kind?: string;
    pid: number;
    busy: Busy;
    record?: RestartRecord;
}
export declare class RestartService {
    private readonly options;
    private readonly stateFile;
    private idleTimer;
    constructor(options: RestartOptions);
    status(): RestartStatus;
    /** Start a restart now, or once nothing runs. */
    request(mode: RestartMode): RestartRecord;
    cancel(): RestartRecord | undefined;
    /**
     * Called once this instance serves pages again: a restart that brought it up is marked back, with what changed.
     * @returns the record when this start was one.
     */
    markBack(): RestartRecord | undefined;
    dispose(): void;
    serve(req: IncomingMessage, res: ServerResponse): Promise<void>;
    private waitIdle;
    /** Hand the restart to the detached helper; DSH keeps running when the helper cannot start. */
    private launch;
}
