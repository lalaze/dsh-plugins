import { type ChatProject } from './domain.js';
import type { RemoteAgentsService } from './service.js';
/** Saved, explicitly discovered catalogs let the native model picker work without opening SSH. */
export declare class ChatProjects {
    readonly service: RemoteAgentsService;
    private listeners;
    constructor(service: RemoteAgentsService);
    list(): ChatProject[];
    /** The picker advertises one catalog per host; old project routes remain resolvable for saved chats. */
    hosts(): ChatProject[];
    routes(): ChatProject[];
    onChange(listener: () => void): () => void;
    private changed;
    add(input: unknown): Promise<ChatProject[]>;
    refresh(id: string): Promise<ChatProject[]>;
    remove(id: string): Promise<ChatProject[]>;
}
