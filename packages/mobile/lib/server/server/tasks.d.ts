/**
 * Remote Agents' background tasks for phones: remote CLI sessions that have no DSH conversation, read and steered
 * through its `remoteAgentsTasks` service. Its records are turned into the phone's smaller shapes here.
 */
import type { TaskCommand, TaskEntry, TaskItem, TaskPage, TaskPermission } from '../shared/protocol.js';
interface Cursor {
    epoch: string;
    seq: number;
}
interface RemoteTask {
    id: string;
    title: string;
    provider: string;
    model: string;
    host: string;
    cwd: string;
    status: TaskEntry['status'];
    delegated: boolean;
    ownerSessionId?: string;
    archived: boolean;
    createdAt: string;
    updatedAt: string;
    error?: string;
    creator?: string;
    controller?: string;
}
interface RemoteEntry {
    seqStart: number;
    seqEnd: number;
    timestamp: string;
    item: Record<string, unknown> & {
        type: string;
    };
}
interface RemotePage {
    epoch: string;
    entries: RemoteEntry[];
    hasOlder: boolean;
    hasNewer: boolean;
    startCursor: Cursor | null;
    endCursor: Cursor | null;
}
interface RemotePermission {
    id: string;
    name: string;
    kind: string;
    title?: string;
    description?: string;
    input?: Record<string, unknown>;
    detail?: unknown;
    actions?: {
        id: string;
        label: string;
        behavior: 'allow' | 'deny';
    }[];
}
/** Remote Agents' `remoteAgentsTasks` service, version 1. */
export interface RemoteTasksService {
    readonly tasksVersion: number;
    list(): Promise<RemoteTask[]>;
    detail(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<{
        task: RemoteTask;
        permissions: RemotePermission[];
        timeline: RemotePage | null;
    }>;
    send(id: string, messageId: string, text: string): Promise<void>;
    stop(id: string): Promise<void>;
    respond(id: string, requestId: string, answer: {
        behavior: 'allow' | 'deny';
        selectedActionId?: string;
    }): Promise<void>;
    subscribe?(listener: () => void): () => void;
}
/** Only a version this hub understands is used; an older Remote Agents has no tasks service at all. */
export declare const usableTasks: (service: unknown) => RemoteTasksService | undefined;
export declare function taskEntry(task: RemoteTask): TaskEntry;
/** History entries as phone items: a reply's streamed pieces become one item, and a tool call shows its latest state. */
export declare function taskItems(entries: readonly RemoteEntry[]): TaskItem[];
export declare function taskPermission(permission: RemotePermission): TaskPermission;
/** One phone page: the newest entries, or those before or after a sequence number of the same history. */
export declare function taskDetail(service: RemoteTasksService, args: {
    taskId: string;
    before?: number;
    after?: number;
    epoch?: string;
}): Promise<{
    task: TaskEntry;
    permissions: TaskPermission[];
    page: TaskPage;
}>;
export declare function taskCommand(service: RemoteTasksService, command: TaskCommand): Promise<void>;
/** What the task list shows; a change in it is worth telling phones about. */
export declare const tasksFingerprint: (tasks: readonly TaskEntry[]) => string;
export {};
