import type { Backend } from './backend.js';
import type { HostConnections } from './host-connections.js';
import type { Store } from '../core/store.js';
import { type SharedTag, type SharedWorkspace } from '../core/domain.js';
/** Sharing needs local backend access, never the verified remote-operation path or the catalog queue. */
type SharedHosts = Pick<HostConnections, 'host' | 'backend' | 'peek' | 'stopped'>;
interface Notifications {
    workspaces(hostId: string): void;
    history(taskId: string): void;
    read(sessionId: string): void;
}
/** Coordinates shared notifications, read positions and workspace discovery for this DSH. */
export declare class SharedSync {
    private readonly store;
    private readonly hosts;
    private readonly notify;
    constructor(store: Store, hosts: SharedHosts, notify: Notifications);
    /** Subscribe as soon as a backend exists; local history reads need notifications before connect. */
    bind(hostId: string, backend: Backend): void;
    /**
     * What marks a conversation as read as far as its shared histories go, by whichever DSH or phone. It changes with each
     * new read, so a reader can tell a read from one made before a turn it knows of. Nothing while a turn is still unread,
     * or for a conversation with no shared CLI.
     */
    chatReadMark(sessionId: string): string | undefined;
    /** The user read a conversation: tell every DSH and phone sharing its CLIs. */
    markChatRead(sessionId: string): Promise<void>;
    /** Remote workspaces other DSH instances added on this host that were not offered to this DSH yet. */
    sharedWorkspaces(hostId: string): Promise<SharedWorkspace[]>;
    /** Offered to DSH: not offered again, even when removed from the sidebar. */
    seeWorkspaces(hostId: string, paths: string[]): Promise<void>;
    /** Every workspace shared on this host, with its tags; undefined while its registry cannot be reached. */
    sharedWorkspaceList(hostId: string, timeout?: number): Promise<SharedWorkspace[] | undefined>;
    /** Share a workspace's tags with the other DSH instances on this host. */
    setWorkspaceTags(hostId: string, path: string, tags: SharedTag[]): Promise<SharedWorkspace>;
    /** Record a remote workspace on its host so other DSH instances offer it too. */
    shareWorkspace(hostId: string, path: string): Promise<void>;
    /** Who sent a message a shared history records with its sender: this DSH, or another one by name. */
    sender(hostId: string, instance: string, label: string): {
        self: true;
    } | {
        name: string;
    };
}
export {};
