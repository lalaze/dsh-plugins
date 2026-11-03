import type { AgentSummary, Cursor, Permission, PermissionAnswer, TimelinePage } from '../core/domain.js';
import type { RemoteAgentsService } from './service.js';
/** A remote CLI session with no conversation in this DSH, and the machine it runs on. */
export interface RemoteTask extends AgentSummary {
    host: string;
}
export interface RemoteTaskDetail {
    task: RemoteTask;
    permissions: Permission[];
    timeline: TimelinePage | null;
}
/**
 * Remote CLI sessions that have no conversation in this DSH, for other plugins on this host such as dsh-mobile, as the
 * service `remoteAgentsTasks`: tasks DSH's agent delegated and sessions started from Open sessions. Conversations bound
 * to a main chat are left out; they are DSH sessions of their own.
 */
export interface RemoteAgentsTasks {
    /** Version 1: list, read, send, stop and answer approvals. */
    readonly tasksVersion: 1;
    list(): Promise<RemoteTask[]>;
    /** One page of the task's history, newest first by default, with its status and the approvals it waits for. */
    detail(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<RemoteTaskDetail>;
    /** `messageId` makes a retried send arrive once. A working task is interrupted first, as in Paseo. */
    send(id: string, messageId: string, text: string): Promise<void>;
    stop(id: string): Promise<void>;
    respond(id: string, requestId: string, answer: PermissionAnswer): Promise<void>;
    /** Called after a task is added, changed or removed. Progress within a turn is read with `detail`. */
    subscribe(listener: () => void): () => void;
}
export declare function remoteTasks(service: RemoteAgentsService): RemoteAgentsTasks;
