import type { Choice, Model, Task } from './domain.js';
import type { JsonlPeer } from './ssh.js';
/** ACP configOptions supersede the older model/mode fields; keep compatibility with both. */
export declare function acpCatalog(session: any): {
    models: Model[];
    modes: Choice[];
    defaultModeId?: string;
};
export declare function configureAcpSession(peer: JsonlPeer, sessionId: string, task: Pick<Task, 'model' | 'modeId' | 'thinkingOptionId'>, initial: any): Promise<any>;
/** Reasoning choices can change with the model (for example in CodeBuddy). */
export declare function discoverAcpCatalog(peer: JsonlPeer, session: any): Promise<ReturnType<typeof acpCatalog>>;
